# Changelog

## main

### ✨ Features and improvements
- _...Add new stuff here..._

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
