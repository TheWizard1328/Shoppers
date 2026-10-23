import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * patientPortalWatchers — read side of the patient-portal presence system.
 *
 * Dashboards poll this once a minute for their selected date; the client then
 * intersects the returned watcher list with the deliveries the current user
 * can see (driver: own route / dispatcher: own stores / admin: viewed driver),
 * which enforces the "patient must have a delivery for that date" gate and all
 * role scoping client-side.
 *
 * Body: { delivery_date }
 * Returns: { watchers: [{ patient_id, patient_name, driver_id, driver_name, store_id, last_ping_at }] }
 * A patient is "watching" when their last ping is within WATCH_WINDOW_MS (2.5x
 * the 30s ping cadence — survives one dropped ping).
 */
const WATCH_WINDOW_MS = 75000;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { delivery_date } = await req.json();

    if (!delivery_date) {
      return Response.json({ error: 'delivery_date is required' }, { status: 400 });
    }

    const rows = await base44.asServiceRole.entities.PatientPortalPresence.filter({
      delivery_date,
    }).catch(() => []);

    const cutoff = Date.now() - WATCH_WINDOW_MS;
    const watchers = (rows || [])
      .filter((r) => {
        if (!r?.last_ping_at || !r?.patient_id) return false;
        const t = Date.parse(r.last_ping_at);
        return Number.isFinite(t) && t >= cutoff;
      })
      .map((r) => ({
        patient_id: r.patient_id,
        patient_name: r.patient_name || '',
        driver_id: r.driver_id || '',
        driver_name: r.driver_name || '',
        store_id: r.store_id || '',
        last_ping_at: r.last_ping_at,
      }));

    return Response.json({ watchers });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
