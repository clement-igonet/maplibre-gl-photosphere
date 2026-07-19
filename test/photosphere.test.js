// @vitest-environment jsdom
import {describe, expect, test, vi} from 'vitest';

vi.mock('maplibre-gl', () => ({
    MercatorCoordinate: class {
        constructor(x, y) {
            this.x = x;
            this.y = y;
        }
        static fromLngLat(lngLat) {
            const lng = Array.isArray(lngLat) ? lngLat[0] : lngLat.lng;
            const lat = Array.isArray(lngLat) ? lngLat[1] : lngLat.lat;
            return new this(lng / 360 + 0.5, 0.5 - lat / 180);
        }
        meterInMercatorCoordinateUnits() {
            return 1e-7;
        }
        toLngLat() {
            return {lng: (this.x - 0.5) * 360, lat: (0.5 - this.y) * 180};
        }
    }
}));

const {Photosphere} = await import('../src/index.js');

function fakeMap() {
    const handler = {enable: vi.fn(), disable: vi.fn()};
    return {
        loaded: () => true,
        style: {},
        addLayer: vi.fn(),
        removeLayer: vi.fn(),
        getLayer: vi.fn(() => true),
        getContainer: () => document.createElement('div'),
        getCenter: () => ({lng: 0, lat: 0}),
        getZoom: () => 17,
        getPitch: () => 60,
        getBearing: () => 0,
        getCenterElevation: () => 0,
        calculateCameraOptionsFromTo: vi.fn(() => ({zoom: 18, bearing: 0, pitch: 90, center: [0, 0]})),
        jumpTo: vi.fn(),
        triggerRepaint: vi.fn(),
        on: vi.fn(),
        dragPan: handler,
        dragRotate: handler,
        scrollZoom: handler,
        doubleClickZoom: handler,
        touchZoomRotate: handler,
        keyboard: handler
    };
}

describe('Photosphere', () => {
    test('requires lngLat and imageUrl', () => {
        expect(() => new Photosphere(fakeMap(), {})).toThrow();
    });

    test('adds its custom layer to a loaded map', () => {
        const map = fakeMap();
        new Photosphere(map, {lngLat: [2, 48], imageUrl: 'x.jpg'});
        expect(map.addLayer).toHaveBeenCalledOnce();
        expect(map.addLayer.mock.calls[0][0].type).toBe('custom');
    });

    test('starts outside, enter() disables map interaction and transitions to inside', () => {
        vi.useFakeTimers();
        const map = fakeMap();
        const onEnter = vi.fn();
        const photosphere = new Photosphere(map, {lngLat: [2, 48], imageUrl: 'x.jpg', durationMs: 10, onEnter});
        expect(photosphere.mode).toBe('outside');

        photosphere.enter();
        expect(photosphere.mode).toBe('entering');
        expect(map.dragPan.disable).toHaveBeenCalled();

        vi.advanceTimersByTime(1000);
        expect(photosphere.mode).toBe('inside');
        expect(onEnter).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    test('exit() returns to outside and re-enables map interaction', () => {
        vi.useFakeTimers();
        const map = fakeMap();
        const photosphere = new Photosphere(map, {lngLat: [2, 48], imageUrl: 'x.jpg', durationMs: 10});
        photosphere.enter();
        vi.advanceTimersByTime(1000);

        photosphere.exit();
        expect(photosphere.mode).toBe('exiting');
        vi.advanceTimersByTime(1000);
        expect(photosphere.mode).toBe('outside');
        expect(map.dragPan.enable).toHaveBeenCalled();
        vi.useRealTimers();
    });

    test('remove() detaches the layer', () => {
        const map = fakeMap();
        const photosphere = new Photosphere(map, {lngLat: [2, 48], imageUrl: 'x.jpg'});
        photosphere.remove();
        expect(map.removeLayer).toHaveBeenCalledOnce();
    });
});
