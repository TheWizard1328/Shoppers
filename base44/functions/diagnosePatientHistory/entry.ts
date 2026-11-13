import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Diagnostic for the 7 patients whose delivery_history backfill write always
// fails in backfillPatientHistoryPaced (error swallowed as "write failed").
// Body: { patient_ids: string[] }
// Returns per patient: current history size, the computed history size, and the
// REAL error message/status from a dry-run update attempt.
Deno.serve(async (req) => {
  try {
    const db = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body?.patient_ids) ? body.patient_ids.slice(0, 12) : [];
    const PAGE = 500;
    const out = [];

    for (const pid of ids) {
      const rec = { patient_id: pid };
      try {
        const p = await db.entities.Patient.get(pid);
        rec.patient_name = p?.full_name || p?.name || null;
        const hist = Array.isArray(p?.delivery_history) ? p.delivery_history : [];
        rec.existing_history_len = hist.length;
        rec.existing_history_bytes = JSON.stringify(hist).length;
        rec.record_bytes = JSON.stringify(p || {}).length;
        rec.last_delivery_date = p?.last_delivery_date ?? null;
        rec.patient_keys = Object.keys(p || {}).length;

        // Recompute the same shape the backfill writes, from this patient's deliveries.
        const deliveries = await db.entities.Delivery.filter({ patient_id: pid }, '-delivery_date', PAGE, 0).catch(() => []);
        rec.deliveries_fetched = Array.isArray(deliveries) ? deliveries.length : 0;
        const terminal = (deliveries || []).filter((d) => ['completed', 'failed', 'returned'].includes(String(d?.status || '').toLowerCase()));
        rec.terminal_deliveries = terminal.length;
        const cleaned = terminal.map((d) => ({
          id: d.id,
          delivery_date: d.delivery_date,
          actual_delivery_time: d.actual_delivery_time,
          status: d.status,
        }));
        rec.new_history_len = cleaned.length;
        rec.new_history_bytes = JSON.stringify(cleaned).length;

        // Attempt the write on the smallest field only, to separate "record is
        // too big" from "these specific fields are rejected".
        try {
          await db.entities.Patient.update(pid, { last_delivery_date: p?.last_delivery_date ?? null });
          rec.small_write_ok = true;
        } catch (e) {
          rec.small_write_ok = false;
          rec.small_write_error = String(e?.message || e);
          rec.small_write_status = e?.response?.status || null;
          rec.small_write_body = String(e?.response?.data ? JSON.stringify(e.response.data) : '').slice(0, 400);
        }
        try {
          await db.entities.Patient.update(pid, { delivery_history: hist });
          rec.history_write_ok = true;
        } catch (e) {
          rec.history_write_ok = false;
          rec.history_write_error = String(e?.message || e);
          rec.history_write_status = e?.response?.status || null;
          rec.history_write_body = String(e?.response?.data ? JSON.stringify(e.response.data) : '').slice(0, 400);
        }
      } catch (e) {
        rec.fatal = String(e?.message || e);
      }
      out.push(rec);
    }
    return Response.json({ results: out });
  } catch (error) {
    return Response.json({ error: String(error?.message || error) }, { status: 500 });
  }
});
