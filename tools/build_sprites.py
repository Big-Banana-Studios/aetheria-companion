# -*- coding: utf-8 -*-
"""build_sprites.py - the companion's sprite atlas, cut from the courier's own art.

The source is the Paperless courier pack: one folder per animation per
direction, each holding 49-64 frames of 640x640 (a generated video, in effect),
plus an atlas.json and a spritesheet PNG.  This tool does what the game's own
importer (Paperless/tools/import_courier.py) does - ONE scale and ONE window per
animation-direction, taken on medians, so a walk keeps its bob and every clip
renders a courier of the same height standing on the same line - and then
packs the handful of clips the companion needs into a single atlas with a JSON
manifest the renderer reads.

Nothing is redrawn.  The pixel look comes from the downscale, exactly as it
does in the game.

    python tools/build_sprites.py \\
        --pack "../top-down-bagless-courier-spritesheet" \\
        --out public/assets/sprites/courier

Frame size defaults to 160 px with the courier 144 px tall - exactly twice the
game's 80/72/79 framing, so proportions match the game and the face has enough
pixels for a mouth.  `--frame 80` gives the game-identical build.

Mouth overlay (optional, once the art exists - see SPRITE_GUIDE.md):

    python tools/build_sprites.py --pack ... --out ... \\
        --talk "../courier-talk/iso_talk_down_right"

cuts five mouth frames out of a talking clip and writes mouth.png next to the
atlas; the manifest then points at it instead of the procedural mouth.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.stderr.write("build_sprites needs Pillow:  python -m pip install Pillow\n")
    raise SystemExit(2)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

VISIBLE = 13   # alpha above which a pixel counts (matches the game importer)

# ---------------------------------------------------------------------------
# What the companion needs.  (patterns, clip name, frames, fps, kind)
#
# kind:  "cycle"   a locomotion/breathing loop - find one stride, sample round it
#        "uncut"   loops but is not a stride (smoking) - sample across the whole
#        "shot"    plays once - sample first..last
#        "preglow" plays once, cut before the baked-in glow (resonate)
#        "flinch"  the hit reaction - drop the baked-in red flash, keep the recoil
# ---------------------------------------------------------------------------
CLIPS = [
    (["iso_idle_down_right", "iso_idle_down"],           "idle_down",       8,  6, "cycle"),
    (["iso_idle_right_right", "iso_idle_right"],         "idle_right",      4,  6, "cycle"),
    (["iso_idle_southeast_right", "iso_idle_southeast"], "idle_southeast",  4,  6, "cycle"),
    (["iso_walk_down_right", "iso_walk_down"],           "walk_down",      12, 21, "cycle"),
    (["resonate down"],                                  "resonate_down",   4,  8, "preglow"),
    (["hurt down"],                                      "hurt_down",       3, 10, "flinch"),
    # Expressive one-shots and the moves that carry her across the scene.
    (["iso_jump_down_right", "iso_jump_down"],           "jump_down",       8, 12, "shot"),
    (["dash right"],                                     "dash_right",      6, 16, "shot"),
    (["punch down"],                                     "punch_down",      6, 12, "shot"),
    (["punch right"],                                    "punch_right",     6, 12, "shot"),
    (["iso_run_right_right", "iso_run_right"],           "run_right",      12, 21, "cycle"),
    (["iso_walk_right_right", "iso_walk_right"],         "walk_right",     12, 21, "cycle"),
    (["iso_idle_up_right", "iso_idle_up"],               "idle_up",         4,  6, "cycle"),
    (["iso_idle_northeast_right", "iso_idle_northeast"], "idle_northeast",  4,  6, "cycle"),
    # Lying down, from "the Courier sleep" pack when it is given (flat pairs,
    # 56 frames of 768), else the bagless pack's `sleep Down`. Every direction
    # drawn, so a nap can face any way; `error` uses the down one.
    (["iso_custom_sleep_down", "sleep down"],            "sleep_down",      6,  5, "shot"),
    (["iso_custom_sleep_right", "sleep right"],          "sleep_right",     6,  5, "shot"),
    (["iso_custom_sleep_southeast", "sleep southeast"],  "sleep_southeast", 6,  5, "shot"),
    (["iso_custom_sleep_northeast", "sleep northeast"],  "sleep_northeast", 6,  5, "shot"),
    (["iso_custom_sleep_up", "sleep up"],                "sleep_up",        6,  5, "shot"),
    # The smoke break, every direction the pack draws it in (there is no
    # `down`; she never smokes straight at the camera). The renderer turns her
    # through these while she sits it out, and mirrors give the other three.
    (["smoking southeast"],                              "smoke_southeast", 12,  7, "uncut"),
    (["smoking right"],                                  "smoke_right",     12,  7, "uncut"),
    (["smoking northeast"],                              "smoke_northeast", 12,  7, "uncut"),
    (["smoking up"],                                     "smoke_up",        12,  7, "uncut"),
]

# Which way she faces in each clip; the renderer only draws a mouth on a face.
FACING = {
    "idle_down": "down", "idle_right": "right", "idle_southeast": "southeast",
    "idle_up": "up", "idle_northeast": "northeast",
    "walk_down": "down", "resonate_down": "down", "hurt_down": "down",
    "jump_down": "down", "punch_down": "down", "punch_right": "right", "dash_right": "right",
    "run_right": "right", "walk_right": "right",
    "sleep_down": "down", "sleep_right": "right", "sleep_southeast": "southeast",
    "sleep_northeast": "northeast", "sleep_up": "up",
    "smoke_southeast": "southeast", "smoke_right": "right",
    "smoke_northeast": "northeast", "smoke_up": "up",
}

GLOW = 1.25       # brightness ratio that counts as the drawn glow, not movement
GLOW_MIN = 8


# ---------------------------------------------------------------------------
# Finding and loading source frames
# ---------------------------------------------------------------------------

_VERSION_TAG = re.compile(r"-v\d+$")


def _plain(stem):
    """A flat file's stem without the generator's `-atlas` / `-vN` suffixes."""
    stem = stem.lower()
    if stem.endswith("-atlas"):
        stem = stem[:-6]
    return _VERSION_TAG.sub("", stem)


def find_source(packs, patterns):
    """Where one animation lives: a folder, or a flat (json, png) pair.

    Packs are searched last-first so a later delivery wins. Matching is on a
    case-insensitive SUFFIX, because each generator prefixes its output
    differently (`iso_walk_down_right`, `top down courier-iso_run_down`,
    `top down courier-iso_custom_sleep_down-v1`) and all mean the same thing.
    Returns ("dir", path) or ("pair", json_path, png_path), or None.
    """
    for pack in reversed(packs):
        if not os.path.isdir(pack):
            continue
        entries = sorted(os.listdir(pack))
        for pattern in patterns:
            want = pattern.lower()
            here = os.path.basename(pack.rstrip("/\\")).lower()
            if here == want or here.endswith(want):
                return ("dir", pack)
            for name in entries:
                full = os.path.join(pack, name)
                if os.path.isdir(full) and (name.lower() == want or name.lower().endswith(want)):
                    return ("dir", full)
            for name in entries:
                if not name.lower().endswith(".json"):
                    continue
                stem = _plain(name[:-5])
                if stem == want or stem.endswith(want):
                    raw = name[:-5]
                    for cand in (raw, raw[:-6] if raw.lower().endswith("-atlas") else raw):
                        png = os.path.join(pack, cand + ".png")
                        if os.path.exists(png):
                            return ("pair", os.path.join(pack, name), png)
    return None


def source_name(source):
    return os.path.basename(source[1].rstrip("/\\"))


def _slice(atlas_path, sheet_path):
    with io.open(atlas_path, encoding="utf-8") as f:
        atlas = json.load(f)
    sheet = Image.open(sheet_path).convert("RGBA")
    keys = sorted(atlas["frames"], key=lambda k: int(re.sub(r"\D", "", k) or 0))
    out = []
    for k in keys:
        r = atlas["frames"][k]
        out.append(sheet.crop((r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"])))
    return out


def load_frames(source):
    """Every frame of one animation, in order, as RGBA images.

    Prefers the per-frame PNGs the generator writes into frames/; falls back to
    slicing the sheet with its atlas json.
    """
    if source[0] == "pair":
        return _slice(source[1], source[2])
    folder = source[1]
    fdir = os.path.join(folder, "frames")
    if os.path.isdir(fdir):
        names = sorted(f for f in os.listdir(fdir) if f.lower().endswith(".png"))
        if names:
            return [Image.open(os.path.join(fdir, n)).convert("RGBA") for n in names]
    js = [f for f in os.listdir(folder) if f.lower().endswith(".json")]
    pngs = [f for f in os.listdir(folder) if f.lower().endswith(".png")]
    if not js or not pngs:
        raise SystemExit(f"no frames in {folder}")
    return _slice(os.path.join(folder, js[0]), os.path.join(folder, pngs[0]))


# ---------------------------------------------------------------------------
# Measuring
# ---------------------------------------------------------------------------

def opaque_box(im):
    """Bounding box of the pixels a viewer can actually see."""
    alpha = im.getchannel("A").point(lambda a: 255 if a > VISIBLE else 0)
    return alpha.getbbox()


def _grey(im, size=48):
    return im.convert("L").resize((size, size), Image.LANCZOS).tobytes()


def _apart(a, b):
    return sum(abs(a[i] - b[i]) for i in range(len(a))) / float(len(a))


def one_stride(frames, gait=False):
    """The sub-range of a looping source that is exactly ONE cycle.

    Generated cycles hold two-and-a-bit strides; sampling across the whole file
    lands frames at scattered phases of different strides and the body appears
    to swing.  Find the period by self-similarity and keep one of it.
    Returns (frames, period_float); period == len(frames) means "no cycle
    found, sampled across the whole clip".

    The curve of "how different is frame i from frame i+p" always starts low
    (adjacent frames are alike) and climbs, so its global minimum is useless.
    A cycle is a DIP after a rise: a local minimum clearly below the highest
    point before it.  For a gait, the dip at one STEP is a trap - from the
    front the left and right steps are near mirrors - so if a second dip sits
    near twice the first and is nearly as deep, the stride is the double.
    """
    n = len(frames)
    if n < 16:
        return frames, float(n)
    small = [_grey(f) for f in frames]
    curve = {}
    for p in range(4, n // 2 + 1):
        curve[p] = sum(_apart(small[i], small[i + p]) for i in range(n - p)) / float(n - p)

    dips = []
    for p in range(8, n // 2):
        if curve[p] <= curve[p - 1] and curve[p] <= curve[p + 1]:
            rise = max(curve[q] for q in range(4, p))
            if curve[p] < rise * 0.92:
                dips.append(p)
    if not dips:
        return frames, float(n)
    best_p = dips[0]
    if gait:
        for q in dips:
            if abs(q - 2 * best_p) <= 2 and curve[q] <= curve[best_p] * 1.2:
                best_p = q
                break
    # sub-frame refinement through the three points around the minimum
    period = float(best_p)
    if best_p - 1 in curve and best_p + 1 in curve:
        a, b, c = curve[best_p - 1], curve[best_p], curve[best_p + 1]
        d = a - 2.0 * b + c
        if abs(d) > 1e-9:
            period = best_p + 0.5 * (a - c) / d
    # start the window where the loop closes most cleanly, skipping the ease-in
    p = int(round(period))
    d = [_apart(small[i], small[i + 1]) for i in range(n - 1)]
    med = sorted(d)[len(d) // 2]
    lead = next((i for i, v in enumerate(d) if v >= med * 0.6), 0)
    start = min(lead, n - p - 1)
    best_s, best = start, None
    for st in range(start, n - p):
        v = _apart(small[st], small[st + p])
        if best is None or v < best:
            best, best_s = v, st
    return frames[best_s:best_s + p], period


def pick(n_total, want):
    """`want` frames spread evenly first..last inclusive (a gesture)."""
    if n_total <= want:
        return list(range(n_total))
    return [int(round(i * (n_total - 1) / float(want - 1))) for i in range(want)]


def pick_loop(n_window, want, period):
    """`want` frames spread evenly ROUND a cycle (the closing gap equal to the rest)."""
    if n_window <= want:
        return list(range(n_window))
    return [min(n_window - 1, int(round(i * period / want))) for i in range(want)]


def even_count(period, want):
    """A frame count near `want` whose gaps are (nearly) whole source frames.

    Twelve frames out of a 27-frame stride land at gaps of two, then three,
    then two: a tempo that lurches by half every few frames, which the eye
    reads as a jerk in the body. Choosing the count so period/count is close
    to an integer keeps every gap the same size. The clip's fps is scaled to
    match, so the cycle takes the same time it did.
    """
    best, best_err = want, 1e9
    for n in range(max(4, want - 4), want + 5):
        gap = period / n
        err = abs(gap - round(gap))
        if err < best_err - 1e-6 or (abs(err - best_err) < 1e-6 and abs(n - want) < abs(best - want)):
            best, best_err = n, err
    return best


def stabilise(imgs, frame_px):
    """Take the jitter out of a cycle's upper body without touching its motion.

    Generated frames wobble a pixel or two from frame to frame. Per frame,
    find the head (the top slice of the visible body) and its centre; fit a
    smooth periodic path through those centres (a 3-wide circular moving
    average); and nudge each frame by the whole-pixel residual. The bob and
    the sway survive; the twitch does not.
    """
    if len(imgs) < 4:
        return imgs
    xs, ys = [], []
    for im in imgs:
        box = opaque_box(im)
        if box is None:
            xs.append(None)
            ys.append(None)
            continue
        x0, y0, x1, y1 = box
        top = y0 + max(3, int((y1 - y0) * 0.22))     # the head: the top fifth or so
        px = im.load()
        sx = sy = n = 0
        for y in range(y0, top):
            for x in range(x0, x1):
                if px[x, y][3] > VISIBLE:
                    sx += x
                    sy += y
                    n += 1
        xs.append(sx / n if n else None)
        ys.append(sy / n if n else None)
    if any(v is None for v in xs):
        return imgs
    m = len(imgs)
    out = []
    for i, im in enumerate(imgs):
        ax = (xs[i - 1] + xs[i] + xs[(i + 1) % m]) / 3.0
        ay = (ys[i - 1] + ys[i] + ys[(i + 1) % m]) / 3.0
        dx = int(round(ax - xs[i]))
        dy = int(round(ay - ys[i]))
        if dx == 0 and dy == 0:
            out.append(im)
            continue
        shifted = Image.new("RGBA", (frame_px, frame_px), (0, 0, 0, 0))
        _paste_clipped(shifted, im, dx, dy)
        out.append(shifted)
    return out


def _luminance(frames, step=4):
    out = []
    for f in frames:
        px = f.load()
        tot, n = 0.0, 0
        for y in range(0, f.height, step):
            for x in range(0, f.width, step):
                r, g, b, a = px[x, y]
                if a > 200:
                    tot += 0.299 * r + 0.587 * g + 0.114 * b
                    n += 1
        out.append(tot / n if n else 0.0)
    return out


def glow_span(frames):
    """(first, last+1) of the frames where the art lights up, or None."""
    lum = _luminance(frames)
    if len(lum) < GLOW_MIN + 2:
        return None
    base = sum(lum[:6]) / 6.0
    if base <= 0:
        return None
    lit = [i for i, v in enumerate(lum) if v > base * GLOW]
    if not lit:
        return None
    return lit[0], lit[-1] + 1


def before_glow(frames):
    span = glow_span(frames)
    if span and span[0] >= GLOW_MIN:
        return frames[:span[0]], f"cut before the drawn glow at frame {span[0]}"
    return frames, ""


def after_glow(frames):
    """The recoil: everything after the baked-in hit flash, or the whole clip.

    The flash fades over a few frames after the luminance test stops firing,
    so a handful more are skipped - measured, the red tint lingers about six.
    """
    span = glow_span(frames)
    if span and span[1] + 6 < len(frames) - 4:
        start = span[1] + 6
        return frames[start:], f"kept the recoil after the flash (frames {start}+)"
    return frames, ""


# ---------------------------------------------------------------------------
# The one transform per animation-direction
# ---------------------------------------------------------------------------

def transform_for(frames, frame_px, char_h, feet_y):
    """Scale and offset that fits the MEDIAN frame; applied to all of them.

    With one exception the game's importer does not need: the window must
    also hold the WIDEST frame. A sleep clip kneels (tall, narrow) and then
    lies down (short, wide); the median says "tall", and at that scale the
    lying frames ran off both edges of the 160 px frame. So the scale is
    capped to fit the full horizontal span of the clip, and the clip is
    centred on that span rather than on the median centre. Walks and idles
    are unaffected - their span is one body wide.
    """
    boxes = [opaque_box(f) for f in frames]
    boxes = [b for b in boxes if b]
    hs = sorted(b[3] - b[1] for b in boxes)
    feet = sorted(b[3] for b in boxes)
    med_h = hs[len(hs) // 2]
    med_feet = feet[len(feet) // 2]
    left = min(b[0] for b in boxes)
    right = max(b[2] for b in boxes)
    span = float(right - left)
    k = char_h / float(med_h)
    k = min(k, (frame_px - 4) / span)
    # Headroom too: a jump leaves the ground, and at the median scale the top
    # of her head left the frame at the apex. The highest pixel of any frame
    # has to land at or below row 1 once the median feet sit on feet_y.
    top = min(b[1] for b in boxes)
    rise = float(med_feet - top)
    if rise > 0:
        k = min(k, (feet_y - 1) / rise)
    cx = (left + right) / 2.0
    return k, cx, med_feet


def render(frame, k, med_cx, med_feet, frame_px, feet_y):
    """One source frame into one output frame, feet on the line, centred."""
    w, h = frame.size
    sw, sh = max(1, int(round(w * k))), max(1, int(round(h * k)))
    small = frame.resize((sw, sh), Image.LANCZOS)
    # where the median feet / centre land after scaling
    fx = med_cx * k
    fy = med_feet * k
    ox = int(round(frame_px / 2.0 - fx))
    oy = int(round(feet_y - fy))
    out = Image.new("RGBA", (frame_px, frame_px), (0, 0, 0, 0))
    _paste_clipped(out, small, ox, oy)
    # kill the soft alpha fringe so nearest-neighbour upscaling stays crisp
    a = out.getchannel("A").point(lambda v: 0 if v <= VISIBLE else v)
    out.putalpha(a)
    return out


def _paste_clipped(dst, src, ox, oy):
    x0, y0 = max(0, -ox), max(0, -oy)
    x1 = min(src.width, dst.width - ox)
    y1 = min(src.height, dst.height - oy)
    if x1 <= x0 or y1 <= y0:
        return
    dst.alpha_composite(src.crop((x0, y0, x1, y1)), (ox + x0, oy + y0))


# ---------------------------------------------------------------------------
# The face: where the visor is, and therefore where the mouth goes
# ---------------------------------------------------------------------------

def visor_box(im):
    """Bounding box of the cyan visor band, or None.  Same test the game uses."""
    px = im.load()
    xs, ys = [], []
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a > 120 and b > 150 and g > 130 and r < 140 and b - r > 60:
                xs.append(x)
                ys.append(y)
    if len(xs) < 4:
        return None
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def mouth_for(im, char_h):
    """Mouth anchor derived from the visor: centred under it, a little way down."""
    vb = visor_box(im)
    if not vb:
        return None, None
    cx = (vb[0] + vb[2]) / 2.0
    drop = max(3, int(round(char_h * 0.05)))        # 7 px at 144 tall
    mouth = {"x": int(round(cx)), "y": vb[3] + drop}
    visor = {"x": vb[0], "y": vb[1], "w": vb[2] - vb[0], "h": vb[3] - vb[1]}
    return mouth, visor


def cycle_px(sampled, k):
    """How far one full cycle of a gait carries her, in output pixels.

    Ported from the game importer's cycle_distance: the furthest her two feet
    get apart along the way she is going is one STEP, and a cycle is two.
    Measured on the side view only, where a stride is not foreshortened. The
    renderer divides its walking speed by this so her feet stay on the ground
    while she paces or runs in.
    """
    longest = 0.0
    for im in sampled:
        box = opaque_box(im)
        if box is None:
            continue
        x0, y0, x1, y1 = box
        lo = y1 - max(2, int((y1 - y0) * 0.12))
        px = im.load()
        xs = [x for y in range(lo, y1) for x in range(x0, x1) if px[x, y][3] > VISIBLE]
        if xs:
            longest = max(longest, max(xs) - min(xs))
    return round(longest * k * 2.0, 1)


def skin_near(im, mouth, w):
    """Average colour of the face just beside the mouth, for the procedural mouth."""
    px = im.load()
    vals = []
    for dx in range(-w, w + 1):
        for dy in (-1, 0, 1):
            x, y = mouth["x"] + dx, mouth["y"] + dy
            if 0 <= x < im.width and 0 <= y < im.height:
                r, g, b, a = px[x, y]
                if a > 200:
                    vals.append((r, g, b))
    if not vals:
        return "#b27259"
    r = sum(v[0] for v in vals) // len(vals)
    g = sum(v[1] for v in vals) // len(vals)
    b = sum(v[2] for v in vals) // len(vals)
    return "#%02x%02x%02x" % (r, g, b)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build(packs, out, frame_px, char_h, feet_y, talk):
    os.makedirs(out, exist_ok=True)
    clips = {}
    rendered = []           # (clip, index, image)
    mouth_w = max(6, int(round(char_h * 0.11)))      # 16 px at 144
    mouth_h = max(4, int(round(char_h * 0.07)))      # 10 px at 144

    idle_transform = None

    for patterns, name, want, fps, kind in CLIPS:
        source = find_source(packs, patterns)
        if source is None:
            print(f"  !! {name}: no source matching {patterns} - skipped")
            continue
        frames = load_frames(source)
        n_src = len(frames)
        note = ""
        period = float(n_src)
        if kind == "cycle":
            frames, period = one_stride(frames, gait=name.startswith(("walk", "run")))
            loop = True
            if period >= n_src:
                note = "no clear cycle - sampled across the whole clip"
            else:
                # even gaps, same cycle time: the count moves, the fps follows
                n_even = even_count(period, want)
                if n_even != want:
                    fps = round(fps * n_even / float(want), 1)
                    note = (note + "; " if note else "") + f"{n_even} frames for even gaps"
                    want = n_even
            idx = pick_loop(len(frames), want, period)
        elif kind == "uncut":
            idx = pick_loop(len(frames), want, float(len(frames)))
            loop = True
        elif kind == "preglow":
            frames, note = before_glow(frames)
            idx = pick(len(frames), want)
            loop = False
        elif kind == "flinch":
            frames, note = after_glow(frames)
            # the recoil is the first part of what is left; sample the front of it
            head = frames[:max(want * 3, min(len(frames), 12))]
            idx = pick(len(head), want)
            frames = head
            loop = False
        else:  # shot
            idx = pick(len(frames), want)
            loop = False

        k, cx, feet = transform_for(frames, frame_px, char_h, feet_y)
        if name == "idle_down":
            idle_transform = (k, cx, feet)
        chosen = [frames[i] for i in idx]
        imgs = [render(f, k, cx, feet, frame_px, feet_y) for f in chosen]
        if kind == "cycle":
            imgs = stabilise(imgs, frame_px)
        clips[name] = {"fps": fps, "loop": loop, "facing": FACING.get(name, "down"),
                       "frames": [], "source": source_name(source),
                       "source_frames": n_src, "kept": [int(i) for i in idx],
                       "stride": round(period, 2) if kind == "cycle" else None}
        if note:
            clips[name]["note"] = note
        if name in ("walk_right", "run_right"):
            clips[name]["cycle_px"] = cycle_px(chosen, k)
        for i, im in enumerate(imgs):
            rendered.append((name, i, im))
        print(f"  {name:16s} {n_src:3d} src -> {len(imgs):2d} frames @ {fps} fps  scale {k:.3f}  {note}")

    # mirrored views come free
    mirrors = {
        "idle_left": "idle_right", "idle_southwest": "idle_southeast",
        "idle_northwest": "idle_northeast",
        "smoke_left": "smoke_right", "smoke_southwest": "smoke_southeast",
        "smoke_northwest": "smoke_northeast",
        "sleep_left": "sleep_right", "sleep_southwest": "sleep_southeast",
        "sleep_northwest": "sleep_northeast",
        "dash_left": "dash_right", "run_left": "run_right", "walk_left": "walk_right",
        "punch_left": "punch_right",
    }
    MIRROR_FACING = {"right": "left", "southeast": "southwest", "northeast": "northwest"}

    # pack: square-ish grid
    n = len(rendered)
    cols = int(n ** 0.5 + 0.999)
    rows = (n + cols - 1) // cols
    atlas = Image.new("RGBA", (cols * frame_px, rows * frame_px), (0, 0, 0, 0))
    for j, (name, i, im) in enumerate(rendered):
        x, y = (j % cols) * frame_px, (j // cols) * frame_px
        atlas.alpha_composite(im, (x, y))
        entry = {"x": x, "y": y}
        if clips[name]["facing"] == "down":
            m, v = mouth_for(im, char_h)
            if m:
                entry["mouth"] = m
                entry["visor"] = v
        clips[name]["frames"].append(entry)

    for alias, base in mirrors.items():
        if base in clips:
            c = dict(clips[base])
            c["mirror_of"] = base
            c["flip"] = True
            c["facing"] = MIRROR_FACING.get(clips[base]["facing"], "left")
            clips[alias] = c

    atlas.save(os.path.join(out, "courier.png"), optimize=True)

    # the face, from the first idle frame
    idle0 = next(im for (nm, i, im) in rendered if nm == "idle_down" and i == 0)
    m0, v0 = mouth_for(idle0, char_h)
    skin = skin_near(idle0, m0, mouth_w // 2) if m0 else "#b27259"

    mouth = {
        "source": "procedural",
        "box": {"w": mouth_w, "h": mouth_h},
        "skin": skin,
        "dark": "#340c16",
        "inner": "#8d0f44",
        "note": "No mouth frames exist in the courier packs; the renderer draws a mouth at each frame's `mouth` anchor. Build with --talk to cut real frames (see SPRITE_GUIDE.md).",
    }

    if talk:
        talk_src = find_source([talk], [os.path.basename(talk.rstrip("/\\"))]) or ("dir", talk)
        strip = cut_mouth(talk_src, idle_transform, frame_px, feet_y, m0, mouth_w, mouth_h, char_h)
        if strip is not None:
            strip.save(os.path.join(out, "mouth.png"), optimize=True)
            mouth = {"source": "mouth.png", "frames": 5, "box": {"w": mouth_w, "h": mouth_h},
                     "skin": skin, "dark": "#340c16", "inner": "#8d0f44"}
            print("  mouth.png written from", talk)

    manifest = {
        "meta": {
            "character": "the Paperless courier (bagless, off duty)",
            "frame": frame_px, "character_height": char_h, "feet_y": feet_y,
            "atlas": "courier.png", "columns": cols, "rows": rows,
            "scaling": "integer nearest-neighbour only",
            "generated_by": "tools/build_sprites.py - do not hand-edit",
            "packs": [os.path.basename(p.rstrip('/\\')) for p in packs],
        },
        "mouth": mouth,
        # What each mood does to her: a gesture at the start of the reply, the
        # aura, and the weather. Read by src/sprite/renderer.js and
        # src/scene/scene.js; the tags themselves are asked for in
        # src/persona.js. Edit here, not in code.
        "moods": {
            # rain: 0..1 base density (the scene scales it by district, state and gusts)
            "calm":       {"gesture": None,     "glow": 1.0,  "breathe": 1.6, "rain": 0.75},
            "happy":      {"gesture": "jump",   "glow": 1.3,  "breathe": 2.3, "rain": 0.50},
            "curious":    {"gesture": "lean",   "glow": 1.1,  "breathe": 1.9, "rain": 0.70},
            "concerned":  {"gesture": "reach",  "glow": 0.7,  "breathe": 1.0, "rain": 1.10},
            "amused":     {"gesture": "bounce", "glow": 1.2,  "breathe": 2.0, "rain": 0.55},
            "excited":    {"gesture": "dash",   "glow": 1.35, "breathe": 2.6, "rain": 0.65},
            "annoyed":    {"gesture": "punch",  "glow": 0.9,  "breathe": 2.2, "rain": 1.00},
            # sass: she walks over and hits a sign, and the sign takes it badly
            "sassy":      {"gesture": "punch_sign", "glow": 1.15, "breathe": 2.4, "rain": 0.80},
            "tired":      {"gesture": "kneel",  "glow": 0.6,  "breathe": 0.9, "rain": 0.75},
            "thoughtful": {"gesture": "drag",   "glow": 0.85, "breathe": 1.3, "rain": 0.85},
        },
        # Sequences of clips. `dur` plays a looping clip for that long, a
        # one-shot plays through; `hold` keeps the last frame (-1 = until the
        # state changes); `dx` moves her that many pixels over the step;
        # `frames` limits a clip to some of its frames; `from`/`to` are x
        # positions ("offleft" = beyond the left edge, "sign" = within reach
        # of the nearer neon sign, 0 = the middle of the street) travelled at
        # the clip's own walking speed (cycle_px); `hit: "sign"` lands the
        # blow on that sign at the clip's contact frame; `min` is a floor on
        # a step's length that survives a state change, and `until:
        # "turn_end"` keeps a step going while she is still thinking or
        # speaking. A gesture that goes to a sign is mirrored (left/right
        # clips swapped) when the sign is on her left.
        "gestures": {
            "jump":     [{"clip": "jump_down"}],
            "bounce":   [{"clip": "jump_down", "fps": 16}],
            "dash":     [{"clip": "dash_right", "dx": 34}, {"clip": "dash_left", "dx": -34}],
            "punch":    [{"clip": "punch_down"}],
            "punch_sign": [{"clip": "walk_right", "to": "sign"}, {"clip": "punch_right", "hit": "sign", "hold": 0.3},
                           {"clip": "idle_right", "dur": 0.45}, {"clip": "walk_left", "to": 0}],
            "reach":    [{"clip": "resonate_down", "hold": 0.7}],
            "lean":     [{"clip": "idle_southeast", "dur": 0.8}, {"clip": "idle_southwest", "dur": 0.8}],
            "kneel":    [{"clip": "sleep_down", "frames": [0, 1], "hold": 1.4}],
            "flinch":   [{"clip": "hurt_down"}],
            "startle":  [{"clip": "hurt_down"}, {"clip": "idle_down", "dur": 0.25}],
            "enter":    [{"clip": "run_right", "from": "offleft", "to": 0}, {"clip": "idle_right", "dur": 0.2}],
            "pace":     [{"clip": "walk_right", "dur": 0.7, "dx": 26}, {"clip": "idle_right", "dur": 0.5},
                         {"clip": "walk_left", "dur": 0.7, "dx": -26}],
            # a drag is never a token gesture: at least three puffs (three
            # loops of the clip), and it goes on while her turn is still going
            "drag":     [{"clip": "smoke_right", "min": 5.2, "until": "turn_end"}],
            "lookaway": [{"clip": "idle_northeast", "dur": 1.6}],
            "lookup":   [{"clip": "idle_up", "dur": 1.5}],
            "glance":   [{"clip": "idle_southeast", "dur": 1.2}],
            "listen_long": [{"clip": "resonate_down", "hold": -1}],
        },
        "states": {
            "idle":        {"clip": "idle_down",   "bob": True,  "blink": True,
                            "fidgets": ["glance", "lookup", "lookaway"], "fidget_every": [12, 25]},
            "idle_long":   {"clips": ["smoke_southeast", "smoke_right", "smoke_southwest", "smoke_left",
                                      "smoke_northeast", "smoke_up", "smoke_northwest"],
                            "after_seconds": 90, "turn_every": [8, 20], "optional": True,
                            "note": "the smoke break; she looks around while she sits it out"},
            "listening":   {"clip": "walk_down",   "fps": 6, "aura": "low",
                            "long_after": 5, "long": "listen_long"},
            "thinking":    {"clip": "idle_right",  "turn_every": 1.2, "particles": True,
                            "fidgets": ["pace", "drag", "lookaway"], "fidget_after": 1.8},
            "speaking":    {"clip": "idle_down",   "mouth": True, "nod_on_sentence": True,
                            "react": "mood"},
            "interrupted": {"clip": "hurt_down",   "then": "listening"},
            "error":       {"clip": "sleep_down",  "hold_last": True, "gesture": "flinch", "strike": True},
            "asleep":      {"clips": [c for c in ("sleep_down", "sleep_right", "sleep_left", "sleep_southeast",
                                                   "sleep_southwest", "sleep_northeast", "sleep_northwest",
                                                   "sleep_up") if c in clips],
                            "after_seconds": 240, "hold_last": True, "optional": True,
                            "note": "a nap, after the smoke break has gone on a while; any speech wakes her"},
        },
        "clips": clips,
    }
    with io.open(os.path.join(out, "courier.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)

    contact(rendered, clips, frame_px, out)
    print(f"\n  atlas {atlas.size[0]}x{atlas.size[1]}  ({n} frames, {len(clips)} clips incl. mirrors)")
    print(f"  mouth anchor (idle_down[0]): {m0}  visor {v0}  skin {skin}")


def contact(rendered, clips, frame_px, out):
    """A review sheet: every frame at 3x with its mouth anchor marked."""
    S = 3
    per_row = 12
    names = [nm for nm in clips if "mirror_of" not in clips[nm]]
    rows = []
    for nm in names:
        fr = [(i, im) for (n2, i, im) in rendered if n2 == nm]
        rows.append((nm, fr))
    H = sum(((len(fr) + per_row - 1) // per_row) for _, fr in rows) * frame_px * S
    W = per_row * frame_px * S
    sheet = Image.new("RGBA", (W, H + 18 * len(rows)), (28, 28, 38, 255))
    d = ImageDraw.Draw(sheet)
    y = 0
    for nm, fr in rows:
        d.text((4, y + 2), f"{nm}  {len(fr)} frames @ {clips[nm]['fps']} fps", fill=(255, 230, 120, 255))
        y += 18
        for j, (i, im) in enumerate(fr):
            x = (j % per_row) * frame_px * S
            yy = y + (j // per_row) * frame_px * S
            big = im.resize((frame_px * S, frame_px * S), Image.NEAREST)
            sheet.alpha_composite(big, (x, yy))
            e = clips[nm]["frames"][i]
            if "mouth" in e:
                mx, my = x + e["mouth"]["x"] * S, yy + e["mouth"]["y"] * S
                d.line([(mx - 6, my), (mx + 6, my)], fill=(255, 0, 255, 255))
                d.line([(mx, my - 6), (mx, my + 6)], fill=(255, 0, 255, 255))
                v = e["visor"]
                d.rectangle([x + v["x"] * S, yy + v["y"] * S, x + (v["x"] + v["w"]) * S, yy + (v["y"] + v["h"]) * S], outline=(0, 255, 0, 160))
        y += ((len(fr) + per_row - 1) // per_row) * frame_px * S
    sheet.save(os.path.join(out, "_contact.png"))


def cut_mouth(talk_source, idle_transform, frame_px, feet_y, anchor, mw, mh, char_h):
    """Five mouth frames from a talking clip, ordered closed -> open.

    The clip must be the courier in the idle-down pose with only the mouth
    moving; it is rendered with the SAME transform as idle_down so the crop
    lands on the same pixels the anchor points at.
    """
    if idle_transform is None or anchor is None:
        print("  !! --talk given but idle_down transform/anchor missing")
        return None
    frames = load_frames(talk_source)
    k, cx, feet = idle_transform
    crops, scores = [], []
    for f in frames:
        im = render(f, k, cx, feet, frame_px, feet_y)
        m, _ = mouth_for(im, char_h)
        m = m or anchor
        box = (m["x"] - mw // 2, m["y"] - mh // 2, m["x"] - mw // 2 + mw, m["y"] - mh // 2 + mh)
        c = im.crop(box)
        px = c.load()
        dark = sum(1 for yy in range(c.height) for xx in range(c.width)
                   if px[xx, yy][3] > 200 and (px[xx, yy][0] + px[xx, yy][1] + px[xx, yy][2]) < 180)
        crops.append(c)
        scores.append(dark)
    order = sorted(range(len(crops)), key=lambda i: scores[i])
    picks = [order[int(round(q * (len(order) - 1)))] for q in (0.0, 0.3, 0.55, 0.8, 1.0)]
    strip = Image.new("RGBA", (mw * 5, mh), (0, 0, 0, 0))
    for j, i in enumerate(picks):
        strip.alpha_composite(crops[i], (j * mw, 0))
    return strip


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", action="append", required=True, help="courier pack folder (repeatable; later wins)")
    ap.add_argument("--out", default="public/assets/sprites/courier")
    ap.add_argument("--frame", type=int, default=160, help="output frame size in px (80 = game-identical)")
    ap.add_argument("--talk", default=None, help="folder of a talking clip to cut mouth.png from")
    a = ap.parse_args()
    char_h = int(round(a.frame * 0.9))          # 144 at 160, 72 at 80
    feet_y = a.frame - 1                        # 159 at 160, 79 at 80
    print(f"building courier atlas: frame {a.frame}, character {char_h} tall, feet on row {feet_y - 1}")
    build(a.pack, a.out, a.frame, char_h, feet_y, a.talk)


if __name__ == "__main__":
    main()
