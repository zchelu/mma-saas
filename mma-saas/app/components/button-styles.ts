// Shared disabled-button appearance.
//
// Every disabled button in the app used to be `disabled:opacity-40` over a
// #E02020 primary on the #0D0D0D page. Opacity fades the label and the surface
// together, so the composite was a ~#611515 button carrying a ~#6E6E6E label:
// 2.5:1, against a 4.5:1 WCAG AA floor for normal text. The secondary "Back"
// button was worse at ~2.0:1. Zain read the /sign-up gate as broken rather than
// disabled, which is the real cost — a disabled control that looks broken reads
// as a bug in the product at the exact moment someone is deciding to buy.
//
// The state change is carried by HUE here, not by fading: #333333 is already
// the app's standard border colour and #AAAAAA its standard secondary text, so
// this reads as "off" against the red primary while measuring 5.4:1.
//
// Spread this AFTER a button's base style so it wins, and drive it from the
// same boolean that feeds `disabled` — never from a `disabled:` Tailwind class.
// These buttons set their colours via inline `style`, and an inline style beats
// a utility class no matter how specific the variant looks. That is why the old
// `disabled:opacity-40` was the only thing that appeared to work here: opacity
// composites the element after the fact, so it was never fighting the inline
// backgroundColor the way a `disabled:bg-*` class would have been.
export const DISABLED_BUTTON_STYLE = {
  backgroundColor: "#333333",
  color: "#AAAAAA",
} as const;
