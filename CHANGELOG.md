# Changelog

## main

Capture-pose model and editor hooks — the viewer half of a street-view pose /
position editor (proven in production in [MapMax](https://github.com/clement-igonet/mapmax),
issues #98/#106/#107 there). All features are additive; the 0.3.0 API is intact.

### ✨ Features and improvements
- **Full capture pose** (yaw / pitch / roll): the shader's yaw-only
  `uPanoYaw` floats become `uPanoRot`/`uPanoRot2` mat3 uniforms built by the
  new `panoPoseMatrix()`, so a tilted capture can be levelled live, not just
  rotated. `enter()`/`goTo()` targets take optional `panoPitch`/`panoRoll`
  (degrees) next to the existing `panoYaw`; the pose is promoted across walk
  transitions like the yaw always was.
- **`setPanoPose({yaw, pitch, roll})` / `getPanoPose()`**: live pose
  correction of the current panorama; changed components only. Re-schedules
  the HD-tile refresh, since a pose change moves the visible texture regions.
- **Pose rendering maths** (`src/pose.js`, re-exported from the index): pure
  and unit-tested — `panoPoseMatrix` (world→capture-frame mat3, gimbal-safe
  at ±90°), `poseTransform`, `normalizeYaw`. The *editing* algebra
  (`composePoseGesture`, `poseFromMatrix`, …) deliberately lives in
  [maplibre-gl-panoramax](https://github.com/clement-igonet/maplibre-gl-panoramax)
  next to the data source that stores corrections: viewers only render.
- **`setPoseEditDrag(cb)`**: while a callback is set, canvas drags feed it
  `(dxDeg, dyDeg, {x, y, prevX, prevY, shiftKey})` instead of moving the
  camera — the hook an editor UI builds on (compose the gesture with
  maplibre-gl-panoramax, then `setPanoPose`). `null` restores look-around.
- **`groundPointAt(px, py)`**: the floor raycast behind `groundPick`, now
  public — returns (east, north) metres from the eye, or `null` above the
  horizon; enables ground-grab position editing.
- **`setAnchor(lngLat, eyeHeight)`**: re-anchor the current panorama in place
  (position/altitude correction), camera and ground overlays follow.
- **Pose-aware `visibleTiles()`**: accepts a `panoRot` matrix (supersedes
  `panoYawDeg`) so HD tiles follow a pitched/rolled pose exactly like the
  shader; the pole-row special case tracks the pose's up axis instead of the
  world pole.

### Consumer note
Overlay UIs drawn above the WebGL canvas: prefer several small opaque
elements over one large surface, and avoid permanent layer promotion
(`will-change`) — large promoted overlays render unreliably on some
GPU/driver combinations (field report from MapMax).

### 🐞 Bug fixes
- _...Add new stuff here..._

## 0.3.0 — 2026-08-07

Progressive HD tiles. All features are additive; the 0.2.0 API is intact.

### Added
- **Tiled panorama refinement** (`tiles` option on the constructor and on
  `enter()`/`goTo()` targets): `{width, cols, rows, url(col, row)}` describes a
  Panoramax-style tiled HD derivate. The base `imageUrl` still shows first;
  the texture is then re-allocated as a full-panorama atlas (capped by
  `MAX_TEXTURE_SIZE`/8192 — tiles downscale on constrained GPUs) seeded with
  the base image, and the tiles visible from the current camera stream into it
  with `texSubImage2D`. The fragment shader is untouched: it keeps sampling a
  single equirectangular texture, so blending, walk transitions and ground
  overlays work identically on tiled and untiled panoramas.
- **`visibleTiles()`** (exported, pure — `src/tiles.js`): computes the tiles on
  screen from yaw/pitch/FOV/aspect/panoYaw by sampling screen rays through the
  shader's camera basis. Handles the equirectangular seam wrap and adds a full
  pole row when a pole enters the frustum (grid sampling alone can miss
  columns there); priority is the angle to the view direction, ×2 on pole rows
  (mirroring Photo-Sphere-Viewer's equirectangular-tiles-adapter semantics).
- Refinement scheduling: debounced refresh (150 ms) after every look, FOV
  zoom, enter and walk arrival; 4 concurrent downloads, most-central tile
  first; stale in-flight tiles are dropped when the panorama changes. During a
  `goTo()` walk the crossfade runs against the target's base image and
  refinement restarts on arrival (Street-View-style).
- `RULES.md` + `docker-compose.yml`: containerized test (`test`) and demo
  preview (`web`) services; the reference environment is the `ssh maplibre` VM
  (podman compose), see RULES.md.
- The GitHub Pages street-view demo now builds the `tiles` config from the
  Panoramax STAC tiled-assets fields (`tiles:tile_matrix_sets` +
  `asset_templates`), so HD sharpens in place as you look around; it also
  shows the in-sphere ground navigation (blue dots at the adjacent panoramas'
  real positions + walk arrows, click-to-walk via `groundPick`, pointer cursor
  on hover) instead of relying on the HTML buttons alone.

## 0.2.0 — 2026-07-29

Battle-tested in [MapMax](https://github.com/clement-igonet/mapmax) (Panoramax
street view over MapLibre). All features are additive; the 0.1.0 API is intact.

### Added
- **Street-View-style sequence navigation**: `enter(target)` retargets to a
  panorama (`{lngLat, imageUrl, bearing, panoYaw?, roll?, pitch?}`), `goTo(target)`
  walks to an adjacent one with a smooth zoom-crossfade transition (the next
  image preloads into a second texture; the current view magnifies toward the
  travel direction while the next fades in — no teleport pop, and no
  finite-sphere "rear view" artifact). `onMove` callback fires per step.
- **Per-panorama orientation** (`target.panoYaw`): world azimuth the image
  centre faces, when it differs from the look/travel bearing (e.g.
  backward-mounted cameras whose recorded azimuth is the GPS-track direction).
- **In-shader ground navigation**: `setNavArrows([{bearing, id}])` and
  `setNavPois([{east, north, id}])` draw walk arrows and neighbour dots on the
  floor plane inside the panorama layer — they cover the full viewport and are
  never clipped by the map near-plane at grazing pitch. `groundPick(px, py)`
  ray-casts the floor for pointer hit-testing with the same maths.
- **Controls**: `look(dYaw, dPitch)` (keyboard), `zoomFov(dDeg)` (wheel/pinch,
  clamped), one-finger touch look + two-finger pinch FOV.
- **Photo↔vector blending**: `blend(alpha)` sets the steady-state photo opacity
  so vector layers show through.
- **FOV sync**: the map's vertical FOV follows the sphere's while inside (photo
  and vector move at the same rate); restored on exit.
- Equirectangular seam wrap (`REPEAT` horizontal texture wrap), robust layer
  add on already-loaded styles (`isStyleLoaded()`), `walkMs` option.

### Fixed
- Layer never attached when the style was already loaded at construction.
