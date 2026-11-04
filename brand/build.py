"""
Mesa logo: every variant generated from one geometry, so they always agree.

The M is two flat-topped mesas and a peak on one grid: height 560, a step
at 259, every slanted edge at a slope of 3/7 (240 across over the full
height), mesas 182 wide. Each mesa's right shoulder meets the next shape's
left edge exactly, and the peak's right side continues the second mesa's.
Traced from the original artwork (brand/source/original.jpg).
Colours are the site's only: black, white, sandstone and night.

    python3 brand/build.py        # writes brand/svg/*.svg
"""
from pathlib import Path

SANDSTONE = "#EEA155"  # the site's accent, oklch(0.77 0.13 63)
NIGHT = "#0F0D0C"      # the site's background, oklch(0.16 0.004 60)
BLACK, WHITE = "#000000", "#FFFFFF"

# The mark, in a 1066 x 560 box.
MESA_1 = [(240, 0), (422, 0), (533, 259), (382, 259), (253, 560), (0, 560)]
MESA_2 = [(x + 404, y) for x, y in MESA_1]
PEAK = [(937, 259), (1066, 560), (808, 560)]
SHAPES = [MESA_1, MESA_2, PEAK]
MARK_W, MARK_H = 1066, 560

# The badge: a 1300 square with corner radius 188, the M centred
# horizontally and set slightly high (as in the original) for optical balance.
BADGE, RADIUS = 1300, 188
MARK_X, MARK_Y = (BADGE - MARK_W) / 2, 347


def poly(points, dx=0.0, dy=0.0):
    return "M" + " L".join(f"{x + dx:g} {y + dy:g}" for x, y in points) + " Z"


def mark_path(dx=0.0, dy=0.0):
    return " ".join(poly(s, dx, dy) for s in SHAPES)


def rounded_square(size, r):
    return (
        f"M{r} 0 H{size - r} A{r} {r} 0 0 1 {size} {r} V{size - r} "
        f"A{r} {r} 0 0 1 {size - r} {size} H{r} A{r} {r} 0 0 1 0 {size - r} V{r} A{r} {r} 0 0 1 {r} 0 Z"
    )


def svg(w, h, body, title):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">\n'
        f"  <title>{title}</title>\n{body}\n</svg>\n"
    )


def mark(fill):
    return svg(MARK_W, MARK_H, f'  <path fill="{fill}" d="{mark_path()}"/>', "Mesa")


def badge_knockout(fill):
    """A rounded square with the M cut out: the background shows through the M."""
    d = rounded_square(BADGE, RADIUS) + " " + mark_path(MARK_X, MARK_Y)
    return svg(BADGE, BADGE, f'  <path fill="{fill}" fill-rule="evenodd" d="{d}"/>', "Mesa")


def badge_solid(square, m):
    body = (
        f'  <path fill="{square}" d="{rounded_square(BADGE, RADIUS)}"/>\n'
        f'  <path fill="{m}" d="{mark_path(MARK_X, MARK_Y)}"/>'
    )
    return svg(BADGE, BADGE, body, "Mesa")


def icon(bg, m):
    """Full-bleed square for app icons and avatars: platforms round the corners themselves."""
    body = f'  <rect width="{BADGE}" height="{BADGE}" fill="{bg}"/>\n  <path fill="{m}" d="{mark_path(MARK_X, MARK_Y)}"/>'
    return svg(BADGE, BADGE, body, "Mesa")


VARIANTS = {
    # The M alone.
    "mesa-mark": mark("currentColor"),
    "mesa-mark-black": mark(BLACK),
    "mesa-mark-white": mark(WHITE),
    "mesa-mark-sandstone": mark(SANDSTONE),
    # The badge with the M as negative space (transparent).
    "mesa-badge-knockout": badge_knockout("currentColor"),
    "mesa-badge-knockout-black": badge_knockout(BLACK),
    "mesa-badge-knockout-white": badge_knockout(WHITE),
    "mesa-badge-knockout-sandstone": badge_knockout(SANDSTONE),
    # The badge in two solid colours (works on any background).
    "mesa-badge-black": badge_solid(BLACK, WHITE),
    "mesa-badge-white": badge_solid(WHITE, BLACK),
    "mesa-badge-night": badge_solid(NIGHT, SANDSTONE),
    "mesa-badge-sandstone": badge_solid(SANDSTONE, NIGHT),
    # Full-bleed squares for app icons, avatars and favicons.
    "mesa-icon-black": icon(BLACK, WHITE),
    "mesa-icon-white": icon(WHITE, BLACK),
    "mesa-icon-night": icon(NIGHT, SANDSTONE),
}

if __name__ == "__main__":
    out = Path(__file__).parent / "svg"
    out.mkdir(exist_ok=True)
    for name, text in VARIANTS.items():
        (out / f"{name}.svg").write_text(text)
    print(f"{len(VARIANTS)} SVGs in {out}")
