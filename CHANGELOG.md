# Changelog

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
