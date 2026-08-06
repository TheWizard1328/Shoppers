/**
 * Environment detector — returns a short label indicating which build environment
 * the app is currently running in, based on the page hostname.
 *
 *  - wizardworxx.com → (Live)   — published production domain
 *  - preview prefix  → (Prev)   — Base44 preview/sandbox branch build
 *  - anything else   → (Prod)   — production editor / unpublished build
 */
export const getEnvironmentLabel = () => {
  try {
    const hostname = window.location.hostname || '';
    if (hostname.includes('preview')) return '(Prev)';
    if (hostname.includes('wizardworxx.com')) return '(Live)';
    return '(Prod)';
  } catch (_) {
    return '(Prod)';
  }
};