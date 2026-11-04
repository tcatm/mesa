# Mesa logo

Rebuilt as vectors from the original artwork (`source/original.jpg`). Every
file comes from one geometry in `build.py`, so they always match:
`python3 build.py` regenerates `svg/`.

The M is two flat-topped mesas and a peak on one grid. Every slanted edge has
the same slope (3/7), the step sits at 46% of the height, and each shape
meets the next exactly at a point. Overlaid on the original it matches 96.6%
of the M's pixels; the remainder is the original's soft, uneven edges.

| File | Use |
|---|---|
| `mesa-mark*.svg` | The M alone. `mesa-mark.svg` takes the surrounding text colour (`currentColor`). |
| `mesa-badge-knockout*.svg` | The badge with the M as negative space: the background shows through the M. |
| `mesa-badge-*.svg` | The badge in two solid colours, for any background. |
| `mesa-icon-*.svg` | Full-bleed squares for app icons and avatars (platforms round the corners). |
| `mesa-original.svg` | The original composition: white knockout badge on the blue field. |
| `png/` | Favicons (`favicon.ico`, 16 to 48), PWA icons (192, 512), Apple touch icon (180), avatars (1024). |

Colours: blue `#1B4382` (from the original), sandstone `#EEA155` and night
`#0F0D0C` (the site's palette). On the site, the sandstone mark or the night
badge sit with the rest of the design; blue suits contexts outside it.

Clear space: keep at least the width of one mesa top (182 of 1066 units,
about a sixth of the M's width) clear around the mark. Smallest size: 16 px
for the badge, 24 px wide for the mark alone.
