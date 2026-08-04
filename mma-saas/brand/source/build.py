import re, pathlib
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

ANTON = 'node_modules/@fontsource/anton/files/anton-latin-400-normal.woff2'
OSWALD = 'node_modules/@fontsource/oswald/files/oswald-latin-600-normal.woff2'

RED = "#E02020"
WHITE = "#F7F7F9"
INK = "#0A0A0A"
GREY_D = "#9A9AA4"
GREY_L = "#5A5A66"

# tight bounding box of the icon artwork inside icon.svg's 512 viewBox
AX, AY, AW, AH = 58.0, 84.0, 412.0, 332.0


def glyphs(fontpath, text, size, tracking=0.0):
    f = TTFont(fontpath)
    upem = f['head'].unitsPerEm
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    scale = size / upem
    cap = f['OS/2'].sCapHeight * scale
    x = 0.0
    out = []
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            x += size * 0.26 + tracking
            continue
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        d = pen.getCommands()
        if d:
            out.append((ch, d, x, scale))
        x += gs[gname].width * scale + tracking
    # trim right sidebearing of last glyph for a tight box
    return out, x - tracking, cap


def paint(gl, split, c1, c2):
    return "\n    ".join(
        f'<path fill="{c1 if i < split else c2}" '
        f'transform="translate({x:.2f},0) scale({sc:.6f},{-sc:.6f})" d="{d}"/>'
        for i, (ch, d, x, sc) in enumerate(gl))


icon_src = pathlib.Path('icon.svg').read_text()
inner = re.search(r'<svg[^>]*>(.*)</svg>', icon_src, re.S).group(1).strip()
for i in ["hood", "bandGrad", "tailA", "tailB", "eyeGrad", "eyeGlow", "hoodClip"]:
    inner = inner.replace(f'id="{i}"', f'id="kd-{i}"').replace(f'url(#{i})', f'url(#kd-{i})')


def icon_group(h, tx, ty):
    s = h / AH
    return (f'<g transform="translate({tx - AX * s:.2f},{ty - AY * s:.2f}) '
            f'scale({s:.6f})">\n    {inner}\n  </g>'), AW * s


def lockup(path, wordcolor, tagcolor, tagline=None, IH=300.0):
    ig, iw = icon_group(IH, 0, 0)
    gap = IH * 0.17
    word_size = 262
    gl, ww, cap = glyphs(ANTON, "KOMBATDESK", word_size, 3)
    wm = paint(gl, 6, wordcolor, RED)
    wx = iw + gap

    tag_svg, tw = "", 0.0
    tag_base = 0.0
    if tagline:
        tgl, tw, tcap = glyphs(OSWALD, tagline, 40, 6.6)
        # stretch tagline to match the wordmark width
        k = ww / tw
        tgl, tw, tcap = glyphs(OSWALD, tagline, 40 * k, 6.6 * k)
        tag_svg = "\n    ".join(
            f'<path fill="{tagcolor}" transform="translate({x:.2f},0) scale({sc:.6f},{-sc:.6f})" d="{d}"/>'
            for ch, d, x, sc in tgl)
        block = cap + 26 + tcap
        word_base = (IH - block) / 2 + cap
        tag_base = word_base + 26 + tcap
    else:
        word_base = (IH + cap) / 2

    W = wx + max(ww, tw)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {IH:.0f}" width="{W:.0f}" height="{IH:.0f}">
  {ig}
  <g transform="translate({wx:.2f},{word_base:.2f})">
    {wm}
  </g>'''
    if tagline:
        svg += f'''
  <g transform="translate({wx:.2f},{tag_base:.2f})">
    {tag_svg}
  </g>'''
    svg += "\n</svg>\n"
    pathlib.Path(path).write_text(svg)
    # Print the same rounded values written into the viewBox above. int() would
    # truncate (W=1734.703 -> 1734 while the viewBox says 1735), and app code
    # copied off this line would carry the wrong aspect ratio.
    print(path, f"{W:.0f}", f"{IH:.0f}")


def stacked(path, wordcolor, tagcolor, tagline=None, IH=300.0):
    word_size = 150
    gl, ww, cap = glyphs(ANTON, "KOMBATDESK", word_size, 2)
    ig, iw = icon_group(IH, 0, 0)
    W = max(iw, ww)
    gap = 44
    H = IH + gap + cap
    ig, iw = icon_group(IH, (W - iw) / 2, 0)
    wm = paint(gl, 6, wordcolor, RED)
    body = f'''  {ig}
  <g transform="translate({(W - ww) / 2:.2f},{IH + gap + cap:.2f})">
    {wm}
  </g>'''
    if tagline:
        tgl, tw, tcap = glyphs(OSWALD, tagline, 30, 5)
        k = ww / tw
        tgl, tw, tcap = glyphs(OSWALD, tagline, 30 * k, 5 * k)
        tag = "\n    ".join(
            f'<path fill="{tagcolor}" transform="translate({x:.2f},0) scale({sc:.6f},{-sc:.6f})" d="{d}"/>'
            for ch, d, x, sc in tgl)
        H = IH + gap + cap + 22 + tcap
        body += f'''
  <g transform="translate({(W - tw) / 2:.2f},{IH + gap + cap + 22 + tcap:.2f})">
    {tag}
  </g>'''
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" '
           f'width="{W:.0f}" height="{H:.0f}">\n{body}\n</svg>\n')
    pathlib.Path(path).write_text(svg)
    # Rounded to match the viewBox, for the same reason as in lockup().
    print(path, f"{W:.0f}", f"{H:.0f}")


def badge(path, bg="#0A0A0A", ring=True):
    S = 512.0
    IH = 300.0
    ig, iw = icon_group(IH, (S - AW * IH / AH) / 2, (S - IH) / 2)
    ringsvg = ('<rect x="14" y="14" width="484" height="484" rx="104" '
               'fill="none" stroke="#E02020" stroke-width="10" opacity="0.55"/>') if ring else ''
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="116" fill="{bg}"/>
  {ringsvg}
  {ig}
</svg>
'''
    pathlib.Path(path).write_text(svg)
    print(path)


TAG = "MEMBER RETENTION FOR FIGHT GYMS"

lockup("kombatdesk-lockup-dark.svg", WHITE, GREY_D)
lockup("kombatdesk-lockup-light.svg", INK, GREY_L)
lockup("kombatdesk-lockup-tagline-dark.svg", WHITE, GREY_D, TAG)
lockup("kombatdesk-lockup-tagline-light.svg", INK, GREY_L, TAG)
stacked("kombatdesk-stacked-dark.svg", WHITE, GREY_D, TAG)
stacked("kombatdesk-stacked-light.svg", INK, GREY_L, TAG)
badge("kombatdesk-badge.svg")
