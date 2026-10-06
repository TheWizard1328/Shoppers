// Unified route manifest export helpers — shared across admin, dispatcher, and driver views.
// All roles funnel through the same `generateRouteManifest` backend function, which owns the
// per-driver subtotals, grand totals, COD breakdown, CP envelope counts, store-color swatches,
// and temperature graph rendering. These helpers only build the correct payload per role and
// normalize the response (preview-open vs. email-send) so every role sees the same output.

import { base44 } from "@/api/base44Client";
import { format } from "date-fns";

const isValidEmail = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const normalizeEmails = (emails) =>
  [...new Set((emails || [])
    .map((email) => (typeof email === "string" ? email.trim().toLowerCase() : ""))
    .filter(isValidEmail)
  )];

// Convert a base64 PDF string into an object URL.
const pdfToObjectUrl = (pdfBase64) => {
  const binaryStr = atob(pdfBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/pdf" });
  return URL.createObjectURL(blob);
};

// Open a base64 PDF in a new tab. `existingTab` is a placeholder tab opened
// synchronously at click time (before the long backend call) — browsers block
// window.open() calls that fire long after the user gesture, which is why the
// preview used to finish silently with no PDF appearing (Oct 6 2026 fix).
// If no tab could be pre-opened (popup blocked / WebView), fall back to a
// programmatic anchor download so the PDF still reaches the user.
const openPdfInNewTab = (pdfBase64, existingTab = null) => {
  if (!pdfBase64) return;
  const url = pdfToObjectUrl(pdfBase64);
  if (existingTab && !existingTab.closed) {
    try { existingTab.location.href = url; return; } catch (_) { /* cross-origin write guard */ }
  }
  const opened = window.open(url, "_blank");
  if (!opened) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `route-manifest-${Date.now()}.pdf`;
    a.type = 'application/pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
};

const normalizeResponse = (res) => res?.data || res;

// Build the generateRouteManifest payload for any role.
// role: 'admin' | 'dispatcher' | 'driver'
// Returns the payload object suitable for preview or email export.
export function buildManifestPayload({
  role,
  currentUser,
  driverFilter,
  dispatcherStoreIds = [],
  selectedCityId,
  driverStoreIds = [],
  startDate,
  endDate,
  useBarcodes = false,
  recipientEmails = null,
  storeIdsOverride = null,
  storeName = null,
}) {
  const deliveryDate = startDate;
  const isDriver = role === "driver";
  const isDispatcherOnly = role === "dispatcher";
  const isAdmin = role === "admin";

  // Driver: always scope to the current user's own stops across all stores.
  // Dispatcher: scope to their assigned stores (all drivers).
  // Admin: NEVER scope by the dashboard driver filter — admins export ALL drivers for the
  //   selected date (scoped by city). The dashboard's driver dropdown is for viewing the
  //   map, not for constraining the manifest.
  const driverId = isDriver ? currentUser.id : undefined;

  let storeIds = null;
  if (storeIdsOverride && storeIdsOverride.length > 0) {
    storeIds = storeIdsOverride;
  } else if (isDispatcherOnly) {
    storeIds = dispatcherStoreIds;
  }
  // Admin: no store scope here — driverId or selectedCityId provides the scope.

  const payload = {
    driverId,
    deliveryDate,
    startDate,
    endDate,
    manifestType: "post-route", // backend auto-detects pre-route vs post-route based on actual data
    useBarcodes: useBarcodes === true,
    // Cache-bust token: ensures any service-worker / HTTP cache that keyed on the request body
    // never serves a stale manifest from a previous backend version. Ignore on the backend.
    _v: Date.now(),
  };

  if (storeIds && storeIds.length > 0) payload.storeIds = storeIds;
  if (isDispatcherOnly || isAdmin) payload.selectedCityId = selectedCityId || undefined;
  if (recipientEmails) {
    const valid = normalizeEmails(recipientEmails);
    if (valid.length > 0) payload.recipientEmails = valid;
  }
  if (storeName) payload.storeName = storeName;

  return payload;
}

// Invoke generateRouteManifest for preview (no recipientEmails) and open the returned PDF(s) in a new tab.
// Returns the response data on success (or { error } on failure).
export async function previewRouteManifest(payload, { previewTab = null } = {}) {
  const res = await base44.functions.invoke("generateRouteManifest", payload);
  const data = normalizeResponse(res);
  if (data?.error) return data;

  const pdfsToOpen = Array.isArray(data.pdfResults)
    ? data.pdfResults
    : [{ pdfBase64: data.pdfBase64 }];

  // First PDF goes into the pre-opened placeholder tab (keeps the user-gesture
  // link alive); any additional PDFs open normally with the download fallback.
  pdfsToOpen.forEach(({ pdfBase64 }, index) => {
    openPdfInNewTab(pdfBase64, index === 0 ? previewTab : null);
  });

  return data;
}

// Invoke generateRouteManifest for email delivery (with recipientEmails).
// Returns { success, sent_to } on success, or { error } on failure.
export async function emailRouteManifest(payload) {
  if (!Array.isArray(payload.recipientEmails) || payload.recipientEmails.length === 0) {
    return { error: "Please add at least one valid email address." };
  }
  const res = await base44.functions.invoke("generateRouteManifest", payload);
  return normalizeResponse(res);
}

// Resolve the start/end date defaults from the dialog or selectedDate.
export function resolveDateRange({ dialogStartDate, dialogEndDate, selectedDate }) {
  const fallback = selectedDate ? format(selectedDate, "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd");
  const startDate = dialogStartDate || fallback;
  const endDate = dialogEndDate || startDate;
  return { startDate, endDate };
}

export { isValidEmail, normalizeEmails };