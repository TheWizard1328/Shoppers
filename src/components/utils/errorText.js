/**
 * errorText — always get a STRING out of a thrown value.
 *
 * WHY THIS EXISTS (owner report Nov 19 2026, Sharuk's device 39f5af47):
 * a breadcrumb sync failed with a 500, and the catch block that inspects the
 * failure did `error?.message?.includes('429')`. Optional chaining only guards
 * null/undefined — it does NOT guard "not a string". The SDK rejected with an
 * error whose `message` was not a string, so `.includes` was undefined and
 * calling it threw `N.includes is not a function`. That TypeError escaped the
 * catch block, escaped collectBreadcrumbForTracker entirely, and landed in the
 * tracker's outer catch as "Failed to collect breadcrumb" — aborting the rest
 * of the crumb commit (no chain advance, no live-map event) on a path where the
 * crumb had actually been written locally.
 *
 * Rule: never call a String method on error.message. Run it through here first.
 */
export function errorText(error, fallback = 'Unknown error') {
  if (error == null) return fallback;
  if (typeof error === 'string') return error || fallback;
  const msg = error.message;
  if (typeof msg === 'string' && msg) return msg;
  if (msg != null) {
    // Objects/numbers land here when a rejection carries a non-string message
    // (a JSON body, a code, an array). Stringify them so the log stays useful.
    try {
      if (typeof msg === 'object') {
        const json = JSON.stringify(msg);
        if (json && json !== '{}') return json;
      } else {
        const asString = String(msg);
        if (asString) return asString;
      }
    } catch (_) { /* fall through */ }
  }
  try {
    const asString = String(error);
    return asString && asString !== '[object Object]' ? asString : fallback;
  } catch (_) {
    return fallback;
  }
}

/** Lowercased errorText, for case-insensitive matching. */
export function errorTextLower(error, fallback = 'Unknown error') {
  return errorText(error, fallback).toLowerCase();
}

/** HTTP status carried by an error, if any (axios-style or plain). */
export function errorStatus(error) {
  const status = error?.response?.status ?? error?.status;
  const n = Number(status);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when an error is a rate-limit rejection. Never throws, whatever shape
 * the rejection takes.
 */
export function isRateLimitError(error) {
  if (errorStatus(error) === 429) return true;
  const text = errorTextLower(error, '');
  return text.includes('429') || text.includes('rate limit') || text.includes('rate-limit');
}

export default errorText;
