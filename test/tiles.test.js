import {describe, expect, test} from 'vitest';
import {visibleTiles} from '../src/tiles.js';

// Panoramax's usual HD derivate grid: 8 columns × 4 rows. Row boundaries sit
// at pitch ±45°, column boundaries every 45° of azimuth (seam at yaw 180 when
// panoYaw is 0, since the image centre u = 0.5 faces panoYaw).
const grid = {fovDeg: 75, aspect: 16 / 9, cols: 8, rows: 4};

const key = (t) => `${t.col}x${t.row}`;

describe('visibleTiles', () => {
    test('looking straight ahead picks the facing tile first', () => {
        const tiles = visibleTiles({...grid, yawDeg: 0, pitchDeg: 0});
        // yaw 0 → u = 0.5 → col 4; pitch 0 → v = 0.5 → row 2.
        expect(tiles[0]).toMatchObject({col: 4, row: 2});
        expect(tiles.length).toBeGreaterThan(1);
    });

    test('all tiles stay inside the grid bounds', () => {
        for (const yawDeg of [0, 90, 180, 270, 359]) {
            for (const pitchDeg of [-80, -30, 0, 30, 80]) {
                for (const t of visibleTiles({...grid, yawDeg, pitchDeg})) {
                    expect(t.col).toBeGreaterThanOrEqual(0);
                    expect(t.col).toBeLessThan(grid.cols);
                    expect(t.row).toBeGreaterThanOrEqual(0);
                    expect(t.row).toBeLessThan(grid.rows);
                }
            }
        }
    });

    test('seam wrap: looking across u = 0/1 includes both edge columns', () => {
        const tiles = visibleTiles({...grid, yawDeg: 180, pitchDeg: 0});
        const cols = new Set(tiles.map((t) => t.col));
        expect(cols.has(0)).toBe(true);
        expect(cols.has(grid.cols - 1)).toBe(true);
        // And the two seam-adjacent columns are the closest to the view centre.
        expect([0, grid.cols - 1]).toContain(tiles[0].col);
    });

    test('pole case: looking up loads every column of the top row', () => {
        const tiles = visibleTiles({...grid, yawDeg: 90, pitchDeg: 80});
        const topCols = new Set(tiles.filter((t) => t.row === 0).map((t) => t.col));
        expect(topCols.size).toBe(grid.cols);
    });

    test('pole case: looking down loads every column of the bottom row', () => {
        const tiles = visibleTiles({...grid, yawDeg: 210, pitchDeg: -80});
        const bottomCols = new Set(tiles.filter((t) => t.row === grid.rows - 1).map((t) => t.col));
        expect(bottomCols.size).toBe(grid.cols);
    });

    test('level look near the horizon does not fetch the pole rows', () => {
        const tiles = visibleTiles({...grid, yawDeg: 0, pitchDeg: 0});
        expect(tiles.every((t) => t.row === 1 || t.row === 2)).toBe(true);
    });

    test('priority ordering: ascending, centre-first, pole rows deprioritized', () => {
        // FOV 100 at pitch 40° puts the up pole inside the frustum while the
        // view centre stays in a mid row — pole tiles present but never first.
        // (At narrower FOVs the pole only shows once the centre is already in
        // the top row, where a pole tile ranking first is correct.)
        const tiles = visibleTiles({...grid, fovDeg: 100, yawDeg: 0, pitchDeg: 40});
        for (let i = 1; i < tiles.length; i++) {
            expect(tiles[i].priority).toBeGreaterThanOrEqual(tiles[i - 1].priority);
        }
        expect(tiles.some((t) => t.row === 0)).toBe(true);
        expect(tiles[0].row).not.toBe(0);
        // The ×2 pole factor: the best pole tile ranks behind the best mid tile
        // even though the pole is angularly close to the view direction.
        const bestPole = Math.min(...tiles.filter((t) => t.row === 0).map((t) => t.priority));
        expect(bestPole).toBeGreaterThan(tiles[0].priority);
    });

    test('panoYaw rotates the sampled columns with the image', () => {
        // Looking at world azimuth 90 in an image whose centre faces 90 must
        // sample the same tiles as looking at 0 in a north-facing image.
        const north = visibleTiles({...grid, yawDeg: 0, pitchDeg: 10});
        const east = visibleTiles({...grid, yawDeg: 90, pitchDeg: 10, panoYawDeg: 90});
        expect(east.map(key).sort()).toEqual(north.map(key).sort());
    });

    test('duplicate samples collapse to one tile with the best priority', () => {
        const tiles = visibleTiles({...grid, yawDeg: 0, pitchDeg: 0});
        const keys = tiles.map(key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});
