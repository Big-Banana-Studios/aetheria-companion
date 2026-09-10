# Sprite guide

What the companion draws, where it came from, and the two things the art
packs do not yet contain.

## What exists

`public/assets/sprites/courier/courier.png` is an atlas of 160×160 frames cut
by `tools/build_sprites.py` from two packs: the bagless courier pack
(`top-down-bagless-courier-spritesheet`, AutoSprite output: 49–64 frames of
640×640 per animation per direction, one folder each) and the sleep pack
(`the Courier sleep`, five flat `-v1.json` + `.png` pairs of 56 frames at
768×768). Mira stands 144 px tall with her feet on row 158, which is exactly
twice the game's 80/72/79 framing, so the proportions are the game's and the
face has enough pixels for a mouth. Scaling in the app is integer
nearest-neighbour only.

`public/assets/mira-portrait.png` is her visor-off portrait (from
`mira-portrait.png`, white ground keyed out, kept at native pixel size ×2);
it is the gate-screen hero and the source of the home-screen icons.

`courier.json` maps companion states to clips:

| State | Clip | Notes |
|---|---|---|
| `idle` | `idle_down` 8 f @ 6 fps | one breathing cycle found by self-similarity; ±1 px bob added in code |
| `idle_long` | `smoke_*` 12 f @ 7 fps × 7 directions | the smoke break after 90 s of quiet; she turns every 8–20 s |
| `listening` | `walk_down` 12 f @ 6 fps | one stride, played slowly in place; aura up |
| `thinking` | `idle_right` / `idle_left` 4 f | swapped every 1.2 s; particles orbit the head |
| `speaking` | `idle_down` + mouth | mouth follows output RMS; nod + aura pulse per sentence |
| `interrupted` | `hurt_down` 3 f @ 10 fps | the recoil after the baked-in red flash, then `listening` |
| `error` | `sleep_down` 6 f @ 5 fps | plays once and holds the last frame |
| `asleep` | `sleep_*` 6 f @ 5 fps × 8 directions | the nap, four minutes into a smoke break; one direction at random, holds the last frame, slow breathing bob |

Gestures (played over a state, from `courier.json` → `gestures`):

| Gesture | Clip(s) | Used for |
|---|---|---|
| `jump` / `bounce` | `jump_down` 8 f @ 12 / 16 fps | happy / amused |
| `dash` | `dash_right` 6 f then `dash_left`, ±34 px | excited |
| `punch` | `punch_down` 6 f @ 12 fps | annoyed |
| `punch_sign` | `walk_right` to the sign, `punch_right` (hit at 45 %), `idle_right`, `walk_left` back; mirrored for the left sign | sassy |
| `reach` / `listen_long` | `resonate_down` 4 f, held | concerned / you have talked for 5 s |
| `lean` / `glance` | `idle_southeast`, `idle_southwest` | curious / idle fidget / camera still attached |
| `kneel` | `sleep_down` frames 0–1, held | tired |
| `drag` | `smoke_right`, at least 5.2 s (three puffs) and while her turn lasts | thoughtful / thinking fidget |
| `pace` | `walk_right` 26 px, `idle_right`, `walk_left` back | thinking fidget |
| `lookaway` / `lookup` | `idle_northeast` / `idle_up` | thinking and idle fidgets |
| `flinch` / `startle` | `hurt_down` (recoil frames) | interrupted, error, woken from a nap |
| `enter` | `run_right` from off-screen left at the measured run speed | app start |
| `stroll` (generated) | `walk_right`/`walk_left` edge to edge at an easy gait (the walk clip at 10 fps, the travel time scaled to match), a `smoke_right`/`smoke_left` stop partway about half the time, a look back or up at each edge, then back to the middle | quiet for 35–70 s in idle, 25–50 s into a smoke break; the numbers are `gestures.stroll` in the manifest, the steps are made fresh each time by `renderer._strollSteps` |
| travel (built in) | `walk_right`/`walk_left` off the edge, the street switches, walk back in to the middle | the conversation's depth changed district |

Where she stands: the bottom 24 % of the screen is road (`groundY` is the
kerb, where the buildings end) and her feet are 55 % of the way down it
(`standY`), so she is on the street rather than on the building line, with
road below her for the reflection. The near signs hang at her fist height
measured from `standY`, so the sign punch still connects.

Walking speed comes from `cycle_px` measured on the side-view clips (the
game importer's method): one stride's foot spread, doubled, scaled.

Every down-facing frame carries a `visor` box and a `mouth` anchor, both
measured by the tool: the visor is the cyan band (the same test the game
uses), the mouth is centred under it, 7 px down. For `idle_down[0]` they are:

```
visor  x=71 y=33 w=17 h=4
mouth  x=80 y=44         (the lip line, centre)
box    16 × 10           (the overlay's size)
```

## What is still needed

### 1. Mouth overlay (5 frames, 16×10 px each at the 160 frame)

The walk/idle sheets have a closed mouth only. Until real frames exist the app
draws a procedural mouth at the anchor (a dark opening that grows downward,
inner colour `#8d0f44`, corners softened with the sampled skin `#86473f`).

To replace it in one AutoSprite pass:

1. Generate **one animation**: the courier in the `iso_idle_down` pose,
   facing the camera, **only the mouth moving** — closed → slightly open →
   open → wide → round "oh". Same prompt, same seed and reference as the
   bagless pack. Any frame count; 24–64 is fine. Export it exactly like the
   other folders (`frames/0001.png…` at 640×640, or `atlas.json` +
   `spritesheet.png`).
2. Run:
   ```
   python tools/build_sprites.py --pack "../top-down-bagless-courier-spritesheet" \
       --out public/assets/sprites/courier --talk "../<talk pack>/iso_talk_down"
   ```
   The tool renders the talking clip with the **same transform** as
   `idle_down`, crops the 16×10 box at the mouth anchor in every frame, ranks
   the crops by how much dark opening they show, picks five spread from
   closed to wide, and writes `mouth.png` (80×10, five cells). The manifest
   then points at it and the renderer uses it instead of the procedural mouth.

If the mouth drifts because the head moves in the talk clip, the tool re-finds
the visor per frame and re-centres the crop, so a little head motion is fine.

### 2. Flinch pose (optional)

`hurt_down` works as the interrupted flinch, but its first usable frames sit
after a red hit-flash the generator baked into the clip, so there is only a
three-frame recoil to use. A dedicated clip would be better:

- `iso_flinch_down`: the courier facing the camera, a short startle — head
  back, shoulders up, one hand half-raised — settling back to idle. 16–32
  frames, no lighting change, no colour flash. Add it to `CLIPS` in
  `tools/build_sprites.py` as `(["iso_flinch_down"], "hurt_down", 3, 10, "shot")`.

### 3. A front-facing smoke (optional)

The packs draw the smoke break in northeast, right, southeast and up only.
That is fine — she looks around while she sits it out — but a `smoking Down`
clip would let her smoke while looking at you. Same format, 49–64 frames,
add `(["smoking down"], "smoke_down", 12, 7, "uncut")` to `CLIPS` and
`"smoke_down"` to the `idle_long` list.

## Rebuilding

```
npm run sprites
# = python tools/build_sprites.py --pack "../top-down-bagless-courier-spritesheet" \
#       --pack "../the Courier sleep" --out public/assets/sprites/courier
```

`--pack` may be repeated; later packs win, so a corrected animation can be
dropped in beside the original. `--frame 80` gives a game-identical build.
The tool also writes `_contact.png` (every frame at 3× with anchors marked)
and the review script in the README writes `_review.png`; both are
git-ignored.
