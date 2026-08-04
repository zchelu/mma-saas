# KombatDesk — Brand Assets

Everything for the KombatDesk identity. Created 2026-08-04.

Open `brand-sheet.png` first — it shows every asset in this folder at a glance.

---

## Folder map

```
brand/
├─ brand-sheet.png        visual index of the whole system
├─ logo/
│  ├─ svg/                vector — use these wherever possible
│  └─ png/                raster fallbacks, transparent background
├─ favicon/               browser + app icons, all sizes
├─ web/                   og.png — the social/link-preview card
├─ print/                 business cards, print-ready
└─ source/                editable master files
```

---

## Which file do I use?

| Situation | File |
|---|---|
| Website header, dark background | `logo/svg/kombatdesk-lockup-dark.svg` |
| Anything on white — invoices, letterhead, a printed flyer | `logo/svg/kombatdesk-lockup-light.svg` |
| Instagram / Facebook profile picture | `logo/png/kombatdesk-badge-1024.png` |
| Square placement where you need the tagline | `logo/svg/kombatdesk-stacked-dark.svg` |
| Just the ninja, no words | `logo/svg/kombatdesk-icon.svg` |
| Browser tab icon | `favicon/favicon.ico` |
| Someone asks for "your logo" and you don't know the context | `logo/png/kombatdesk-lockup-dark-2000.png` |

**SVG or PNG?** SVG always, if the tool accepts it — it stays sharp at any size,
from a favicon to a banner. Use PNG only when something rejects SVG (some print
shops, Canva Free, older social uploaders).

---

## Colors

| Name | Hex | Where it's used |
|---|---|---|
| Brand red | `#E02020` | headband, outline, the word "DESK" |
| Red hover | `#FF4D4D` | highlights, link hover |
| Deep red | `#8F1414` | shadow side of the headband |
| Ink | `#0A0A0A` | backgrounds |
| Hood | `#141216` | the ninja hood body |
| Eye cyan | `#4FD2FF` | the glow |
| Eye core | `#E2FAFF` | eye centers |

These are pulled from the live site's `app/globals.css`, not invented — the
logo and the site are the same red.

---

## Fonts

The wordmark is **Anton**; the tagline is **Oswald SemiBold**. Both are free on
Google Fonts.

You do **not** need to install them to use these files — all the type is already
converted to vector shapes inside the SVGs. Install them only if you're setting
new headline text elsewhere and want it to match.

---

## Rules worth following

- **Don't shrink the full logo below about 48px.** The headband tails turn to
  mush. Use `favicon/` or `logo/svg/kombatdesk-favicon.svg` for small sizes —
  it's the same mark with the tails removed.
- **Leave breathing room.** Keep clear space around the logo equal to the height
  of the red headband. Don't crowd it against other elements.
- **Don't recolor it, stretch it, add effects, or put it on a busy photo.**
- **Don't put the standard mark on a red background** — the red outline
  disappears into it.

---

## Business cards

`print/kombatdesk-business-card-PRINT.pdf` — upload this file directly to
Vistaprint, Moo, or any local print shop. It's already correct:

- 2 pages: page 1 is the front, page 2 is the back
- 3.75 × 2.25 in per page — that's the standard 3.5 × 2 in card plus the
  0.125 in bleed printers require
- All text sits safely inside the trim line

**When ordering, ask for matte or soft-touch finish.** Gloss on a black card
shows every fingerprint.

The back has a QR code pointing at kombatdesk.com. It's black on a white plate
rather than inverted, because inverted codes scan badly on older phones and a
card has to work on every phone in the room. Tested: it still reads after being
shrunk and blurred well past what a phone camera does.

To change anything on the card, edit `print/card-source.html` and re-export.
`print/qr.svg` is the QR itself — regenerate it with `segno` if the URL changes.

---

## Social / link previews

`web/og.png` is what appears when kombatdesk.com gets shared in a text message,
on LinkedIn, or in Slack. It's already wired into the site in `app/layout.tsx`.

You can also use it as a LinkedIn banner crop or a slide background.

---

## Regenerating or editing

`source/icon.svg` is the editable master of the ninja mark — open it in any
vector tool (Figma, Illustrator, Inkscape) or a text editor.

`source/build.py` regenerates every lockup from that master.

Requires: `python3` with `fonttools` and `brotli` (brotli is needed to read
the `.woff2` files), `segno` for `qr.svg`, and
`npm i -D @fontsource/anton @fontsource/oswald` — the script reads the fonts
out of `node_modules`. None of that is installed in this repo; the assets
were generated elsewhere. The exported files are final, so you should not
need this.
