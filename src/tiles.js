// Visible-tile computation for progressive HD refinement. Pure maths shared by
// the runtime and the tests: given the shader's camera (yaw, pitch, vertical
// FOV, aspect, panoYaw) and an equirectangular tile grid, returns which tiles
// are on screen, most-central first.
//
// Mirrors Photo-Sphere-Viewer's equirectangular-tiles-adapter semantics — angle
// to the view direction as priority, pole rows deprioritized ×2 — but computed
// by sampling screen rays through the same camera basis as the fragment shader
// instead of iterating sphere-mesh vertices, so seam wrap and pole coverage
// fall out of the projection maths.

import { poseTransform } from './pose.js';

const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Computes the equirectangular tiles visible from the photosphere camera.
 *
 * @param {object} view
 * @param {number} view.yawDeg camera yaw (deg, world azimuth)
 * @param {number} view.pitchDeg camera pitch (deg, positive up)
 * @param {number} [view.panoYawDeg] world azimuth the image centre faces (deg)
 * @param {number[]} [view.panoRot] full capture pose (column-major mat3 from
 *   panoPoseMatrix) — supersedes panoYawDeg when given, so tiles follow a
 *   pitched/rolled pose exactly like the shader does
 * @param {number} view.fovDeg vertical field of view (deg)
 * @param {number} view.aspect viewport width / height
 * @param {number} view.cols number of tile columns in the full panorama
 * @param {number} view.rows number of tile rows in the full panorama
 * @param {number} [view.samples] rays per screen axis (odd keeps a centre ray)
 * @param {number} [view.marginNdc] extra NDC beyond the edges, for prefetch
 * @returns {{col: number, row: number, priority: number}[]} sorted ascending by
 *   priority (angle to the view direction, ×2 on the pole rows)
 */
export function visibleTiles({yawDeg, pitchDeg, panoYawDeg = 0, panoRot = null, fovDeg, aspect, cols, rows, samples = 13, marginNdc = 0.15}) {
    const yaw = yawDeg * Math.PI / 180;
    const pitch = pitchDeg * Math.PI / 180;
    const panoYaw = panoYawDeg * Math.PI / 180;
    const tanY = Math.tan((fovDeg * Math.PI / 180) / 2);
    const tanX = tanY * aspect;

    // Same camera basis as the fragment shader (x = east, y = north, z = up).
    const forward = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
    const worldUp = Math.abs(forward[2]) > 0.9999 ? [0, 1, 0] : [0, 0, 1];
    const right = normalize(cross(forward, worldUp));
    const up = cross(right, forward);

    const found = new Map(); // "col x row" -> {col, row, angle}
    const add = (col, row, angle) => {
        const key = `${col}x${row}`;
        const existing = found.get(key);
        if (!existing) found.set(key, {col, row, angle});
        else existing.angle = Math.min(existing.angle, angle);
    };

    // Screen-ray grid, slightly beyond the edges so adjacent tiles prefetch.
    const lim = 1 + marginNdc;
    for (let i = 0; i < samples; i++) {
        for (let j = 0; j < samples; j++) {
            const nx = -lim + 2 * lim * i / (samples - 1);
            const ny = -lim + 2 * lim * j / (samples - 1);
            const dir = normalize([
                forward[0] + right[0] * nx * tanX + up[0] * ny * tanY,
                forward[1] + right[1] * nx * tanX + up[1] * ny * tanY,
                forward[2] + right[2] * nx * tanX + up[2] * ny * tanY,
            ]);
            // Same direction→UV mapping as the fragment shader: full pose
            // matrix when provided, yaw-only subtraction otherwise.
            const nc = panoRot ? poseTransform(panoRot, dir) : dir;
            const phi = Math.asin(clamp(nc[2], -1, 1));
            const theta = panoRot ? Math.atan2(nc[0], nc[1]) : Math.atan2(nc[0], nc[1]) - panoYaw;
            const u = (((0.5 + theta / TAU) % 1) + 1) % 1;
            const v = clamp(0.5 - phi / Math.PI, 0, 1);
            const col = Math.min(cols - 1, Math.floor(u * cols));
            const row = Math.min(rows - 1, Math.floor(v * rows));
            const angle = Math.acos(clamp(dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2], -1, 1));
            add(col, row, angle);
        }
    }

    // A visible pole spans every column of its row — near it u varies too fast
    // for grid sampling to be exhaustive, so test the pole point against the
    // frustum directly and add the full row when it shows. With a full pose the
    // TEXTURE pole sits on the pose's up axis (third column of the matrix), not
    // the world pole.
    const poleAxis = panoRot ? [panoRot[6], panoRot[7], panoRot[8]] : [0, 0, 1];
    for (const sign of [1, -1]) {
        const pole = [sign * poleAxis[0], sign * poleAxis[1], sign * poleAxis[2]];
        const pz = pole[0] * forward[0] + pole[1] * forward[1] + pole[2] * forward[2];
        const px = pole[0] * right[0] + pole[1] * right[1] + pole[2] * right[2];
        const py = pole[0] * up[0] + pole[1] * up[1] + pole[2] * up[2];
        if (pz > 1e-9 && Math.abs(px / pz) <= tanX * lim && Math.abs(py / pz) <= tanY * lim) {
            const row = sign > 0 ? 0 : rows - 1;
            const angle = Math.acos(clamp(pz, -1, 1));
            for (let col = 0; col < cols; col++) add(col, row, angle);
        }
    }

    return [...found.values()]
        .map(({col, row, angle}) => ({col, row, priority: angle * (row === 0 || row === rows - 1 ? 2 : 1)}))
        .sort((a, b) => a.priority - b.priority || a.row - b.row || a.col - b.col);
}
