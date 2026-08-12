// Re-exports the UMD global as a module, so `import {...} from 'maplibre-gl'`
// resolves in the browser without a bundler.
export const MercatorCoordinate = globalThis.maplibregl.MercatorCoordinate;
export default globalThis.maplibregl;
