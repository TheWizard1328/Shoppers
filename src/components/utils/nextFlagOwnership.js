/**
 * nextFlagOwnership.js — who is allowed to repair isNextDelivery?
 *
 * OWNER REPORT (Nov 12 2026): "shouldn't the guard be set to the device which
 * initially set the next delivery flag? Dispatchers can't set this flag unless
 * they just created the route, but 90% of the time it's the driver themselves
 * or an administrator that manipulates the route in such a way that it changes
 * the flag."
 *
 * The hourly log backed it up: the SAME stop was restored 12 times in one hour
 * from three dashboards (editor desktop, The-Tablet, Londonderry). Each read a
 * local copy that was a moment behind, saw no next stop and wrote its own pick,
 * so the devices overwrote each other in a loop.
 *
 * Rule now:
 *   1. Whoever WRITES isNextDelivery = true stamps `next_flag_owner` on that
 *      record as "<deviceId>|<epochMs>". It rides the normal write, so it is
 *      visible to every other device (extra fields are tolerated — the
 *      route_commit_ids marker already works this way) and needs no schema.
 *   2. The guard restores only when this device holds the NEWEST claim on the
 *      route. Dispatchers/admins inherit the claim the moment they change the
 *      flag themselves, which is exactly the behaviour the owner described.
 *   3. No claim anywhere (legacy route, server-written flag, first boot) falls
 *      back to the previous primary-device rule, so healing is never lost.
 */

// ── WHO MAY SET THE FLAG (owner rule, Nov 23 2026) ──────────────────────────
// "The isNextDelivery flags should only be getting set via the driver's devices
// or an admin device. Never a dispatcher's device. Unless it's setting it via
// the creating default pickups when the driver's route is empty."
// Layout registers the signed-in user's app_roles here; the single write funnel
// (updateDeliveryLocal) consults it. Unknown roles allow the write, so a driver
// whose roles have not loaded yet is never blocked.
let currentWriterRoles = null;

export function setFlagWriterRoles(roles) {
  currentWriterRoles = Array.isArray(roles) ? roles.slice() : null;
}

export function maySetNextFlag({ allowDefaultPickup = false } = {}) {
  if (allowDefaultPickup) return true;
  if (!Array.isArray(currentWriterRoles)) return true;
  return currentWriterRoles.includes('driver') || currentWriterRoles.includes('admin');
}

const STORAGE_KEY = 'rx_flag_owner_device_id';
let cachedId = null;

/** Stable per-install device id used only for flag ownership. */
export function getFlagOwnerDeviceId() {
  if (cachedId) return cachedId;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      cachedId = existing;
      return cachedId;
    }
    const fresh = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(STORAGE_KEY, fresh);
    cachedId = fresh;
    return cachedId;
  } catch (_) {
    cachedId = cachedId || `mem-${Math.random().toString(36).slice(2, 10)}`;
    return cachedId;
  }
}

/** "<deviceId>|<ms>" for the record that is about to hold the flag. */
export function buildFlagOwnerStamp() {
  return `${getFlagOwnerDeviceId()}|${Date.now()}`;
}

/**
 * Stamp any write payload that SETS the flag. Never overwrites an explicit
 * owner the caller already supplied. Everything else passes through untouched.
 */
export function stampNextFlagOwner(payload) {
  if (!payload || payload.isNextDelivery !== true) return payload;
  if (payload.next_flag_owner) return payload;
  try {
    return { ...payload, next_flag_owner: buildFlagOwnerStamp() };
  } catch (_) {
    return payload;
  }
}

/** Parse one stored claim. Returns {deviceId, at} or null. */
export function parseFlagOwner(value) {
  if (typeof value !== 'string' || !value) return null;
  const idx = value.lastIndexOf('|');
  if (idx <= 0) return null;
  const deviceId = value.slice(0, idx);
  const at = Number(value.slice(idx + 1));
  return { deviceId, at: Number.isFinite(at) ? at : 0 };
}

/**
 * Newest claim across a driver's route for one date.
 * Returns {deviceId, at, stopId} or null when no record carries a claim.
 */
export function newestRouteFlagOwner(routeDeliveries = []) {
  let best = null;
  for (const d of routeDeliveries) {
    const claim = parseFlagOwner(d?.next_flag_owner);
    if (!claim) continue;
    if (!best || claim.at > best.at) best = { ...claim, stopId: d?.id || null };
  }
  return best;
}

/**
 * May THIS device perform a guard restore?
 *
 *  • newest claim is ours            → yes (we set the flag last)
 *  • newest claim is someone else's  → no  (that device owns the flag)
 *  • no claim anywhere               → fall back to the primary-device rule
 */
export function canThisDeviceRestoreNextFlag(routeDeliveries, { isPrimaryDevice = null } = {}) {
  const claim = newestRouteFlagOwner(routeDeliveries);
  const mine = getFlagOwnerDeviceId();
  if (claim) return claim.deviceId === mine;

  if (typeof isPrimaryDevice === 'boolean') return isPrimaryDevice;
  if (typeof window === 'undefined') return true;
  if (window.__isPrimaryDevice === true) return true;
  if (window.__isPrimaryDevice === false) return false;
  return true; // registry not resolved yet — keep healing like before
}
