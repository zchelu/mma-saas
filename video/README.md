# video/ — the KombatDesk demo video

Everything for the demo video lives here. The **recipe** is tracked in git;
the **media** is not (see `.gitignore` — a few re-shoots of 1080p phone footage
would permanently bloat the repo for every future clone).

```
video/
  raw/        your phone recordings          (gitignored — put IMG_*.mov here)
  footage/    product footage captured from the live site
  out/        finished cuts                  (gitignored)
  blocks.json the cut recipe                 (tracked)
  kd-cut.py   the cutter                     (tracked)
```

## Where the script lives

Not here. It's in the claude.ai project as
`claude/demo-video-script-verified-2026-08-06.md` — nine blocks with what you
say and what's on screen beside each, plus a fact card where every product
claim was checked against source, and a do-not-say table.

## Two sources

You shoot yourself on the iPhone, portrait. Product footage is screen-captured
from the live site into `footage/`. They differ in orientation, framerate and
loudness, which is what `kd-cut.py` exists to reconcile.

## Assembly happens in Clipchamp

Judging pacing is the whole job on this script — the three-second silence on the
At Risk list, the beat after the phone buzzes — and you cannot judge that from a
JSON file. Assemble and trim on a timeline where you can watch it.

`blocks.json` and `kd-cut.py` are for the mechanical part: regenerating all
three cuts identically after a re-shoot, and producing the vertical social
version once the landscape one is locked. Block 8 is the likely re-shoot, if you
use the "zero of five taken" line.

## Status

| Block | Source | State |
|---|---|---|
| 1 — The problem | `raw/IMG_8264.mov` + `raw/IMG_8265.mov` | shot, 38s across two segments |
| 1B — Background | phone | to shoot — wording is finalised in the script |
| 2 — The one idea | phone | to shoot |
| 3 — The list | `footage/block3_*.mp4` | captured, both formats |
| 4 — The kiosk | `footage/block4_kiosk_*.mp4` | captured, both formats |
| 5 — The text | phone + screen | to shoot — yours, see below |
| 6 — The brakes | phone | to shoot — **use the weaker STOP line**, see below |
| 7 — The honest limit | phone | to shoot |
| 8 — The ask | phone | to shoot |
| 99 — Sparring | phone | not yet transferred |

## Two things that are deliberately not automated

**Block 5, the send.** Pressing *Send Retention Texts* is a real message to a
real number, and the phone buzzing has to be filmed anyway. Yours to shoot.

**Block 4's tap.** Tapping a name writes a real check-in to the demo gym, and
`refresh-demo-gym.js` only ever moves last-visit forward — it cannot be undone.
The captured footage stops at the name appearing. If you want the tap on screen,
use a member who is NOT on the At Risk list (Tyler Brandt, Paige Donovan) so
nothing visible changes.

## Block 6 — still on the weaker line

The strong opt-out line ("nothing puts them back on") needs the `members.add`
inheritance fix committed and deployed. Until then, film:

> And that opt-out sticks to the number, not to the person. If they text STOP,
> that's it — they stay off until they text START back themselves.

True today. Block 6 is 35 seconds against a plain background; re-shooting just
that block later is cheap. A false claim in a video sent to five gym owners
is not.

## Before you film anything

The demo rig has to be armed, from inside `mma-saas/`:

```
node scripts/demo-sms.js         --gym-id=jx7ahw5fkgmfweyb3fpe0y1ftn8b4pc6 --prod --revert --commit
node scripts/refresh-demo-gym.js --gym-id=jx7ahw5fkgmfweyb3fpe0y1ftn8b4pc6 --prod
node scripts/refresh-demo-gym.js --gym-id=jx7ahw5fkgmfweyb3fpe0y1ftn8b4pc6 --prod --commit
node scripts/demo-sms.js         --gym-id=jx7ahw5fkgmfweyb3fpe0y1ftn8b4pc6 --prod --commit
```

Then check the dashboard reads **Can be texted: 1** and At Risk shows 2–7 names.
If it reads 0, the rig is not armed and block 5 cannot be filmed.

**After filming, always** — or the daily job texts your real phone:

```
node scripts/demo-sms.js --gym-id=jx7ahw5fkgmfweyb3fpe0y1ftn8b4pc6 --prod --revert --commit
```

Nobody touches the kiosk between arming and wrap.

## Audio

Your phone footage measured −26.6 and −23.6 LUFS across the two block 1
segments — quiet, and 3 LU apart from each other, which is an audible jump
mid-block. `kd-cut.py` normalises every segment to a common target and brought
them to within 0.3 LU. If you assemble in Clipchamp instead, raise the phone
segments and match them by ear, or run the two block 1 files through the cutter
first and import the result.
