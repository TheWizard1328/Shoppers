/**
 * etaCascadeUtil.js — shared ETA-cascade math for the completion/restart paths.
 *
 * OWNER RULE (Oct 15 2026): the incomplete stops' ETAs update ONLY via the ETA
 * calculator — the chain anchors to the MOST RECENT FINISHED stop's
 * actual_delivery_time (backdated for retro) and each stop's ETA is
 * anchor + travel + 2-min dwell. Regular timing keeps the Sep 29 window-floor
 * clamp (ETA never displays before the stop's delivery start window); RETRO
 * timing skips the clamp (retro routes run outside delivery windows by
 * definition — clamping made ETAs look like they computed FROM the window).
 *
 * Returns [{ id, delivery_time_eta }] for the given stops (already sorted in
 * route order by the caller). No writes here — callers commit silently.
 */

const toWindowMinutes = (t) => {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
};

/** Parse 'YYYY-MM-DDTHH:MM(:SS)' or 'HH:MM' into minutes-past-midnight. */
export const parseAnchorToMinutes = (anchorTime) => {
  if (!anchorTime) return null;
  const str = String(anchorTime).trim();
  let m = str.match(/^(\d{1,2}):(\d{2})$/); // bare HH:MM
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})/); // ISO local
  if (m) return parseInt(m[4], 10) * 60 + parseInt(m[5], 10);
  return null;
};

/**
 * @param {number} anchorMinutes minutes-past-midnight (most recent finished
 *   stop's actual completion time; backdated for retro).
 * @param {Array}  stops route-ordered incomplete stops.
 * @param {boolean} skipWindowFloor TRUE for retro timing.
 * @returns {Array<{id, delivery_time_eta}>}
 */
export const computeCascadeEtas = ({ anchorMinutes, stops, skipWindowFloor }) => {
  if (!Number.isFinite(anchorMinutes) || !Array.isArray(stops) || stops.length === 0) return [];
  let currentEtaMinutes = anchorMinutes;
  const updates = [];
  for (const stop of stops) {
    if (!stop?.id) continue;
    currentEtaMinutes += (stop.estimated_duration_minutes || 5);
    if (!skipWindowFloor) {
      const windowStartMin = toWindowMinutes(stop.delivery_time_start || stop.time_window_start);
      if (windowStartMin != null && currentEtaMinutes < windowStartMin) {
        currentEtaMinutes = windowStartMin;
      }
    }
    const newEtaHours = Math.floor((currentEtaMinutes % 1440) / 60);
    const newEtaMins = currentEtaMinutes % 60;
    updates.push({
      id: stop.id,
      delivery_time_eta: `${String(newEtaHours).padStart(2, '0')}:${String(newEtaMins).padStart(2, '0')}`,
    });
    currentEtaMinutes += 2; // dwell before the next stop's travel starts
  }
  return updates;
};
