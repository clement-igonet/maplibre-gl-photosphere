// maplibre-gl-photosphere — immersive 360° photosphere plugin for MapLibre GL JS.
//
// The layer renders through MapLibre's CustomLayerInterface: a full-screen
// fragment shader ray-casts each pixel against a finite sphere centered on the
// anchor and samples the equirectangular texture. Includes Street-View-style
// sequence navigation (enter/goTo with a smooth zoom-crossfade walk), keyboard/
// touch look + FOV zoom, photo↔vector blending, in-shader ground navigation
// arrows and neighbour dots (never clipped by the map near plane), and
// per-panorama orientation (heading yaw offset for panoramas whose image centre
// does not face their recorded azimuth). Panoramas with a tiled HD derivate
// (Panoramax-style col/row grids) refine progressively: the texture becomes a
// full-panorama atlas seeded with the base image and visible tiles stream in.
import { MercatorCoordinate } from 'maplibre-gl';
import { visibleTiles } from './tiles.js';
import { panoPoseMatrix } from './pose.js';

export * from './pose.js';

export { visibleTiles };

const VERTEX_SHADER_SOURCE = `
    attribute vec2 aPosition;
    varying vec2 vNdc;
    void main() {
        vNdc = aPosition;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`;

const TILE_CONCURRENCY = 4; // parallel tile downloads while refining
const TILE_REFRESH_MS = 150; // debounce between look/zoom and a tile refresh
const ATLAS_MAX = 8192; // atlas width cap (px) — beyond this, tiles downscale

const MAX_ARROWS = 6;
const ARROW_GROUND_DIST = 5; // where a ground arrow sits, from the eye (m)
const MAX_POIS = 12;
const POI_RADIUS_M = 0.85; // ground radius of a neighbour-panorama dot (m)
const POI_PICK_RADIUS_M = 1.1;
const FRAGMENT_SHADER_SOURCE = `
    precision highp float;
    varying vec2 vNdc;
    uniform float uYaw;
    uniform float uPitch;
    uniform float uFovY;
    uniform float uAspect;
    uniform float uAlpha;
    uniform vec3 uSphereCenterOffset;
    uniform float uSphereRadius;
    uniform sampler2D uPanorama;
    // Second sphere + crossfade weight, used only while walking between two
    // panoramas so the camera dollies across instead of teleporting (#5b).
    uniform vec3 uSphereCenterOffset2;
    uniform sampler2D uPanorama2;
    uniform float uMix;            // 0 = current pano only, 1 = next pano only
    uniform mat3 uPanoRot;         // world→camera capture pose of the current image (yaw + pitch/roll)
    uniform mat3 uPanoRot2;        // ...and the next image's, during a walk
    uniform vec2 uWalkDir;         // unit horizontal travel direction (east, north) during a walk (#64)
    uniform float uEyeHeight;      // eye height above the ground (m)
    uniform int uArrowCount;
    uniform vec2 uArrows[${MAX_ARROWS}]; // ground positions (east, north) m from the eye
    uniform int uPoiCount;
    uniform vec2 uPois[${MAX_POIS}];     // neighbour-pano ground positions (east, north) m
    uniform vec3 uPoiColors[${MAX_POIS}]; // per-dot disc color (default blue)

    // Ray-cast one panorama sphere; returns rgb + hit-alpha (a = 0 on a miss).
    // panoRot is the world→camera rotation of the capture pose (yaw from the
    // image-centre azimuth, plus pitch/roll — built by panoPoseMatrix): applying
    // it to the hit direction expresses it in the capture-camera frame, aligning
    // the photo to the world and levelling a tilted capture.
    vec4 sampleSphere(vec3 viewDir, vec3 centerOffset, sampler2D tex, mat3 panoRot) {
        vec3 originToCenter = -centerOffset;
        float b = dot(originToCenter, viewDir);
        float c = dot(originToCenter, originToCenter) - uSphereRadius * uSphereRadius;
        float discriminant = b * b - c;
        if (discriminant < 0.0) return vec4(0.0);
        float sq = sqrt(discriminant);
        float tNear = -b - sq;
        float tFar = -b + sq;
        float t = tNear > 0.0 ? tNear : tFar;
        if (t < 0.0) return vec4(0.0);
        vec3 normal = normalize(viewDir * t - centerOffset);
        vec3 nc = panoRot * normal;   // world dir → capture-camera frame
        float theta = atan(nc.x, nc.y);
        float phi = asin(clamp(nc.z, -1.0, 1.0));
        vec4 color = texture2D(tex, vec2(0.5 + theta / (2.0 * 3.14159265359), 0.5 - phi / 3.14159265359));
        return vec4(color.rgb, color.a);
    }

    // A filled arrowhead in the arrow's local frame (x = right, y = forward),
    // tapering from a base to a tip that points toward the target.
    float arrowMask(vec2 lp) {
        float base = -0.7, tip = 1.7, halfW = 1.15;
        if (lp.y < base || lp.y > tip) return 0.0;
        float f = (lp.y - base) / (tip - base);         // 0 at base .. 1 at tip
        float w = halfW * (1.0 - f);                     // taper to a point
        return abs(lp.x) < w ? 1.0 : 0.0;
    }

    void main() {
        float tanHalfFovY = tan(uFovY * 0.5);
        float tanHalfFovX = tanHalfFovY * uAspect;

        vec3 forward = vec3(cos(uPitch) * sin(uYaw), cos(uPitch) * cos(uYaw), sin(uPitch));
        vec3 worldUp = vec3(0.0, 0.0, 1.0);
        vec3 right = normalize(cross(forward, worldUp));
        vec3 up = cross(right, forward);

        vec3 viewDir = normalize(forward + right * (vNdc.x * tanHalfFovX) + up * (vNdc.y * tanHalfFovY));

        // Base colour: the panorama sphere. While walking (uMix > 0) the next
        // panorama cross-fades in. Both panos are sampled DIRECTION-ONLY during
        // the walk — ray-casting finite spheres from a moving eye shows the
        // destination sphere's near surface, i.e. its REAR view, which made
        // walking forward look like moving backward (#64). The forward cue is a
        // directional zoom instead: the current pano magnifies toward the travel
        // direction while the next starts slightly wide and settles to 1:1
        // (Street-View-style); the map camera still dollies for vector parallax.
        vec3 rgb;
        float a;
        if (uMix > 0.0) {
            vec3 wd = vec3(uWalkDir.x, uWalkDir.y, 0.0);
            vec3 d1 = normalize(viewDir + wd * (0.85 * uMix));         // zoom in, growing
            vec3 d2 = normalize(viewDir - wd * (0.30 * (1.0 - uMix))); // settle from wide
            vec4 s1 = sampleSphere(d1, vec3(0.0), uPanorama, uPanoRot);
            vec4 s2 = sampleSphere(d2, vec3(0.0), uPanorama2, uPanoRot2);
            rgb = mix(s1.rgb, s2.rgb, uMix);
            a = mix(s1.a, s2.a, uMix) * uAlpha;
        } else {
            vec4 s1 = sampleSphere(viewDir, uSphereCenterOffset, uPanorama, uPanoRot);
            rgb = s1.rgb;
            a = s1.a * uAlpha;
        }

        // Ground navigation overlays, drawn on the floor plane at z = -uEyeHeight.
        // Rendered here (in the panorama layer) they cover the whole viewport and
        // are never clipped by MapLibre's map-plane near clip (mapmax #26, #39).
        if (viewDir.z < -0.0001 && (uArrowCount > 0 || uPoiCount > 0)) {
            float tg = -uEyeHeight / viewDir.z;
            vec2 g = viewDir.xy * tg;                    // ground point (east, north) m

            // Neighbour-panorama dots at their real ground position: a blue disc
            // with a white rim. Round and flat on the street — never the cropped,
            // blown-up blobs a map-plane circle layer gives at grazing pitch.
            for (int i = 0; i < ${MAX_POIS}; i++) {
                if (i >= uPoiCount) break;
                float d = length(g - uPois[i]);
                if (d < ${POI_RADIUS_M.toFixed(2)}) {
                    rgb = mix(rgb, uPoiColors[i], 0.9);
                    a = max(a, 0.9);
                } else if (d < ${(POI_RADIUS_M + 0.16).toFixed(2)}) {
                    rgb = mix(rgb, vec3(1.0), 0.9);      // white rim
                    a = max(a, 0.9);
                }
            }

            // Walk arrows, on top of the dots.
            float mask = 0.0;
            for (int i = 0; i < ${MAX_ARROWS}; i++) {
                if (i >= uArrowCount) break;
                vec2 ap = uArrows[i];
                if (dot(ap, ap) < 1e-4) continue;
                vec2 fwd = normalize(ap);
                vec2 rgt = vec2(fwd.y, -fwd.x);
                vec2 d = g - ap;
                mask = max(mask, arrowMask(vec2(dot(d, rgt), dot(d, fwd))));
            }
            if (mask > 0.0) {
                rgb = mix(rgb, vec3(1.0), 0.85);         // white arrow over the photo
                a = max(a, 0.85);                        // always visible, any blend
            }
        }

        if (a <= 0.0) discard;
        gl_FragColor = vec4(rgb, a);
    }
`;

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
}

const DEFAULT_OPTIONS = {
    eyeHeight: 1.6,
    zoom: 18,
    radius: 6,
    durationMs: 1500,
    walkMs: 650, // dolly time when walking to an adjacent panorama (#5b)
    dragSensitivity: 0.15,
    minPitch: -85,
    maxPitch: 85,
    fov: 75
};

/**
 * An immersive 360° photosphere anchored at a geographic point, rendered
 * through MapLibre's CustomLayerInterface. Supports Street-View-style sequence
 * navigation via enter(target) / goTo(target).
 */
export class Photosphere {
    constructor(map, options) {
        if (!options || !options.lngLat || !options.imageUrl) {
            throw new Error('Photosphere requires lngLat and imageUrl options');
        }
        this._map = map;
        this._options = { ...DEFAULT_OPTIONS, ...options };
        this._mode = 'outside';
        this._yawDeg = 0;
        this._pitchDeg = 0;
        this._dragging = false;
        this._lookTargetDistanceMetres = 1;
        this._opacity = 0;
        this._blend = 1; // steady-state opacity while inside (1 = photo only)
        this._savedFov = null; // map's vertical FOV before entering
        this._navArrows = []; // [{ bearing (deg), id }] rendered on the floor
        this._navPois = []; //   [{ east, north (m from eye), id, color? }] floor dots
        this._sphereCenterOffset = [0, 0, 0];
        this._sphereCenterOffset2 = [0, 0, 0]; // next pano while walking (#5b)
        this._mix = 0; // crossfade weight during a walk transition
        this._transitioning = false;
        this._panoYawDeg = 0; //  world azimuth the current image centre faces (#52)
        this._panoYawDeg2 = 0; // ...the next image's, during a walk
        this._panoPitchDeg = 0; // capture pose correction: pitch/roll
        this._panoRollDeg = 0;
        this._panoPitchDeg2 = 0; // ...the next image's, during a walk
        this._panoRollDeg2 = 0;
        this._walkDir = [0, 0]; // unit (east, north) travel direction during a walk (#64)
        this._gl = null;
        this._layerCtx = null;
        // Progressive HD tiles: {width, cols, rows, url(col, row)} per panorama.
        // The current texture becomes a full-panorama atlas seeded with the base
        // image; visible tiles then texSubImage2D into it (v0.3.0).
        this._tiles = this._options.tiles || null;
        this._tilesNext = null; // the walk target's tiles config, adopted on arrival
        this._tileState = null; // {tiles, scale, loaded, inflight, queue} for the current atlas
        this._tileEpoch = 0; // bumps on every pano/atlas change; stale loads check it
        this._tileTimer = null;

        this._layer = this._createLayer();
        // MapLibre 6's internal `map.style` is not a truthy public property, so
        // the old `map.style && map.loaded()` guard fell through to a 'load'
        // listener that never fires when the style is already loaded — leaving
        // the custom layer unadded (onAdd never runs, textures never load).
        // Use the public isStyleLoaded() and add immediately when ready.
        const addLayer = () => {
            if (!map.getLayer(this._layer.id)) map.addLayer(this._layer);
        };
        if (map.isStyleLoaded()) {
            addLayer();
        } else {
            map.once('load', addLayer);
            map.once('styledata', addLayer);
        }

        this._pinchDist = 0;
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onTouchStart = this._onTouchStart.bind(this);
        this._onTouchMove = this._onTouchMove.bind(this);
        this._onTouchEnd = this._onTouchEnd.bind(this);
        const container = map.getContainer();
        container.addEventListener('mousedown', this._onMouseDown);
        addEventListener('mousemove', this._onMouseMove);
        addEventListener('mouseup', this._onMouseUp);
        container.addEventListener('touchstart', this._onTouchStart, { passive: false });
        container.addEventListener('touchmove', this._onTouchMove, { passive: false });
        container.addEventListener('touchend', this._onTouchEnd);
    }

    get mode() {
        return this._mode;
    }

    get lngLat() {
        return this._options.lngLat;
    }

    // Steady-state photo opacity while inside — lets vector layers behind the
    // sphere show through for photo↔mixed↔vector blending (mapmax #6).
    blend(alpha) {
        this._blend = Math.max(0, Math.min(1, alpha));
        this._map.triggerRepaint();
    }

    get yaw() { return this._yawDeg; }
    get pitch() { return this._pitchDeg; }

    // Live capture-pose correction of the CURRENT panorama: yaw = world azimuth
    // of the image centre, pitch/roll = capture tilt to undo. Only the
    // components provided are changed. Re-schedules the HD-tile refresh — a
    // pose change moves which texture regions are on screen.
    setPanoPose({ yaw, pitch, roll } = {}) {
        if (typeof yaw === 'number') this._panoYawDeg = yaw;
        if (typeof pitch === 'number') this._panoPitchDeg = pitch;
        if (typeof roll === 'number') this._panoRollDeg = roll;
        this._scheduleTileRefresh();
        this._map.triggerRepaint();
    }

    getPanoPose() {
        return { yaw: this._panoYawDeg, pitch: this._panoPitchDeg, roll: this._panoRollDeg };
    }

    // Neutral input-routing hook: while a callback is set, canvas drags feed
    // it (dxDeg, dyDeg, {x, y, prevX, prevY, shiftKey}) instead of moving the
    // camera. The plugin itself ships NO editing — this is the attachment
    // point for external tools (pose editors like maplibre-gl-panoramax's,
    // measurement, annotation…). null restores normal look-around.
    setPoseEditDrag(cb) {
        this._poseEditDrag = typeof cb === 'function' ? cb : null;
    }

    // Move the anchor (and optionally the eye height) of the CURRENT panorama
    // in place — position-correction editing.
    setAnchor(lngLat, eyeHeight) {
        if (Array.isArray(lngLat)) this._options.lngLat = lngLat;
        if (typeof eyeHeight === 'number' && Number.isFinite(eyeHeight)) {
            this._options.eyeHeight = Math.max(0.2, eyeHeight);
        }
        if (this._mode === 'inside') {
            this._recalibrateLookTargetDistance();
            this._updateCameraWhileInside();
        }
        this._map.triggerRepaint();
    }

    // Ground point (east, north) metres from the eye under screen pixel
    // (px, py), or null above the horizon — the floor raycast shared by
    // groundPick and position-editing drags.
    groundPointAt(px, py) {
        const canvas = this._map.getCanvas();
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const ndcX = (px / w) * 2 - 1;
        const ndcY = 1 - (py / h) * 2;
        const tanY = Math.tan((this._options.fov * Math.PI / 180) / 2);
        const tanX = tanY * (w / h);
        const yaw = this._yawDeg * Math.PI / 180;
        const pitch = this._pitchDeg * Math.PI / 180;
        const forward = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
        const right = normalize3(cross3(forward, [0, 0, 1]));
        const up = cross3(right, forward);
        const vd = normalize3([
            forward[0] + right[0] * ndcX * tanX + up[0] * ndcY * tanY,
            forward[1] + right[1] * ndcX * tanX + up[1] * ndcY * tanY,
            forward[2] + right[2] * ndcX * tanX + up[2] * ndcY * tanY,
        ]);
        if (vd[2] >= -1e-4) return null; // not looking at the floor
        const t = -this._options.eyeHeight / vd[2];
        return [vd[0] * t, vd[1] * t];
    }

    // Ground navigation arrows rendered inside the panorama layer (mapmax #26).
    // `list` = [{ bearing (deg toward the target), id }].
    setNavArrows(list) {
        this._navArrows = Array.isArray(list) ? list.slice(0, MAX_ARROWS) : [];
        this._map.triggerRepaint();
    }

    // Neighbour-panorama dots rendered on the floor (mapmax #39).
    // `list` = [{ east, north (m from the eye), id, color? }] where `color` is
    // an optional [r, g, b] (0..1) per dot — lets callers keep one color
    // language across map and immersive view (e.g. per imagery source);
    // omitted → the historical blue.
    setNavPois(list) {
        this._navPois = Array.isArray(list) ? list.slice(0, MAX_POIS) : [];
        this._map.triggerRepaint();
    }

    // The id of the arrow or POI dot under screen pixel (px, py), or null. Ray-
    // casts the floor with the same view maths as the shader (works at any pitch).
    groundPick(px, py) {
        const g = this.groundPointAt(px, py);
        if (!g) return null;
        for (const a of this._navArrows) {
            const br = a.bearing * Math.PI / 180;
            const ap = [ARROW_GROUND_DIST * Math.sin(br), ARROW_GROUND_DIST * Math.cos(br)];
            const len = Math.hypot(ap[0], ap[1]) || 1;
            const fwd = [ap[0] / len, ap[1] / len];
            const rgt = [fwd[1], -fwd[0]];
            const d = [g[0] - ap[0], g[1] - ap[1]];
            const ly = d[0] * fwd[0] + d[1] * fwd[1];
            const lx = d[0] * rgt[0] + d[1] * rgt[1];
            const base = -0.7, tip = 1.7, halfW = 1.15;
            if (ly > base && ly < tip && Math.abs(lx) < halfW * (1 - (ly - base) / (tip - base))) {
                return a.id;
            }
        }
        for (const p of this._navPois) {
            if (Math.hypot(g[0] - p.east, g[1] - p.north) < POI_PICK_RADIUS_M) return p.id;
        }
        return null;
    }

    // Look around by a delta (degrees) — drives keyboard / touch controls
    // outside the built-in mouse drag (mapmax #7).
    look(deltaYawDeg, deltaPitchDeg) {
        if (this._mode !== 'inside') return;
        const { minPitch, maxPitch } = this._options;
        this._yawDeg = (this._yawDeg + deltaYawDeg + 360) % 360;
        this._pitchDeg = Math.max(minPitch, Math.min(maxPitch, this._pitchDeg + deltaPitchDeg));
        this._updateCameraWhileInside();
        this._scheduleTileRefresh();
        this._map.triggerRepaint();
    }

    // Field-of-view zoom (degrees), clamped — scroll wheel / pinch (mapmax #7).
    zoomFov(deltaDeg) {
        this._options.fov = Math.max(25, Math.min(100, this._options.fov + deltaDeg));
        this._applyMapFov();
        if (this._mode === 'inside') {
            this._recalibrateLookTargetDistance();
            this._updateCameraWhileInside();
            this._scheduleTileRefresh();
        }
        this._map.triggerRepaint();
    }

    // Keep MapLibre's vertical FOV equal to the sphere shader's FOV so the photo
    // and the vector layers move at the same rate — no desync (mapmax #24).
    _applyMapFov() {
        const map = this._map;
        if (typeof map.setVerticalFieldOfView === 'function') {
            map.setVerticalFieldOfView(this._options.fov);
        } else if (map.transform) {
            map.transform.fov = this._options.fov;
        }
    }

    // Enter the photosphere. Optional target = {lngLat, imageUrl, bearing}
    // retargets to a specific panorama first (used for street-view sequences).
    enter(target) {
        if (this._mode !== 'outside') {
            return;
        }
        if (target) {
            if (target.lngLat) this._options.lngLat = target.lngLat;
            if (target.imageUrl) {
                this._options.imageUrl = target.imageUrl;
                this._tiles = target.tiles || null;
                this._tileState = null;
                this._tileEpoch++;
                this._loadTexture(target.imageUrl);
            }
        }
        this._mode = 'entering';
        for (const handler of this._interactionHandlers()) {
            handler.disable();
        }
        // Match the map's vertical FOV to the sphere's so photo and vector move
        // together (mapmax #24). Do it before recalibrating (which reads the fov).
        if (typeof this._map.getVerticalFieldOfView === 'function') {
            this._savedFov = this._map.getVerticalFieldOfView();
        }
        this._applyMapFov();
        // Start looking toward the picture's heading, if provided. That heading
        // is also the world azimuth the image centre faces, so the shader rotates
        // the texture by it to align the photo with the vector world (#52).
        const heading = target && typeof target.bearing === 'number' ? target.bearing : 0;
        this._yawDeg = heading;
        // The image centre's world azimuth may differ from the look/travel
        // heading (backward-mounted cameras, sun-compass corrected — #66).
        this._panoYawDeg = (target && typeof target.panoYaw === 'number') ? target.panoYaw : heading;
        this._panoPitchDeg = (target && typeof target.panoPitch === 'number') ? target.panoPitch : 0;
        this._panoRollDeg = (target && typeof target.panoRoll === 'number') ? target.panoRoll : 0;
        this._pitchDeg = 0;
        this._recalibrateLookTargetDistance();
        const { lngLat, zoom, eyeHeight, onEnter } = this._options;
        this._animate({ center: lngLat, zoom, pitch: 90, bearing: this._yawDeg }, eyeHeight, 1, () => {
            this._mode = 'inside';
            this._updateCameraWhileInside();
            this._scheduleTileRefresh();
            if (onEnter) onEnter();
        });
    }

    // Walk to an adjacent panorama while inside. Preloads the next equirectangular
    // image into the second texture, then dollies the eye from the current anchor
    // to the target while cross-fading the two spheres — a smooth translation,
    // not a teleport (#5b). Preserves the current look direction. Fires onMove.
    goTo(target) {
        if (this._mode !== 'inside' || this._transitioning || !target || !target.imageUrl) {
            return;
        }
        const fromAnchor = this._options.lngLat;
        const toAnchor = target.lngLat || fromAnchor;
        // Orient the next sphere by its own heading during the crossfade (#52).
        this._panoYawDeg2 = typeof target.panoYaw === 'number' ? target.panoYaw
            : typeof target.bearing === 'number' ? target.bearing : this._panoYawDeg;
        this._panoPitchDeg2 = typeof target.panoPitch === 'number' ? target.panoPitch : 0;
        this._panoRollDeg2 = typeof target.panoRoll === 'number' ? target.panoRoll : 0;
        this._tilesNext = target.tiles || null;
        this._loadInto('texture2', target.imageUrl, (err) => {
            if (this._mode !== 'inside') return;
            if (err) { // fall back to an instant swap rather than getting stuck
                this._finishTransition(toAnchor, target.imageUrl, target);
                return;
            }
            this._runTransition(fromAnchor, toAnchor, target);
        });
    }

    // Animate the walk from `fromAnchor` to `toAnchor`. The panos themselves are
    // sampled direction-only with a directional zoom toward the travel direction
    // (see the shader, #64) — finite-sphere ray-casting from the moving eye showed
    // the destination's REAR view and read as backward motion. The map camera
    // still dollies so the vector layers give true forward parallax.
    _runTransition(fromAnchor, toAnchor, target) {
        this._transitioning = true;
        const fromM = MercatorCoordinate.fromLngLat(fromAnchor);
        const toM = MercatorCoordinate.fromLngLat(toAnchor);
        // Unit (east, north) travel direction for the shader zoom (#64).
        const dE = toM.x - fromM.x;
        const dN = -(toM.y - fromM.y); // mercator y grows southward
        const dLen = Math.hypot(dE, dN) || 1;
        this._walkDir = [dE / dLen, dN / dLen];
        this._sphereCenterOffset = [0, 0, 0];
        this._sphereCenterOffset2 = [0, 0, 0];
        const durationMs = this._options.walkMs;
        const startTime = performance.now();
        const step = (now) => {
            if (this._mode !== 'inside') { this._endTransitionState(); return; }
            const t = Math.min(1, (now - startTime) / durationMs);
            const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            const eye = [
                fromAnchor[0] + (toAnchor[0] - fromAnchor[0]) * eased,
                fromAnchor[1] + (toAnchor[1] - fromAnchor[1]) * eased,
            ];
            this._mix = eased;
            this._positionEyeAt(eye);
            this._map.triggerRepaint();
            if (t < 1) requestAnimationFrame(step);
            else this._finishTransition(toAnchor, target.imageUrl, target);
        };
        requestAnimationFrame(step);
    }

    // Promote the next panorama to current: swap textures (texture2 already holds
    // it), reset the offsets/crossfade, and settle the eye at the new anchor.
    _finishTransition(toAnchor, imageUrl, target) {
        const layer = this._layerCtx;
        if (layer) {
            const tmp = layer.texture;
            layer.texture = layer.texture2;
            layer.texture2 = tmp;
            const tmpImage = layer.textureImage;
            layer.textureImage = layer.texture2Image;
            layer.texture2Image = tmpImage;
            layer.textureReady = true;
        }
        this._options.lngLat = toAnchor;
        this._options.imageUrl = imageUrl;
        // Promote the next pano's heading and pose to current (#52).
        if (typeof target.panoYaw === 'number') this._panoYawDeg = target.panoYaw;
        else if (typeof target.bearing === 'number') this._panoYawDeg = target.bearing;
        this._panoPitchDeg = this._panoPitchDeg2;
        this._panoRollDeg = this._panoRollDeg2;
        this._endTransitionState();
        this._recalibrateLookTargetDistance();
        this._updateCameraWhileInside();
        // Adopt the new pano's tiles and start refining from its base (v0.3.0).
        this._tiles = this._tilesNext;
        this._tilesNext = null;
        this._tileState = null;
        this._tileEpoch++;
        if (this._tiles && layer && layer.textureImage) {
            this._buildAtlas(layer.textureImage, this._tiles);
        }
        this._map.triggerRepaint();
        if (this._options.onMove) this._options.onMove(target);
    }

    _endTransitionState() {
        this._sphereCenterOffset = [0, 0, 0];
        this._sphereCenterOffset2 = [0, 0, 0];
        this._walkDir = [0, 0];
        this._mix = 0;
        this._transitioning = false;
    }

    exit() {
        if (this._mode !== 'inside') {
            return;
        }
        this._mode = 'exiting';
        const view = this._options.exitView || {
            center: this._options.lngLat, zoom: this._options.zoom - 1, pitch: 60, bearing: 0
        };
        this._animate(view, 0, 0, () => {
            this._mode = 'outside';
            // Restore the map's original vertical FOV (mapmax #24).
            if (this._savedFov != null && typeof this._map.setVerticalFieldOfView === 'function') {
                this._map.setVerticalFieldOfView(this._savedFov);
                this._savedFov = null;
            }
            for (const handler of this._interactionHandlers()) {
                handler.enable();
            }
            if (this._options.onExit) this._options.onExit();
        });
    }

    remove() {
        if (this._tileTimer) {
            clearTimeout(this._tileTimer);
            this._tileTimer = null;
        }
        this._tileState = null;
        this._tileEpoch++;
        const map = this._map;
        const container = map.getContainer();
        container.removeEventListener('mousedown', this._onMouseDown);
        removeEventListener('mousemove', this._onMouseMove);
        removeEventListener('mouseup', this._onMouseUp);
        container.removeEventListener('touchstart', this._onTouchStart);
        container.removeEventListener('touchmove', this._onTouchMove);
        container.removeEventListener('touchend', this._onTouchEnd);
        if (map.getLayer(this._layer.id)) {
            map.removeLayer(this._layer.id);
        }
    }

    _interactionHandlers() {
        const map = this._map;
        return [map.dragPan, map.dragRotate, map.scrollZoom, map.doubleClickZoom, map.touchZoomRotate, map.keyboard];
    }

    // Refactored image → texture load, reusable after the layer exists (not
    // only at creation). No-op until onAdd has stored the gl + layer context.
    // `slot` picks which texture to fill: 'texture' (current) or 'texture2'
    // (the next panorama, preloaded for a walk transition #5b).
    _loadInto(slot, url, onReady) {
        const gl = this._gl;
        const layer = this._layerCtx;
        if (!gl || !layer) return;
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            gl.bindTexture(gl.TEXTURE_2D, layer[slot]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            layer[slot + 'Image'] = image; // kept to seed a tile atlas later
            if (slot === 'texture') {
                layer.textureReady = true;
                // The base is up (usable as-is); refine it with HD tiles if the
                // current panorama has a tiles config (v0.3.0).
                this._tileState = null;
                if (this._tiles) this._buildAtlas(image, this._tiles);
            }
            this._map.triggerRepaint();
            if (onReady) onReady();
        };
        image.onerror = () => onReady && onReady(new Error(`photosphere image failed: ${url}`));
        image.src = url;
    }

    _loadTexture(url, onReady) {
        this._loadInto('texture', url, onReady);
    }

    // ---- Progressive HD tiles (v0.3.0) --------------------------------------
    // The current texture is re-allocated as a full-panorama atlas (capped by
    // MAX_TEXTURE_SIZE / ATLAS_MAX), seeded with the base image scaled up, then
    // visible tiles stream into it with texSubImage2D. The fragment shader is
    // untouched — it keeps sampling one equirectangular texture.

    // Re-uploads the base image at atlas size and resets the tile state.
    _buildAtlas(image, tiles) {
        const gl = this._gl;
        const layer = this._layerCtx;
        if (!gl || !layer || !image || !tiles || !tiles.width || !tiles.cols || !tiles.rows) return;
        const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
        const atlasW = Math.min(tiles.width, maxTexture, ATLAS_MAX);
        const atlasH = Math.round(atlasW / 2);
        const epoch = ++this._tileEpoch;
        this._scaled(image, atlasW, atlasH).then((source) => {
            if (epoch !== this._tileEpoch || !this._gl) return;
            gl.bindTexture(gl.TEXTURE_2D, layer.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            if (source.close) source.close();
            this._tileState = {
                tiles,
                epoch,
                scale: atlasW / tiles.width,
                loaded: new Set(),
                inflight: new Set(),
                queue: []
            };
            this._map.triggerRepaint();
            this._scheduleTileRefresh();
        }).catch(() => { /* keep the plain base — refinement is best-effort */ });
    }

    // Image scaled to (w, h), as an ImageBitmap when the browser can, else a
    // canvas. Off-main-thread decode + resize where available.
    _scaled(image, w, h) {
        if (image.width === w && image.height === h) return Promise.resolve(image);
        if (typeof createImageBitmap === 'function') {
            return createImageBitmap(image, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
                .catch(() => this._scaledCanvas(image, w, h));
        }
        return Promise.resolve(this._scaledCanvas(image, w, h));
    }

    _scaledCanvas(image, w, h) {
        const canvas = this._scratchCanvas || (this._scratchCanvas = document.createElement('canvas'));
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(image, 0, 0, w, h);
        return canvas;
    }

    // Debounced entry point, called after every look / zoom / walk settle.
    _scheduleTileRefresh() {
        if (this._tileTimer || !this._tileState) return;
        this._tileTimer = setTimeout(() => {
            this._tileTimer = null;
            this._refreshTiles();
        }, TILE_REFRESH_MS);
    }

    // Recomputes the visible tiles for the current camera and reloads the queue
    // (most-central first); already-loaded and in-flight tiles are skipped.
    _refreshTiles() {
        const state = this._tileState;
        if (!state || this._mode !== 'inside' || this._transitioning) return;
        const canvas = this._map.getCanvas();
        const aspect = (canvas.clientWidth || canvas.width || 1) / (canvas.clientHeight || canvas.height || 1);
        const wanted = visibleTiles({
            yawDeg: this._yawDeg,
            pitchDeg: this._pitchDeg,
            panoRot: panoPoseMatrix(this._panoYawDeg, this._panoPitchDeg, this._panoRollDeg),
            fovDeg: this._options.fov,
            aspect,
            cols: state.tiles.cols,
            rows: state.tiles.rows
        });
        state.queue = wanted.filter(t => !state.loaded.has(`${t.col}x${t.row}`) && !state.inflight.has(`${t.col}x${t.row}`));
        this._pumpTiles();
    }

    _pumpTiles() {
        const state = this._tileState;
        if (!state) return;
        while (state.inflight.size < TILE_CONCURRENCY && state.queue.length) {
            const tile = state.queue.shift();
            const key = `${tile.col}x${tile.row}`;
            if (state.loaded.has(key) || state.inflight.has(key)) continue;
            state.inflight.add(key);
            this._loadTile(state, tile, key);
        }
    }

    _loadTile(state, tile, key) {
        const done = () => {
            if (this._tileState !== state) return; // pano changed mid-flight
            state.inflight.delete(key);
            state.loaded.add(key); // errors too: leave the base, don't retry-storm
            this._pumpTiles();
        };
        const url = state.tiles.url(tile.col, tile.row);
        if (!url) { done(); return; }
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            if (this._tileState !== state || !this._gl) return;
            const rect = this._tileRect(state, tile);
            this._scaled(image, rect.w, rect.h).then((source) => {
                if (this._tileState === state && this._gl) {
                    const gl = this._gl;
                    gl.bindTexture(gl.TEXTURE_2D, this._layerCtx.texture);
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, gl.RGBA, gl.UNSIGNED_BYTE, source);
                    if (source.close) source.close();
                    this._map.triggerRepaint();
                }
                done();
            }).catch(done);
        };
        image.onerror = done;
        image.src = url;
    }

    // Atlas rectangle of a tile, rounded edge-by-edge so adjacent tiles always
    // abut exactly (no cracks) at any atlas scale.
    _tileRect(state, tile) {
        const { tiles, scale } = state;
        const x0 = Math.round(tile.col * tiles.width / tiles.cols * scale);
        const x1 = Math.round((tile.col + 1) * tiles.width / tiles.cols * scale);
        const y0 = Math.round(tile.row * (tiles.width / 2) / tiles.rows * scale);
        const y1 = Math.round((tile.row + 1) * (tiles.width / 2) / tiles.rows * scale);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    _createLayer() {
        const self = this;
        return {
            id: 'photosphere',
            type: 'custom',
            renderingMode: '2d',

            onAdd(map, gl) {
                const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
                const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
                this.program = gl.createProgram();
                gl.attachShader(this.program, vertexShader);
                gl.attachShader(this.program, fragmentShader);
                gl.linkProgram(this.program);
                if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
                    throw new Error(gl.getProgramInfoLog(this.program));
                }

                this.aPosition = gl.getAttribLocation(this.program, 'aPosition');
                this.uniforms = {};
                for (const name of ['uYaw', 'uPitch', 'uFovY', 'uAspect', 'uAlpha', 'uSphereCenterOffset', 'uSphereRadius', 'uPanorama', 'uSphereCenterOffset2', 'uPanorama2', 'uMix', 'uPanoRot', 'uPanoRot2', 'uWalkDir', 'uEyeHeight', 'uArrowCount', 'uArrows', 'uPoiCount', 'uPois', 'uPoiColors']) {
                    this.uniforms[name] = gl.getUniformLocation(this.program, name);
                }

                this.vertexBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

                // REPEAT horizontally so the equirectangular seam behind the
                // camera wraps seamlessly (WebGL2/NPOT — MapLibre 6). Clamp
                // vertically at the poles (mapmax #40). texture2 holds the next
                // panorama during a walk transition (#5b).
                const makeTexture = () => {
                    const tex = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_2D, tex);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    return tex;
                };
                this.textureReady = false;
                this.texture = makeTexture();
                this.texture2 = makeTexture();

                self._gl = gl;
                self._layerCtx = this;
                self._loadTexture(self._options.imageUrl);
            },

            render(gl) {
                if (!this.textureReady || self._opacity <= 0) {
                    return;
                }
                gl.disable(gl.DEPTH_TEST);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.useProgram(this.program);

                gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
                gl.enableVertexAttribArray(this.aPosition);
                gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, 0, 0);

                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.texture);
                gl.uniform1i(this.uniforms.uPanorama, 0);
                gl.uniform1f(this.uniforms.uYaw, self._yawDeg * Math.PI / 180);
                gl.uniform1f(this.uniforms.uPitch, self._pitchDeg * Math.PI / 180);
                gl.uniform1f(this.uniforms.uFovY, self._options.fov * Math.PI / 180);
                gl.uniform1f(this.uniforms.uAspect, gl.drawingBufferWidth / gl.drawingBufferHeight);
                gl.uniform1f(this.uniforms.uAlpha, self._opacity * self._blend);
                gl.uniform3f(this.uniforms.uSphereCenterOffset, ...self._sphereCenterOffset);
                gl.uniform1f(this.uniforms.uSphereRadius, self._options.radius);

                // Second sphere + crossfade for the walk transition (#5b).
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.texture2);
                gl.uniform1i(this.uniforms.uPanorama2, 1);
                gl.uniform3f(this.uniforms.uSphereCenterOffset2, ...self._sphereCenterOffset2);
                gl.uniform1f(this.uniforms.uMix, self._mix);
                gl.uniformMatrix3fv(this.uniforms.uPanoRot, false,
                    panoPoseMatrix(self._panoYawDeg, self._panoPitchDeg, self._panoRollDeg));
                gl.uniformMatrix3fv(this.uniforms.uPanoRot2, false,
                    panoPoseMatrix(self._panoYawDeg2, self._panoPitchDeg2, self._panoRollDeg2));
                gl.uniform2f(this.uniforms.uWalkDir, self._walkDir[0], self._walkDir[1]);

                // Ground navigation arrows (mapmax #26): positions on the floor,
                // at a fixed distance toward each target bearing.
                gl.uniform1f(this.uniforms.uEyeHeight, self._options.eyeHeight);
                const n = Math.min(MAX_ARROWS, self._navArrows.length);
                gl.uniform1i(this.uniforms.uArrowCount, n);
                const buf = new Float32Array(MAX_ARROWS * 2);
                for (let i = 0; i < n; i++) {
                    const br = self._navArrows[i].bearing * Math.PI / 180;
                    buf[i * 2] = ARROW_GROUND_DIST * Math.sin(br);
                    buf[i * 2 + 1] = ARROW_GROUND_DIST * Math.cos(br);
                }
                gl.uniform2fv(this.uniforms.uArrows, buf);

                // Neighbour-panorama dots at their real ground offsets (#39).
                const np = Math.min(MAX_POIS, self._navPois.length);
                gl.uniform1i(this.uniforms.uPoiCount, np);
                const pbuf = new Float32Array(MAX_POIS * 2);
                const cbuf = new Float32Array(MAX_POIS * 3);
                for (let i = 0; i < np; i++) {
                    pbuf[i * 2] = self._navPois[i].east;
                    pbuf[i * 2 + 1] = self._navPois[i].north;
                    // Per-dot color, defaulting to the historical blue.
                    const c = self._navPois[i].color || [0.16, 0.4, 1.0];
                    cbuf[i * 3] = c[0];
                    cbuf[i * 3 + 1] = c[1];
                    cbuf[i * 3 + 2] = c[2];
                }
                gl.uniform2fv(this.uniforms.uPois, pbuf);
                gl.uniform3fv(this.uniforms.uPoiColors, cbuf);

                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.disable(gl.BLEND);
            }
        };
    }

    _recalibrateLookTargetDistance() {
        const { lngLat, zoom, eyeHeight } = this._options;
        const eyeMercator = MercatorCoordinate.fromLngLat(lngLat);
        const probeTarget = new MercatorCoordinate(
            eyeMercator.x, eyeMercator.y - eyeMercator.meterInMercatorCoordinateUnits()).toLngLat();
        const probeOptions = this._map.calculateCameraOptionsFromTo(lngLat, eyeHeight, probeTarget, eyeHeight);
        this._lookTargetDistanceMetres = Math.pow(2, probeOptions.zoom - zoom);
    }

    _updateCameraWhileInside() {
        // During a walk the transition loop drives the eye; don't let a look-drag
        // snap it back to the old anchor mid-dolly (#5b).
        if (this._transitioning) return;
        this._positionEyeAt(this._options.lngLat);
    }

    // Point the map camera from an eye at `eyeLngLat` (eye height) along the
    // current yaw/pitch. Generalized so a walk transition can dolly the eye
    // between two anchors (#5b) while enter/look use the fixed anchor.
    _positionEyeAt(eyeLngLat) {
        const { eyeHeight } = this._options;
        const eyeMercator = MercatorCoordinate.fromLngLat(eyeLngLat);
        const metresToMercatorUnits = eyeMercator.meterInMercatorCoordinateUnits();

        const yawRad = this._yawDeg * Math.PI / 180;
        const pitchRad = this._pitchDeg * Math.PI / 180;
        const horizontalDistance = this._lookTargetDistanceMetres * Math.cos(pitchRad);
        const targetLngLat = new MercatorCoordinate(
            eyeMercator.x + horizontalDistance * Math.sin(yawRad) * metresToMercatorUnits,
            eyeMercator.y - horizontalDistance * Math.cos(yawRad) * metresToMercatorUnits
        ).toLngLat();

        const cameraOptions = this._map.calculateCameraOptionsFromTo(
            eyeLngLat, eyeHeight, targetLngLat,
            eyeHeight + this._lookTargetDistanceMetres * Math.sin(pitchRad));
        this._map.jumpTo(cameraOptions);
    }

    _animate(targetView, targetElevation, targetOpacity, onDone) {
        const map = this._map;
        const startTime = performance.now();
        const start = {
            center: map.getCenter(),
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            bearing: map.getBearing(),
            elevation: map.getCenterElevation(),
            opacity: this._opacity
        };
        const durationMs = this._options.durationMs;
        const anchor = this._options.lngLat;

        const step = (now) => {
            const t = Math.min(1, (now - startTime) / durationMs);
            const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

            const eyeMercator = MercatorCoordinate.fromLngLat(map.getCenter());
            const sphereMercator = MercatorCoordinate.fromLngLat(anchor);
            const metresToMercatorUnits = sphereMercator.meterInMercatorCoordinateUnits();
            this._sphereCenterOffset = [
                (sphereMercator.x - eyeMercator.x) / metresToMercatorUnits,
                -(sphereMercator.y - eyeMercator.y) / metresToMercatorUnits,
                0
            ];
            this._opacity = start.opacity + (targetOpacity - start.opacity) * eased;

            map.jumpTo({
                center: [
                    start.center.lng + (targetView.center[0] - start.center.lng) * eased,
                    start.center.lat + (targetView.center[1] - start.center.lat) * eased
                ],
                zoom: start.zoom + (targetView.zoom - start.zoom) * eased,
                pitch: start.pitch + (targetView.pitch - start.pitch) * eased,
                bearing: start.bearing + (targetView.bearing - start.bearing) * eased,
                elevation: start.elevation + (targetElevation - start.elevation) * eased
            });
            map.triggerRepaint();

            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                onDone();
            }
        };
        requestAnimationFrame(step);
    }

    _onMouseDown(event) {
        if (this._mode !== 'inside') {
            return;
        }
        this._dragging = true;
        this._lastX = event.clientX;
        this._lastY = event.clientY;
    }

    _onMouseMove(event) {
        if (!this._dragging) {
            return;
        }
        const { dragSensitivity, minPitch, maxPitch } = this._options;
        // Pose-edit mode: the drag manipulates the PHOTO, not the camera —
        // deltas go to the editor callback (see setPoseEditDrag).
        if (this._poseEditDrag) {
            const prevX = this._lastX, prevY = this._lastY;
            const dxDeg = (event.clientX - prevX) * dragSensitivity;
            const dyDeg = (event.clientY - prevY) * dragSensitivity;
            this._lastX = event.clientX;
            this._lastY = event.clientY;
            this._poseEditDrag(dxDeg, dyDeg, {
                x: event.clientX, y: event.clientY, prevX, prevY,
                shiftKey: !!event.shiftKey,
            });
            return;
        }
        this._yawDeg = (this._yawDeg - (event.clientX - this._lastX) * dragSensitivity + 360) % 360;
        this._pitchDeg = Math.max(minPitch, Math.min(maxPitch,
            this._pitchDeg + (event.clientY - this._lastY) * dragSensitivity));
        this._lastX = event.clientX;
        this._lastY = event.clientY;
        this._updateCameraWhileInside();
        this._scheduleTileRefresh();
        this._map.triggerRepaint();
    }

    _onMouseUp() {
        this._dragging = false;
    }

    // Touch: one finger looks around, two fingers pinch to zoom FOV (mapmax #7).
    _onTouchStart(event) {
        if (this._mode !== 'inside') return;
        if (event.touches.length === 1) {
            this._dragging = true;
            this._lastX = event.touches[0].clientX;
            this._lastY = event.touches[0].clientY;
        } else if (event.touches.length === 2) {
            this._dragging = false;
            this._pinchDist = this._touchDistance(event);
        }
    }

    _onTouchMove(event) {
        if (this._mode !== 'inside') return;
        event.preventDefault();
        const { dragSensitivity, minPitch, maxPitch } = this._options;
        if (event.touches.length === 1 && this._dragging) {
            const t = event.touches[0];
            this._yawDeg = (this._yawDeg - (t.clientX - this._lastX) * dragSensitivity + 360) % 360;
            this._pitchDeg = Math.max(minPitch, Math.min(maxPitch,
                this._pitchDeg + (t.clientY - this._lastY) * dragSensitivity));
            this._lastX = t.clientX;
            this._lastY = t.clientY;
            this._updateCameraWhileInside();
            this._scheduleTileRefresh();
            this._map.triggerRepaint();
        } else if (event.touches.length === 2 && this._pinchDist) {
            const d = this._touchDistance(event);
            this.zoomFov((this._pinchDist - d) * 0.2);
            this._pinchDist = d;
        }
    }

    _onTouchEnd(event) {
        this._dragging = false;
        if (!event.touches || event.touches.length < 2) this._pinchDist = 0;
    }

    _touchDistance(event) {
        const [a, b] = event.touches;
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
}
