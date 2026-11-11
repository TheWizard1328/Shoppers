/**
 * torchBridge.jsx — thin wrapper over the native RxTorch JavaScript interface.
 *
 * OWNER SPEC (Nov 10 2026): the flashlight FAB ships on the Android APK only.
 * A PWA cannot hold a CameraManager torch at all, and the WebView exposes no
 * torch API, so MainActivity registers window.RxTorch with:
 *   isAvailable() -> boolean, isOn() -> boolean, set(enable) -> status string
 *
 * Every function here is a no-op / false on web so callers stay branch-free.
 */

const bridge = () => {
  if (typeof window === 'undefined') return null;
  const b = window.RxTorch;
  return b && typeof b.set === 'function' ? b : null;
};

export function isTorchBridgeAvailable() {
  const b = bridge();
  if (!b) return false;
  try {
    return b.isAvailable() === true;
  } catch {
    return false;
  }
}

export function isNativeTorchOn() {
  const b = bridge();
  if (!b) return false;
  try {
    return b.isOn() === true;
  } catch {
    return false;
  }
}

/**
 * @returns {'on'|'off'|'permission'|'no_torch'|'error'|'unavailable'}
 * 'permission' means Android just asked for the CAMERA grant; the native side
 * switches the torch on by itself once granted.
 */
export function setNativeTorch(enable) {
  const b = bridge();
  if (!b) return 'unavailable';
  try {
    return b.set(!!enable);
  } catch {
    return 'error';
  }
}
