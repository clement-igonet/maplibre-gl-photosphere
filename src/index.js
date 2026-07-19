import {MercatorCoordinate} from 'maplibre-gl';

const VERTEX_SHADER_SOURCE = `
    attribute vec2 aPosition;
    varying vec2 vNdc;
    void main() {
        vNdc = aPosition;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`;

// Ray-casts each screen pixel (from the current yaw/pitch/FOV) against the
// photosphere modeled as a finite sphere centered on its anchor point, then
// samples the panorama texture by the direction from the sphere's center to
// the intersection. While the eye sits at the center this reduces to plain
// direction sampling; while approaching it during the enter transition the
// offset gives real parallax.
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
    void main() {
        float tanHalfFovY = tan(uFovY * 0.5);
        float tanHalfFovX = tanHalfFovY * uAspect;

        vec3 forward = vec3(cos(uPitch) * sin(uYaw), cos(uPitch) * cos(uYaw), sin(uPitch));
        vec3 worldUp = vec3(0.0, 0.0, 1.0);
        vec3 right = normalize(cross(forward, worldUp));
        vec3 up = cross(right, forward);

        vec3 viewDir = normalize(forward + right * (vNdc.x * tanHalfFovX) + up * (vNdc.y * tanHalfFovY));

        vec3 originToCenter = -uSphereCenterOffset;
        float b = dot(originToCenter, viewDir);
        float c = dot(originToCenter, originToCenter) - uSphereRadius * uSphereRadius;
        float discriminant = b * b - c;
        if (discriminant < 0.0) {
            discard;
        }
        float sqrtDiscriminant = sqrt(discriminant);
        float tNear = -b - sqrtDiscriminant;
        float tFar = -b + sqrtDiscriminant;
        float t = tNear > 0.0 ? tNear : tFar;
        if (t < 0.0) {
            discard;
        }

        vec3 intersection = viewDir * t;
        vec3 normal = normalize(intersection - uSphereCenterOffset);

        float theta = atan(normal.x, normal.y);
        float phi = asin(clamp(normal.z, -1.0, 1.0));

        float u = 0.5 + theta / (2.0 * 3.14159265359);
        float v = 0.5 - phi / 3.14159265359;

        vec4 color = texture2D(uPanorama, vec2(u, v));
        gl_FragColor = vec4(color.rgb, color.a * uAlpha);
    }
`;

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
    dragSensitivity: 0.15,
    minPitch: -85,
    maxPitch: 85,
    fov: 75
};

/**
 * An immersive 360-degree photosphere anchored at a geographic point,
 * rendered through MapLibre's CustomLayerInterface.
 *
 * const photosphere = new Photosphere(map, {
 *     lngLat: [2.286828, 48.856625],
 *     imageUrl: 'panorama.jpg',
 *     onEnter: () => {},
 *     onExit: () => {}
 * });
 * photosphere.enter();
 * photosphere.exit();
 */
export class Photosphere {
    constructor(map, options) {
        if (!options || !options.lngLat || !options.imageUrl) {
            throw new Error('Photosphere requires lngLat and imageUrl options');
        }
        this._map = map;
        this._options = {...DEFAULT_OPTIONS, ...options};
        this._mode = 'outside';
        this._yawDeg = 0;
        this._pitchDeg = 0;
        this._dragging = false;
        this._lookTargetDistanceMetres = 1;
        this._opacity = 0;
        this._sphereCenterOffset = [0, 0, 0];

        this._layer = this._createLayer();
        if (map.style && map.loaded()) {
            map.addLayer(this._layer);
        } else {
            map.on('load', () => map.addLayer(this._layer));
        }

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        map.getContainer().addEventListener('mousedown', this._onMouseDown);
        addEventListener('mousemove', this._onMouseMove);
        addEventListener('mouseup', this._onMouseUp);
    }

    get mode() {
        return this._mode;
    }

    enter() {
        if (this._mode !== 'outside') {
            return;
        }
        this._mode = 'entering';
        for (const handler of this._interactionHandlers()) {
            handler.disable();
        }
        this._yawDeg = 0;
        this._pitchDeg = 0;
        this._recalibrateLookTargetDistance();
        const {lngLat, zoom, eyeHeight, onEnter} = this._options;
        this._animate({center: lngLat, zoom, pitch: 90, bearing: 0}, eyeHeight, 1, () => {
            this._mode = 'inside';
            this._updateCameraWhileInside();
            if (onEnter) onEnter();
        });
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
            for (const handler of this._interactionHandlers()) {
                handler.enable();
            }
            if (this._options.onExit) this._options.onExit();
        });
    }

    remove() {
        const map = this._map;
        map.getContainer().removeEventListener('mousedown', this._onMouseDown);
        removeEventListener('mousemove', this._onMouseMove);
        removeEventListener('mouseup', this._onMouseUp);
        if (map.getLayer(this._layer.id)) {
            map.removeLayer(this._layer.id);
        }
    }

    _interactionHandlers() {
        const map = this._map;
        return [map.dragPan, map.dragRotate, map.scrollZoom, map.doubleClickZoom, map.touchZoomRotate, map.keyboard];
    }

    _createLayer() {
        const self = this;
        return {
            id: `photosphere-${Math.round(this._options.lngLat[0] * 1e6)}-${Math.round(this._options.lngLat[1] * 1e6)}`,
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
                for (const name of ['uYaw', 'uPitch', 'uFovY', 'uAspect', 'uAlpha', 'uSphereCenterOffset', 'uSphereRadius', 'uPanorama']) {
                    this.uniforms[name] = gl.getUniformLocation(this.program, name);
                }

                this.vertexBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

                this.textureReady = false;
                this.texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, this.texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

                const image = new Image();
                image.crossOrigin = 'anonymous';
                image.onload = () => {
                    gl.bindTexture(gl.TEXTURE_2D, this.texture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                    this.textureReady = true;
                    map.triggerRepaint();
                };
                image.src = self._options.imageUrl;
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
                gl.uniform1f(this.uniforms.uAlpha, self._opacity);
                gl.uniform3f(this.uniforms.uSphereCenterOffset, ...self._sphereCenterOffset);
                gl.uniform1f(this.uniforms.uSphereRadius, self._options.radius);

                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.disable(gl.BLEND);
            }
        };
    }

    // calculateCameraOptionsFromTo() maps an (eye, look-target) pair to
    // bearing/pitch/zoom without the ground-intersection math that becomes
    // unstable at pitch 90. The probe measures how zoom encodes the
    // eye-to-target distance so look targets keep a constant length.
    _recalibrateLookTargetDistance() {
        const {lngLat, zoom, eyeHeight} = this._options;
        const eyeMercator = MercatorCoordinate.fromLngLat(lngLat);
        const probeTarget = new MercatorCoordinate(
            eyeMercator.x, eyeMercator.y - eyeMercator.meterInMercatorCoordinateUnits()).toLngLat();
        const probeOptions = this._map.calculateCameraOptionsFromTo(lngLat, eyeHeight, probeTarget, eyeHeight);
        this._lookTargetDistanceMetres = Math.pow(2, probeOptions.zoom - zoom);
    }

    _updateCameraWhileInside() {
        const {lngLat, eyeHeight} = this._options;
        const eyeMercator = MercatorCoordinate.fromLngLat(lngLat);
        const metresToMercatorUnits = eyeMercator.meterInMercatorCoordinateUnits();

        const yawRad = this._yawDeg * Math.PI / 180;
        const pitchRad = this._pitchDeg * Math.PI / 180;
        const horizontalDistance = this._lookTargetDistanceMetres * Math.cos(pitchRad);
        const targetLngLat = new MercatorCoordinate(
            eyeMercator.x + horizontalDistance * Math.sin(yawRad) * metresToMercatorUnits,
            eyeMercator.y - horizontalDistance * Math.cos(yawRad) * metresToMercatorUnits
        ).toLngLat();

        const cameraOptions = this._map.calculateCameraOptionsFromTo(
            lngLat, eyeHeight, targetLngLat,
            eyeHeight + this._lookTargetDistanceMetres * Math.sin(pitchRad));
        this._map.jumpTo(cameraOptions);
    }

    // One camera tween for entering and exiting; feeds the shader the
    // eye-to-sphere-center offset each frame for the approach parallax.
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
        const {dragSensitivity, minPitch, maxPitch} = this._options;
        this._yawDeg = (this._yawDeg - (event.clientX - this._lastX) * dragSensitivity + 360) % 360;
        this._pitchDeg = Math.max(minPitch, Math.min(maxPitch,
            this._pitchDeg + (event.clientY - this._lastY) * dragSensitivity));
        this._lastX = event.clientX;
        this._lastY = event.clientY;
        this._updateCameraWhileInside();
        this._map.triggerRepaint();
    }

    _onMouseUp() {
        this._dragging = false;
    }
}
