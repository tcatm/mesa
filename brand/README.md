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
| `mesa-badge-*.svg` | The badge in two solid colours (black, white, night, sandstone, night-mint, mint), for any background. |
| `mesa-icon-*.svg` | Full-bleed squares for app icons and avatars (platforms round the corners). |
| `png/` | Favicon (`favicon.ico`, 16 to 48) and PWA icons (192, 512) from the night badge; Apple touch icons (180) and avatars (1024) in night and black. |

Colours: black, white, the site's sandstone `#EEA155` and night `#0F0D0C`,
and mint `#97FCE4`. Nothing else: the original's blue is not used. Mint is
light, so use it on dark backgrounds (night or black); on white or light
backgrounds use the mint badge (night M on mint) instead of the mint mark.

Mint PNGs: `mesa-badge-knockout-mint-512`, `mesa-badge-mint-512`,
`mesa-badge-night-mint` (192, 512), `mesa-icon-night-mint` and
`mesa-icon-mint` (180, 512, 1024).

Clear space: keep at least the width of one mesa top (182 of 1066 units,
about a sixth of the M's width) clear around the mark. Smallest size: 16 px
for the badge, 24 px wide for the mark alone.
