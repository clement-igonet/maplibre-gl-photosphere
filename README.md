# maplibre-gl-photosphere

[![npm](https://img.shields.io/npm/v/maplibre-gl-photosphere)](https://www.npmjs.com/package/maplibre-gl-photosphere)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

Step off the map, into the street. An immersive 360° photosphere plugin for
[MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)
(issue [maplibre-gl-js#4428](https://github.com/maplibre/maplibre-gl-js/issues/4428)):
the panorama is rendered **inside** the map — one camera, one projection — so
vector layers blend into the photo, navigation arrows lie on the actual street,
and walking to the next panorama is a continuous move, not a teleport.

No three.js. No dependencies. One custom layer, one fragment shader.

## 🎬 Try it (30 seconds)

**[▶ Street View demo](https://clement-igonet.github.io/maplibre-gl-photosphere/docs/street-view.html)** —
a real [Panoramax](https://panoramax.fr) sequence in Paris:

1. Click a point on the blue route — the camera flies down to eye level as the
   photo fades in around you.
2. Drag to look around — **HD tiles sharpen exactly where you look**.
3. Click the white arrow (or blue dot) on the street to walk forward —
   Street-View-style dolly, no hard cut.

**[▶ Minimal demo](https://clement-igonet.github.io/maplibre-gl-photosphere/docs/)** —
one panorama, one `enter()` call, view-source-friendly.

## Install

```sh
npm install maplibre-gl-photosphere
```

Or without a bundler — it's plain ES modules:

```html
<script type="importmap">
    {
        "imports": {
            "maplibre-gl": "https://esm.sh/maplibre-gl@5",
            "maplibre-gl-photosphere": "https://unpkg.com/maplibre-gl-photosphere/src/index.js"
        }
    }
</script>
```

## Quick start

```js
import {Photosphere} from 'maplibre-gl-photosphere';

const map = new maplibregl.Map({
    container: 'map',
    style: yourStyle,
    minPitch: 5,
    maxPitch: 175,                  // the eye must be able to look level
    centerClampedToGround: false    // ...from eye height above the ground
});

const photosphere = new Photosphere(map, {
    lngLat: [2.286828, 48.856625],
    imageUrl: 'panorama.jpg',       // equirectangular 360° image
    onEnter: () => console.log('inside'),
    onExit: () => console.log('back on the map')
});

photosphere.enter();                // fly in
photosphere.exit();                 // fly back out
```

## Street-View navigation

`enter(target)` and `goTo(target)` take a panorama descriptor, so a sequence of
geolocated pictures becomes a walkable street:

```js
const pano = {
    lngLat: [lng, lat],
    imageUrl: 'sd.jpg',
    bearing: 143,                   // world azimuth to face on arrival
    tiles: {…}                      // optional HD refinement, see below
};

photosphere.enter(pano);            // step in here
photosphere.goTo(nextPano);         // walk there: preload + dolly + crossfade

// Draw navigation on the street itself (in-shader — never clipped, any pitch):
photosphere.setNavArrows([{bearing: 143, id: 'next'}]);          // walk arrows
photosphere.setNavPois([{east: 3.1, north: 9.4, id: 'next'}]);   // floor dots (m from eye)
photosphere.groundPick(px, py);     // which arrow/dot is under this pixel?
```

## Progressive HD tiles

Panoramax-style tiled derivates refine the panorama in place: the base
`imageUrl` shows instantly, then the tiles visible from the current camera
stream in, most-central first, as you look around.

```js
photosphere.enter({
    lngLat, imageUrl, bearing,
    tiles: {
        width: 5640,                // full panorama width in px (height = width / 2)
        cols: 8, rows: 4,           // tile grid
        url: (col, row) => `…/tiled/${col}_${row}.jpg`
    }
});
```

The texture becomes a full-panorama atlas (capped by the GPU's
`MAX_TEXTURE_SIZE`, tiles downscale beyond it) seeded with the base image, and
tiles `texSubImage2D` into it — the shader still samples one equirectangular
texture, so blending, transitions and ground overlays are unaffected. The
visible-tile maths (seam wrap, pole rows, angle-based priority) is exported as
[`visibleTiles()`](src/tiles.js), pure and testable without WebGL.
With Panoramax, build this straight from the STAC item's
`tiles:tile_matrix_sets` + `asset_templates` fields — see
[docs/street-view.html](docs/street-view.html) for the ten lines.

## Mix photo and vector

Because photo and map share one camera, you can dial the photo's opacity and
let the vector world (3D buildings, roads, labels) shine through — aligned
with reality:

```js
photosphere.blend(0.5);             // 1 = photo only … 0 = vector only
photosphere.look(5, 0);             // keyboard-style look (deg yaw, pitch)
photosphere.zoomFov(-5);            // FOV zoom (wheel / pinch built in too)
```

## API

| method | |
|---|---|
| `enter(target?)` | fly in (optionally retargeting to a panorama descriptor) |
| `goTo(target)` | walk to an adjacent panorama with a smooth transition |
| `exit()` | fly back to the map (`exitView` or the last outside view) |
| `blend(alpha)` | steady-state photo opacity over the vector layers |
| `look(dYaw, dPitch)` / `zoomFov(dDeg)` | programmatic look / FOV zoom |
| `setNavArrows(list)` / `setNavPois(list)` | ground arrows / neighbour dots |
| `groundPick(px, py)` | id of the arrow/dot under a screen pixel, or `null` |
| `setPanoPose({yaw, pitch, roll})` / `getPanoPose()` | live capture-pose rendering (0.4.0) |
| `setPoseEditDrag(cb)` | neutral hook: route canvas drags to external tools (0.4.0) |
| `groundPointAt(px, py)` | floor raycast → (east, north) metres, or `null` (0.4.0) |
| `setAnchor(lngLat, eyeHeight?)` | re-anchor the current panorama in place (0.4.0) |
| `mode` / `yaw` / `pitch` / `lngLat` | current state (getters) |
| `remove()` | detach the layer and listeners |

Targets for `enter()`/`goTo()` accept `panoPitch`/`panoRoll` (degrees) next to
`panoYaw` — the plugin *renders* corrected poses from any imagery source, but
deliberately ships **no editor**: gesture algebra and write-back live in
[maplibre-gl-panoramax](https://github.com/clement-igonet/maplibre-gl-panoramax).

### Options

| option | default | |
|---|---|---|
| `lngLat` | required | anchor point of the panorama |
| `imageUrl` | required | spherical (equirectangular) panorama image |
| `tiles` | | tiled HD derivate for progressive refinement |
| `eyeHeight` | `1.6` | metres above ground while inside |
| `zoom` | `18` | map zoom while inside |
| `radius` | `6` | sphere radius in metres (parallax while entering) |
| `durationMs` | `1500` | enter/exit transition length |
| `walkMs` | `650` | goTo() walk transition length |
| `dragSensitivity` | `0.15` | degrees per pixel dragged |
| `minPitch` / `maxPitch` | `-85` / `85` | look-pitch limits inside |
| `fov` | `75` | vertical field of view in degrees |
| `exitView` | last outside view | `{center, zoom, pitch, bearing}` to return to |
| `onEnter` / `onExit` / `onMove` | | callbacks |

## How it works

The panorama is a `CustomLayerInterface` shader: each screen pixel is ray-cast
(from the current yaw/pitch/FOV) against the photosphere modeled as a finite
sphere and samples the equirectangular texture. There is no 3D mesh. While
entering, the eye is still outside the sphere's center, so the ray-sphere
intersection gives real parallax; at the center it reduces to plain direction
sampling.

While inside, the camera is driven through the public
`map.calculateCameraOptionsFromTo()` API so the eye stays pinned at exactly
the anchor point and eye height; looking around only rotates the view — which
is what keeps photo and vector locked together at any FOV.

## Development

Tests and previews run in containers (see [RULES.md](RULES.md)):

```sh
podman compose run --rm test    # vitest suite (docker compose works too)
podman compose up -d web        # demo preview on 127.0.0.1:8090
```

Used in the wild by [MapMax](https://github.com/clement-igonet/mapmax),
a full Panoramax street-view app built on this plugin.

## License

BSD-3-Clause
