// Capture-pose maths for the photosphere: yaw / pitch / roll of the camera
// that shot the panorama. Pure — shared by the fragment shader (via
// uniformMatrix3fv), the visible-tile computation and the tests.
//
// This is RENDERING maths only: applying a known pose so corrected data
// displays right, whatever imagery source produced it. Editor semantics
// (gesture algebra, write-back) deliberately live outside this plugin — see
// maplibre-gl-panoramax for the Panoramax editing stack.
//
// Conventions (matching the shader): world x = east, y = north, z = up;
// azimuth measured from +y (north) toward +x (east).
//   yaw    0..360  world azimuth the image centre faces
//   pitch −90..90  horizon = 0, top = +90 (camera tilted up at capture)
//   roll  −90..90  flat = 0, right-arm down = +90

// Normalize any yaw to [0, 360) (−180 → 180, 540 → 180).
export const normalizeYaw = (deg) => ((deg % 360) + 360) % 360;

// World → camera-frame rotation of the capture pose. Returns the COLUMN-MAJOR
// 9-array for gl.uniformMatrix3fv of the matrix M with rows right/forward/up,
// so `M * dir` yields camera-frame coords and
//   theta = atan(nc.x, nc.y), phi = asin(nc.z)
// generalizes the yaw-only `atan(d.x, d.y) − panoYaw`.
export function panoPoseMatrix(yawDeg, pitchDeg = 0, rollDeg = 0) {
    const d2r = Math.PI / 180;
    const Y = (yawDeg || 0) * d2r, P = (pitchDeg || 0) * d2r, R = (rollDeg || 0) * d2r;
    const sY = Math.sin(Y), cY = Math.cos(Y);
    const sP = Math.sin(P), cP = Math.cos(P);
    const sR = Math.sin(R), cR = Math.cos(R);

    const f = [sY * cP, cY * cP, sP];
    // Analytic right/up before roll (stays valid at |pitch| = 90 where
    // cross(f, worldUp) degenerates).
    const r0 = [cY, -sY, 0];
    const u0 = [-sY * sP, -cY * sP, cP];
    // Rodrigues about f: r' = r0·cosR − u0·sinR, u' = u0·cosR + r0·sinR.
    const r = [r0[0] * cR - u0[0] * sR, r0[1] * cR - u0[1] * sR, r0[2] * cR - u0[2] * sR];
    const u = [u0[0] * cR + r0[0] * sR, u0[1] * cR + r0[1] * sR, u0[2] * cR + r0[2] * sR];

    // Column-major of M(rows r, f, u).
    return [r[0], f[0], u[0], r[1], f[1], u[1], r[2], f[2], u[2]];
}

// Apply the matrix to a world direction (JS twin of the GLSL `M * dir`).
export function poseTransform(m, v) {
    return [
        m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
        m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
        m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
    ];
}

// --- Flat pictures (#3) ------------------------------------------------------

// Half-tangents of a flat picture's gnomonic window: hfov comes from the
// capture metadata; vfov derives from the actual image aspect unless given.
// For equirectangular pictures returns [1, 1] (unused by the shader).
export function flatTanHalf(flat, hfovDeg, vfovDeg, image) {
    if (!flat) return [1, 1];
    const th = Math.tan(((hfovDeg || 70) * Math.PI / 180) / 2);
    const tv = vfovDeg
        ? Math.tan((vfovDeg * Math.PI / 180) / 2)
        : th * (image && image.width ? image.height / image.width : 0.75);
    return [th, tv];
}

// Texture UV of a world direction on a flat picture (JS twin of the shader's
// gnomonic branch): null when the direction is behind the picture plane or
// outside the window. `m` is the capture pose from panoPoseMatrix.
export function flatUV(dir, m, tanHalfH, tanHalfV) {
    const nc = poseTransform(m, dir);
    if (nc[1] <= 0) return null;
    const u = 0.5 + 0.5 * (nc[0] / nc[1]) / tanHalfH;
    const v = 0.5 - 0.5 * (nc[2] / nc[1]) / tanHalfV;
    return (u < 0 || u > 1 || v < 0 || v > 1) ? null : [u, v];
}
