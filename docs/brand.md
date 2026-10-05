# TypeNext icon

The app mark is exactly `|>`: a white vertical bar and open right-pointing chevron on an opaque black square. The two symbols align at their top and bottom edges. The master was created and corrected using the built-in imagegen tool on 6 October 2026.

The full-resolution master is [public/brand/logo-master.png](../public/brand/logo-master.png). The app's sidebar, welcome screen, custom titlebar, browser favicon and project site use its verified 256px derivative, [public/Icon.png](../public/Icon.png), to keep startup decoding small. Windows executables/installers and macOS app bundles use the ICO/ICNS and PNG sizes generated from that same master.

```sh
node scripts/prepare-icons.mjs
node scripts/verify-brand.mjs
```

The generator uses the locked Tauri CLI and records source/output SHA-256 hashes in `public/brand/icon-manifest.json`. The release verifier checks these hashes, the bundle's configured icons, opaque black corners and equal glyph bounds with a one-pixel allowance for antialiasing. It inspects the image without changing it. Icon regeneration performs platform resizing and container conversion; it does not redraw the logo.

The NSIS installer and uninstaller explicitly select `icons/icon.ico`; setting only the application icon leaves NSIS's generic installer mark in place. Before publication, the packaging gate checks the canonical ICO image frames inside the actual Windows application and setup EXE, and compares each Mac application's packaged ICNS byte for byte with the canonical source.

## Generation prompt

Use case: logo-brand. Asset type: the final square desktop app icon for TypeNext, reused in the app, Windows executable/installer and macOS app. Primary request: a perfectly clean, minimal flat icon showing exactly the two white symbols "|>" on a solid pure black (#000000) square background. White glyphs (#FFFFFF), balanced medium-bold stroke weight, crisp geometric sans-serif forms; the vertical bar | and right-pointing greater-than > have EXACTLY the same overall height, identical top and bottom alignment. The > is an OPEN chevron with two angled strokes, not a filled triangle. Keep a modest horizontal gap between the bar and chevron, matching their visual stroke weight. Center the combined | > mark as one unit, with generous clear black padding on every side; glyphs occupy about half the canvas height. Flat front view, square full-bleed black background, no rounded outer mask (platforms handle masking), no perspective. Text (verbatim): "|>". Only these two symbols. Avoid any wordmark, letters, captions, extra lines, border, gradients, glow, shadow, 3D, texture, watermark or mockup. This must look sharp and readable as a small app icon. Equal glyph height is the most important geometric constraint.

## Alignment correction prompt

Edit this TypeNext app icon. Keep the pure black full square background, exact white '|>' symbol, horizontal spacing, centering and flat minimal style. Change ONLY the height/alignment discrepancy: in the provided image the vertical bar is taller than the chevron; make BOTH glyphs have exactly identical upper and lower bounding-box edges. Extend the chevron upward and downward to match the bar's top and bottom at precisely the same height, or shorten the bar if necessary; the two glyphs must look visibly equal in height. Strong horizontal alignment of the top of the bar and upper tip of the >, and of the bottom of the bar and lower tip of the >. Equal height is mandatory. Use solid #FFFFFF filled glyph strokes with clean anti-aliased edges on #000000. No texture, no gradients, no glow, no other mark. Keep the > as an open right-pointing chevron, never a triangle. Square app icon ready to ship.
