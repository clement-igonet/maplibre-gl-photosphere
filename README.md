# maplibre-gl-photosphere

Immersive 360° photosphere plugin for [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) (issue [maplibre-gl-js#4428](https://github.com/maplibre/maplibre-gl-js/issues/4428)).

Anchors a spherical panorama photo at a geographic point. Entering blends the panorama over the map while the camera flies to the point at eye height; inside, dragging looks around (the map stays in sync underneath); exiting returns to the map.

## Usage

```js
import {Photosphere} from 'maplibre-gl-photosphere';

const photosphere = new Photosphere(map, {
    lngLat: [2.286828, 48.856625],
    imageUrl: 'panorama.jpg',
    onEnter: () => console.log('inside'),
    onExit: () => console.log('back on the map')
});

photosphere.enter();
photosphere.exit();
photosphere.remove();
```

### Options

| option | default | |
|---|---|---|
| `lngLat` | required | anchor point of the panorama |
| `imageUrl` | required | spherical (equirectangular) panorama image |
| `eyeHeight` | `1.6` | metres above ground while inside |
| `zoom` | `18` | map zoom while inside |
| `radius` | `6` | sphere radius in metres (parallax while entering) |
| `durationMs` | `1500` | enter/exit transition length |
| `dragSensitivity` | `0.15` | degrees per pixel dragged |
| `minPitch` / `maxPitch` | `-85` / `85` | look-pitch limits inside |
| `fov` | `75` | vertical field of view in degrees |
| `exitView` | last outside view | `{center, zoom, pitch, bearing}` to return to |
| `onEnter` / `onExit` | | callbacks |

## How it works

The panorama is a `CustomLayerInterface` shader: each screen pixel is ray-cast (from the current yaw/pitch/FOV) against the photosphere modeled as a finite sphere and samples the texture. There is no 3D mesh. While entering, the eye is still outside the sphere's center, so the ray-sphere intersection gives real parallax; at the center it reduces to plain direction sampling.

While inside, the camera is driven through the public `map.calculateCameraOptionsFromTo()` API so the eye stays pinned at exactly the anchor point and eye height; looking around only rotates the view.

The map needs `maxPitch` above 90 + your `maxPitch` option and `centerClampedToGround: false` for the eye height to apply:

```js
const map = new maplibregl.Map({
    // ...
    minPitch: 5,
    maxPitch: 175,
    centerClampedToGround: false
});
```

## License

BSD-3-Clause
