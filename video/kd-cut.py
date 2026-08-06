#!/usr/bin/env python3
"""
kd-cut — block-boundary video cutter for the KombatDesk demo video.

WHAT THIS DELIBERATELY DOES NOT DO
----------------------------------
It does not detect and remove silence. Every "AI video editor" workflow starts
with a silence trimmer, and for a talking-head content video that's correct —
dead air is a defect there. It is wrong here. The KombatDesk script has three
silences written into it on purpose:

  - the 3-second beat while the viewer reads the At Risk list (block 3)
  - the beat before the send, after "the number this goes to is mine" (block 5)
  - the pause after the phone buzzes (block 5) -- the most persuasive moment
    in the whole video

A silence detector removes exactly those. So this tool only ever cuts on
boundaries you name. Nothing inside a block is touched.

USAGE
-----
    python kd-cut.py --master master.mp4 --blocks blocks.json --out ./out

blocks.json defines where each scripted block lives in the master, and which
derived cut uses it. Timestamps are "M:SS", "M:SS.mmm", or plain seconds.

    {
      "blocks": [
        {"id": 1, "name": "The problem",   "start": "0:00",  "end": "0:47"},
        {"id": 2, "name": "The one idea",  "start": "0:47",  "end": "1:07"}
      ],
      "cuts": {
        "landing": [1, 2, {"id": 5, "start": "3:10", "end": "3:48"}],
        "social":  [{"id": 1, "end": "0:08"}, 3]
      }
    }

An entry that is a bare integer uses the whole block. An object overrides
start and/or end for that cut only -- which is how the 30-second social cut
takes the first 8 seconds of block 1 without you having to define a second
block for it.

WHY RE-ENCODE RATHER THAN STREAM-COPY
-------------------------------------
`-c copy` can only cut on keyframes, so it silently slides your in-point by up
to a couple of seconds. On a 30-second social cut that is the difference
between opening on "Nobody quits your gym" and opening mid-word. Every segment
is re-encoded at the master's own resolution and framerate. Slower, exact.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

TIME_RE = re.compile(r"^(?:(\d+):)?(\d+(?:\.\d+)?)$")


def parse_time(value):
    """'1:23.5' -> 83.5, '0:47' -> 47.0, 12 -> 12.0. Raises on anything else."""
    if isinstance(value, (int, float)):
        return float(value)
    m = TIME_RE.match(str(value).strip())
    if not m:
        raise ValueError(
            f"bad timestamp {value!r} -- use 'M:SS', 'M:SS.mmm', or seconds"
        )
    minutes, seconds = m.group(1), m.group(2)
    total = float(seconds) + (int(minutes) * 60 if minutes else 0)
    # A bare "90" means 90 seconds, but "1:90" is a typo, not 2:30. Catch it
    # rather than silently producing a cut nobody asked for.
    if minutes and float(seconds) >= 60:
        raise ValueError(f"bad timestamp {value!r} -- seconds must be < 60")
    return total


def run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"\n{' '.join(cmd[:3])}... failed:\n{proc.stderr.strip()[-2000:]}")
    return proc.stdout.strip()


def probe_duration(path):
    return float(
        run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path])
    )


def probe_video(path):
    """(width, height, fps) of the first video stream."""
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,r_frame_rate",
               "-of", "csv=p=0:s=,", path])
    width, height, rate = out.split(",")[:3]
    num, _, den = rate.partition("/")
    fps = float(num) / float(den or 1)
    return int(width), int(height), round(fps, 3)


def has_zscale():
    """Tone mapping needs the zscale filter (libzimg). Present in most builds,
    but NOT all -- and a missing filter fails at encode time with an opaque
    ffmpeg error partway through a cut. Checked once, up front, so the fallback
    is a warning rather than a crash."""
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                         capture_output=True, text=True).stdout
    return any(line.split()[1:2] == ["zscale"] for line in out.splitlines() if line.split())


def is_hdr(path):
    """True if the source carries an HDR transfer function (PQ or HLG).

    iPhones record Dolby Vision HDR by default on recent models. Squashing that
    to yuv420p without tone mapping does not error -- it produces a visibly
    washed-out, grey, low-contrast picture, which is the kind of failure you
    only notice when the finished cut is next to the original. Detected from the
    stream's transfer characteristics rather than assumed from the file
    extension, because a .MOV off an iPhone may be either.
    """
    trc = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=color_transfer", "-of", "csv=p=0", path]).strip()
    return trc in ("smpte2084", "arib-std-b67")


def has_audio(path):
    """A muted clip exported without an audio track breaks concat -- every part
    must carry the same stream layout. Detected rather than assumed, because
    'I muted it' and 'it has no audio stream' are different things and only the
    second one matters here."""
    out = run(["ffprobe", "-v", "error", "-select_streams", "a",
               "-show_entries", "stream=index", "-of", "csv=p=0", path])
    return bool(out.strip())


def resolve_segments(entries, blocks, master, master_duration, durations):
    """Turn a cut's entry list into concrete (source, start, end, label) segments.

    A block may name its own `source` file instead of the master -- that's how
    an external clip (sparring footage, a phone shot) gets spliced in without
    having to live inside the master recording. Its duration is probed and
    range-checked the same way the master's is, and it gets scaled to the
    master's frame size at encode time, so a portrait phone clip and a
    landscape screen recording can sit in the same timeline.
    """
    segments = []
    for entry in entries:
        if isinstance(entry, dict):
            block_id, overrides = entry["id"], entry
        else:
            block_id, overrides = entry, {}
        if block_id not in blocks:
            sys.exit(f"cut references block {block_id}, which isn't defined")
        block = blocks[block_id]
        source = overrides.get("source") or block.get("source") or master
        if not os.path.exists(source):
            sys.exit(f"block {block_id}: source not found: {source}")
        if source not in durations:
            durations[source] = probe_duration(source)
        source_duration = durations[source]

        try:
            start = parse_time(overrides["start"]) if "start" in overrides else block["start"]
            end = parse_time(overrides["end"]) if "end" in overrides else block["end"]
        except ValueError as e:
            sys.exit(f"block {block_id} override: {e}")

        # Every one of these is a mistake that produces a *plausible-looking*
        # output file rather than an error, which is the worst kind. An
        # inverted range yields an empty segment; an end past the source
        # yields a truncated one. Both would be found in the edit, not here.
        if end <= start:
            sys.exit(f"block {block_id}: end ({end}s) is not after start ({start}s)")
        if end > source_duration + 0.05:
            sys.exit(
                f"block {block_id}: end {end}s is past {os.path.basename(source)}'s "
                f"{source_duration:.2f}s -- wrong file, or the block map is stale"
            )
        # Force silence on this segment regardless of what its audio track
        # holds. The reason is copyright, not taste: gym footage almost always
        # has music playing in the background, and that is a takedown or a
        # muted-audio strike on YouTube and Instagram -- on the whole video,
        # not just the two seconds it appears in.
        mute = bool(overrides.get("mute", block.get("mute", False)))

        label = f"{block_id} {block['name']}"
        if source != master:
            label += f"  <- {os.path.basename(source)}"
        segments.append((source, start, end, label, mute))
    return segments


def build_cut(segments, out_path, tmpdir, width, height, fps, tonemap_ok):
    """Re-encode each segment, then concat. Returns total duration written."""
    parts = []
    for i, (source, start, end, label, mute) in enumerate(segments):
        part = os.path.join(tmpdir, f"part{i:02d}.mp4")
        # Both cases take the same code path -- generate a silent track and map
        # it instead of the source's. "This clip has no audio" and "I do not
        # want this clip's audio" want identical output.
        if mute:
            silent = "  (muted)"
        elif not has_audio(source):
            silent = "  (no audio -- padding silence)"
        else:
            silent = ""
        hdr = is_hdr(source)
        if hdr and not tonemap_ok:
            note = "  (HDR, but this ffmpeg has no zscale -- NOT tone mapped)"
        elif hdr:
            note = "  (HDR -- tone mapping to SDR)"
        else:
            note = ""
        print(f"    [{start:7.2f} -> {end:7.2f}]  block {label}{silent}{note}")
        hdr = hdr and tonemap_ok

        geometry = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1,fps={fps}"
        )
        if hdr:
            # Convert to linear light, tone map with Hable (holds highlights
            # without crushing midtones -- a gym's ceiling lights blow out badly
            # under `clip`), then convert back to BT.709 SDR. Without this chain
            # the picture survives but looks grey and flat.
            vf = (
                "zscale=t=linear:npl=100,format=gbrpf32le,"
                "zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
                "zscale=t=bt709:m=bt709:r=tv,format=yuv420p," + geometry
            )
        else:
            vf = geometry
        # A source with no audio stream gets a generated silent one, so every
        # part has identical stream layout and concat doesn't drop the audio
        # from the whole cut when one clip lacks it.
        audio_in = [] if not silent else [
            "-f", "lavfi", "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
        ]
        # ARGUMENT ORDER IS LOAD-BEARING. -ss/-to must come after EVERY -i.
        # Placed between two inputs they are parsed as *input* options for the
        # one that follows, which silently stopped trimming the video and
        # produced a segment 5x longer than asked for -- with no error, and a
        # total duration that only looked wrong if you checked the arithmetic.
        run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", source,
            *audio_in,
            # After all inputs, so these are output options: decode-and-discard,
            # frame-accurate. (-ss before -i is faster but keyframe-snapped.)
            "-ss", f"{start}", "-to", f"{end}",
            *(["-map", "0:v:0", "-map", "1:a:0", "-shortest"] if silent else []),
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
            # Loudness-normalise every segment to the same target. This is the
            # one piece of "AI editing" automation that genuinely earns its
            # place here, because this video mixes two capture sources -- phone
            # audio through a lav mic, and screen-recorded desktop audio -- and
            # they will not match. Measured on the real block 1 footage: the
            # two segments of a SINGLE block differed by 3 LU from each other,
            # which is an audible jump mid-sentence, and both sat ~12 LU under
            # target. Single-pass loudnorm: less precise than two-pass, but it
            # cannot overshoot into clipping and it needs no measure step.
            # -14 LUFS is the level YouTube and Instagram normalise toward, so
            # matching it here means neither platform re-gains the audio.
            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
            # Every part is normalised to the master's geometry and framerate.
            # Without this, splicing a portrait phone clip into a landscape
            # screen recording either fails at concat or silently produces a
            # stream players letterbox differently. Scale preserves aspect
            # ratio (force_original_aspect_ratio) and pads the remainder black
            # rather than stretching a face sideways.
            "-vf", vf,
            "-video_track_timescale", "90000",
            part,
        ])
        parts.append(part)

    listfile = os.path.join(tmpdir, "concat.txt")
    with open(listfile, "w") as fh:
        for part in parts:
            fh.write(f"file '{part}'\n")
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", listfile, "-c", "copy", out_path])
    return probe_duration(out_path)


def main():
    ap = argparse.ArgumentParser(description="Block-boundary cutter. Never trims silence.")
    ap.add_argument("--master", required=True, help="the full recorded master mp4")
    ap.add_argument("--blocks", required=True, help="blocks.json")
    ap.add_argument("--out", default="./out", help="output directory")
    ap.add_argument("--only", help="build just this one cut (e.g. social)")
    args = ap.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH -- install ffmpeg first")
    if not os.path.exists(args.master):
        sys.exit(f"master not found: {args.master}")

    try:
        with open(args.blocks) as fh:
            spec = json.load(fh)
    except json.JSONDecodeError as e:
        sys.exit(f"{args.blocks} is not valid JSON: {e}")

    master_duration = probe_duration(args.master)
    width, height, fps = probe_video(args.master)
    print(f"master: {args.master}  ({master_duration:.2f}s, {width}x{height} @ {fps}fps)")
    print("        cuts use this geometry unless they set their own \"size\"\n")
    durations = {args.master: master_duration}
    tonemap_ok = has_zscale()

    # A malformed timestamp is a typo in a hand-edited file, not a bug -- it
    # should read as one line telling you which block, not a stack trace.
    blocks = {}
    try:
        for b in spec["blocks"]:
            blocks[b["id"]] = {
                "name": b.get("name", ""),
                "start": parse_time(b["start"]),
                "end": parse_time(b["end"]),
                # Optional: a block that lives in its own file rather than in
                # the master recording (sparring footage, a phone shot).
                "source": b.get("source"),
                # Optional: drop this block's audio and substitute silence.
                # Must be carried here or resolve_segments' block.get("mute")
                # always reads False and the flag silently does nothing --
                # which is exactly what happened the first time.
                "mute": b.get("mute", False),
            }
    except (KeyError, ValueError) as e:
        sys.exit(f"blocks: {e}")

    # Gaps between consecutive blocks are usually a stale block map rather than
    # an intentional discard, and they're invisible in the output. Warn, don't
    # fail -- there are legitimate reasons (a fluffed take between blocks).
    #
    # External-source blocks are excluded: their timestamps index a different
    # file, so comparing them against the master's timeline would produce
    # confident nonsense about overlaps that don't exist.
    on_master = {k: v for k, v in blocks.items() if not v["source"]}
    ordered = sorted(on_master.items(), key=lambda kv: kv[1]["start"])
    for (aid, a), (bid, b) in zip(ordered, ordered[1:]):
        gap = b["start"] - a["end"]
        if gap > 0.5:
            print(f"  note: {gap:.1f}s between block {aid} and block {bid} is in no cut")
        elif gap < -0.05:
            print(f"  WARNING: block {aid} and block {bid} overlap by {-gap:.1f}s")

    os.makedirs(args.out, exist_ok=True)
    cuts = spec["cuts"]
    if args.only:
        if args.only not in cuts:
            sys.exit(f"no cut named {args.only!r} -- have: {', '.join(cuts)}")
        cuts = {args.only: cuts[args.only]}

    results = []
    for name, spec_entries in cuts.items():
        # A cut is either a bare list of entries (inherits the master's frame)
        # or {"size": "WxH", "segments": [...]} to override it. The social cut
        # needs this: Reels/TikTok/Shorts are vertical, and normalising a
        # 9:16 sparring shot into a landscape frame wastes two thirds of the
        # picture on black bars -- on the one shot whose whole job is to stop
        # a thumb. The prospect and landing cuts stay landscape.
        if isinstance(spec_entries, dict):
            entries = spec_entries["segments"]
            try:
                cw, ch = (int(n) for n in str(spec_entries["size"]).lower().split("x"))
            except (KeyError, ValueError):
                sys.exit(f"cut {name!r}: 'size' must look like \"1080x1920\"")
        else:
            entries, cw, ch = spec_entries, width, height

        print(f"  {name}:" + (f"  [{cw}x{ch}]" if (cw, ch) != (width, height) else ""))
        segments = resolve_segments(entries, blocks, args.master, master_duration, durations)
        out_path = os.path.join(args.out, f"{name}.mp4")
        with tempfile.TemporaryDirectory() as tmpdir:
            duration = build_cut(segments, out_path, tmpdir, cw, ch, fps, tonemap_ok)
        results.append((name, out_path, duration))
        print(f"    -> {out_path}  ({duration:.2f}s)\n")

    print("done")
    for name, path, duration in results:
        mins, secs = divmod(duration, 60)
        print(f"  {name:10s} {int(mins)}:{secs:05.2f}  {path}")


if __name__ == "__main__":
    main()
