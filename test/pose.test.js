import {describe, expect, test} from 'vitest';
import {panoPoseMatrix, poseTransform} from '../src/pose.js';

// Rendering-side pose maths only: the editing algebra (composePoseGesture,
// poseFromMatrix, …) lives in maplibre-gl-panoramax with its own suite.

const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

const azDir = (azDeg, elDeg = 0) => {
    const a = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
    return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
};

describe('panoPoseMatrix', () => {
    test('yaw-only reproduces theta − panoYaw', () => {
        for (const yaw of [0, 37, 180, 271]) {
            const m = panoPoseMatrix(yaw, 0, 0);
            for (const az of [0, 45, 200, 300]) {
                const nc = poseTransform(m, azDir(az));
                const theta = Math.atan2(nc[0], nc[1]);
                const expected = Math.atan2(Math.sin(((az - yaw) * Math.PI) / 180), Math.cos(((az - yaw) * Math.PI) / 180));
                close(theta, expected);
            }
        }
    });

    test('the capture forward direction maps to the image centre', () => {
        const m = panoPoseMatrix(40, 25, 0);
        const nc = poseTransform(m, azDir(40, 25));
        close(Math.atan2(nc[0], nc[1]), 0);
        close(Math.asin(nc[2]), 0);
    });

    test('stays orthonormal for any pose', () => {
        const m = panoPoseMatrix(123, -37, 21);
        const r = [m[0], m[3], m[6]], f = [m[1], m[4], m[7]], u = [m[2], m[5], m[8]];
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        for (const v of [r, f, u]) close(dot(v, v), 1);
        close(dot(r, f), 0);
        close(dot(f, u), 0);
        close(dot(u, r), 0);
    });

    test('valid at pitch ±90 (no degenerate cross product)', () => {
        const nc = poseTransform(panoPoseMatrix(0, 90, 0), [0, 0, 1]);
        close(nc[1], 1);
    });
});
