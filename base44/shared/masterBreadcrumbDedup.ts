// base44/shared/masterBreadcrumbDedup.ts
//
// Helpers for dealing with DUPLICATE master breadcrumb records (stop_order = -1).
//
// A known race in syncPendingBreadcrumbs can create more than one master record
// for the same driver/date. When consolidateBreadcrumbSegment reads the master
// trail and merges duplicates by timestamp, a stale RAW (unsnapped) duplicate
// can overwrite the snapped master for overlapping timestamps — causing the
// reclip (Scissors) to slice per-stop segments from the original raw GPS trail
// instead of the road-snapped one.
//
// These helpers let snapMasterTimeline mark its saved master as `is_snapped`
// and delete the stale duplicates, and let consolidateBreadcrumbSegment pick
// the snapped master (when one exists) and clean up the rest.

// Picks the single best master record from a list:
//   1. Prefer any record with `is_snapped === true` (most recently updated among them).
//   2. Otherwise fall back to the most recently updated record.
// Returns { best, rest } where `rest` are duplicates that should be deleted.
export function pickBestMaster(records: any[] | null | undefined): { best: any | null; rest: any[] } {
  if (!records || records.length === 0) return { best: null, rest: [] };
  const byRecency = (a: any, b: any) =>
    new Date(b?.updated_date || b?.created_date || 0).getTime() -
    new Date(a?.updated_date || a?.created_date || 0).getTime();

  const snapped = records.filter((r) => r?.is_snapped === true);
  const pool = snapped.length > 0 ? snapped : records;
  const sorted = [...pool].sort(byRecency);
  const best = sorted[0] ?? null;
  const bestId = best?.id;
  const rest = records.filter((r) => r?.id && r.id !== bestId);
  return { best, rest };
}

// Deletes every master record (stop_order = -1) for the given driver/date
// except the one with id === keepId. Returns the number deleted. Non-critical:
// swallows per-record delete errors so a single failure can't abort the run.
export async function dedupMasterBreadcrumbs(
  base44: any,
  driver_id: string,
  delivery_date: string,
  keepId: string | null,
): Promise<number> {
  let deleted = 0;
  try {
    const allMasters = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1,
    });
    for (const m of (allMasters || [])) {
      if (m?.id && m.id !== keepId) {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(m.id).catch(() => null);
        deleted++;
      }
    }
  } catch (_) {
    // non-critical — duplicate cleanup is best-effort
  }
  return deleted;
}