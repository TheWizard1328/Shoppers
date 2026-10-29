// ── Quick "print the route manifest for this date" ───────────────────────────
// Owner request (Oct 28 2026): a printer button on each date card in the Route
// Management date list that generates the SAME PDF the Export Route panel does,
// for the date the button was clicked, and opens it in a preview tab exactly
// like the panel's "Preview" button.
//
// The heavy lifting is the existing pipeline: buildManifestPayload() picks the
// right scope per role and previewRouteManifest() invokes generateRouteManifest
// and drops the returned PDF into a pre-opened tab (browsers block window.open
// fired after a long await, hence the placeholder tab inside the gesture).

import { format } from 'date-fns';
import { userHasRole } from '../utils/userRoles';
import { globalFilters } from '@/components/utils/globalFilters';
import { buildManifestPayload, previewRouteManifest } from './routeManifestExportHelpers';

const resolveRole = (currentUser) => {
  const isAdmin = userHasRole(currentUser, 'admin');
  const isDispatcherOnly = !isAdmin && userHasRole(currentUser, 'dispatcher');
  const isDriver = !isAdmin && !isDispatcherOnly && userHasRole(currentUser, 'driver');
  return isAdmin ? 'admin' : isDispatcherOnly ? 'dispatcher' : isDriver ? 'driver' : null;
};

/**
 * Open the route manifest PDF for `dateValue` in a preview tab.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function printRouteManifestForDate({
  currentUser,
  dateValue,
  deliveries = [],
  driverFilter = null,
} = {}) {
  const role = resolveRole(currentUser);
  const dateStr = dateValue
    ? (typeof dateValue === 'string' ? String(dateValue).slice(0, 10) : format(dateValue, 'yyyy-MM-dd'))
    : null;
  if (!role) return { ok: false, error: 'You do not have permission to export route manifests.' };
  if (!dateStr) return { ok: false, error: 'No date selected.' };

  // Placeholder tab opened SYNCHRONOUSLY inside the click gesture.
  const previewTab = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  if (previewTab && !previewTab.closed) {
    try {
      previewTab.document.write(
        '<!doctype html><html><head><title>Generating PDF…</title></head>' +
        '<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#334155;">' +
        '<div style="text-align:center"><div style="font-size:18px;font-weight:600;margin-bottom:8px">Generating route manifest PDF…</div>' +
        `<div style="font-size:13px;color:#64748b">${dateStr} — this page will fill in automatically.</div></div></body></html>`
      );
      previewTab.document.close();
    } catch (_) { /* keep the tab even if the placeholder write fails */ }
  }

  try {
    const dispatcherStoreIds = currentUser?.store_ids || [];
    const driverStoreIds = [...new Set((deliveries || []).map((d) => d?.store_id).filter(Boolean))];
    const payload = buildManifestPayload({
      role,
      currentUser,
      driverFilter: driverFilter || null,
      dispatcherStoreIds,
      selectedCityId: globalFilters.getSelectedCityId(),
      driverStoreIds,
      startDate: dateStr,
      endDate: dateStr,
      useBarcodes: false,
    });

    const data = await previewRouteManifest(payload, { previewTab });
    if (data?.error) {
      try { if (previewTab && !previewTab.closed) previewTab.close(); } catch (_) {}
      return { ok: false, error: data.error };
    }
    return { ok: true };
  } catch (error) {
    try { if (previewTab && !previewTab.closed) previewTab.close(); } catch (_) {}
    return { ok: false, error: error?.response?.data?.error || error?.message || 'Route preview failed.' };
  }
}
