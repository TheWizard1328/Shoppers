import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * trimPatientHistory — one-off maintenance sweep for oversize Patient records.
 *
 * WHY: appendToHistory() caps the embedded patient.delivery_history cache at
 * MAX_HISTORY_ENTRIES (20) since Oct 19 2026, and 162 bloated records were
 * trimmed then. Records whose array was later rebuilt wholesale (history
 * backfills write the full merged array, deduped and sorted but NOT capped)
 * slipped back over the cap. A Patient record past ~10 KB cannot be broadcast
 * over realtime: the platform slims it to a stub and every device in the fleet
 * then does a full Patient.get to fill it in, which is the oversize-broadcast
 * noise in the hourly digest (patient 68e156d4b5b79aa33ef88d76 / Della
 * Lavallie, 90+ entries, Nov 10 2026).
 *
 * SAFETY:
 *  - Admin only.
 *  - dryRun defaults to TRUE. Nothing is written unless { apply: true }.
 *  - Only the newest 20 entries by delivery_date + actual_delivery_time are
 *    kept, deduped by delivery id, newest first. The array is a convenience
 *    cache, not the source of truth: every history view (dashboard panel,
 *    Patients page) reads the Delivery entity directly with patient_id, so
 *    trimming loses nothing user-visible.
 *  - last_delivery_date is never moved backwards: it keeps the newer of the
 *    existing value and the newest kept entry.
 *
 * POST body: { apply?: boolean, limit?: number (max patients to touch), ids?: string[] }
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const payload = await req.json().catch(() => ({}));
    const apply = payload?.apply === true;
    const maxTouch = Number.isFinite(payload?.limit) ? Math.max(1, Number(payload.limit)) : 5000;
    const onlyIds = Array.isArray(payload?.ids) ? payload.ids.filter(Boolean) : null;
    const CAP = 20;

    const sortNewest = (a, b) => {
      const ad = String(a?.delivery_date || '');
      const bd = String(b?.delivery_date || '');
      if (ad !== bd) return bd.localeCompare(ad);
      return String(b?.actual_delivery_time || '').localeCompare(String(a?.actual_delivery_time || ''));
    };

    // ── Load patients (paged; only the fields this job needs) ────────────────
    const patients = [];
    const PAGE = 200;
    for (let skip = 0; skip < 20000; skip += PAGE) {
      const page = await base44.asServiceRole.entities.Patient
        .list('-created_date', PAGE, skip)
        .catch(() => []);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const p of page) {
        if (!p?.id) continue;
        if (onlyIds && !onlyIds.includes(p.id)) continue;
        patients.push({
          id: p.id,
          patient_id: p.patient_id || '',
          full_name: p.full_name || '',
          delivery_history: Array.isArray(p.delivery_history) ? p.delivery_history : [],
          last_delivery_date: p.last_delivery_date || null,
        });
      }
      if (page.length < PAGE) break;
    }

    const offenders = [];
    const results = [];
    let touched = 0;
    let failed = 0;

    for (const p of patients) {
      const original = p.delivery_history;
      if (original.length <= CAP) continue;

      const seen = new Set();
      const deduped = [];
      for (const raw of original) {
        if (!raw || typeof raw !== 'object') continue;
        const key = raw.id || `${raw.delivery_date}|${raw.actual_delivery_time}|${raw.status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push({
          id: raw.id,
          delivery_date: raw.delivery_date,
          actual_delivery_time: raw.actual_delivery_time,
          status: raw.status,
        });
      }
      deduped.sort(sortNewest);
      const capped = deduped.slice(0, CAP);
      const sizeBefore = JSON.stringify(original).length;
      const sizeAfter = JSON.stringify(capped).length;
      const newestKept = capped[0]?.delivery_date || null;
      const lastDate = p.last_delivery_date && newestKept && p.last_delivery_date > newestKept
        ? p.last_delivery_date
        : (p.last_delivery_date || newestKept);

      const row = {
        id: p.id,
        patient_id: p.patient_id,
        full_name: p.full_name,
        before: original.length,
        after: capped.length,
        bytes_before: sizeBefore,
        bytes_after: sizeAfter,
        newest_kept: newestKept,
        last_delivery_date: lastDate,
      };
      offenders.push(row);

      if (!apply) continue;
      if (touched >= maxTouch) continue;
      try {
        await base44.asServiceRole.entities.Patient.update(p.id, {
          delivery_history: capped,
          last_delivery_date: lastDate,
        });
        touched++;
        results.push({ ...row, ok: true });
        // Small spacing so the write burst cannot trip the account-wide limiter.
        await new Promise((r) => setTimeout(r, 60));
      } catch (err) {
        failed++;
        results.push({ ...row, ok: false, error: String(err?.message || err) });
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    offenders.sort((a, b) => b.bytes_before - a.bytes_before);

    return Response.json({
      dry_run: !apply,
      scanned: patients.length,
      over_cap: offenders.length,
      touched,
      failed,
      cap: CAP,
      total_bytes_reclaimed: offenders.reduce((s, o) => s + Math.max(0, o.bytes_before - o.bytes_after), 0),
      offenders: offenders.slice(0, 40),
      write_results: apply ? results.slice(0, 40) : [],
    });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
});
