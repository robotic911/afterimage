/* global __AFTERIMAGE_BUILD__ */

const FALLBACK_BUILD = Object.freeze({
  productName: 'Afterimage',
  version: 'unknown',
  commit: 'unknown',
  timestamp: 'unknown',
});

export const AFTERIMAGE_BUILD = Object.freeze(
  typeof __AFTERIMAGE_BUILD__ === 'object' && __AFTERIMAGE_BUILD__
    ? __AFTERIMAGE_BUILD__
    : FALLBACK_BUILD,
);

export function createAfterimageBuildPayload(runtimeInfo = {}) {
  return {
    ...AFTERIMAGE_BUILD,
    rendererMode: import.meta.env.MODE,
    rendererDev: import.meta.env.DEV,
    rendererProd: import.meta.env.PROD,
    rendererVersion: import.meta.env.VITE_AFTERIMAGE_RENDERER_VERSION || null,
    ...runtimeInfo,
  };
}
