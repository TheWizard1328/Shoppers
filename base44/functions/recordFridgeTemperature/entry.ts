import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Cold-chain thresholds (°C)
const TEMP_MIN       = 2;
const TEMP_MAX       = 6;
const TEMP_PREFERRED = 4;

// Edmonton / Mountain Time offset from UTC (MST = -7, MDT = -6).
// We derive local date from the timestamp field the client sends, which is
// already a local ISO string (YYYY-MM-DDTHH:MM:SS with no Z suffix).
// If the client sends a UTC Z-suffixed string we fall back to server wall-clock
// interpreted as Mountain Time via offset detection.
function localDateFromTimestamp(ts: string): string {
  if (!ts) {
    // No timestamp supplied — use server UTC and apply Mountain Time offset
    const now = new Date();
    // Mountain Time: UTC-7 (MST) or UTC-6 (MDT)
    // Detect DST: MDT is second Sunday in March through first Sunday in November
    const year = now.getUTCFullYear();
    const dstStart = getNthSundayUTC(year, 2, 2);  // 2nd Sunday of March
    const dstEnd   = getNthSundayUTC(year, 10, 1); // 1st Sunday of November
    const utcMs    = now.getTime();
    const offsetMs = (utcMs >= dstStart && utcMs < dstEnd) ? -6 * 3600000 : -7 * 3600000;
    const local    = new Date(utcMs + offsetMs);
    return isoDate(local);
  }

  // Client sends local ISO string like "2026-06-11T01:14:32" — no Z/offset
  // Just take the date portion directly
  const clean = ts.replace('Z', '').replace(/[+-]\d{2}:\d{2}$/, '');
  return clean.substring(0, 10); // YYYY-MM-DD
}

function getNthSundayUTC(year: number, month: number, nth: number): number {
  // month is 0-indexed (2=March, 10=November)
  const d = new Date(Date.UTC(year, month, 1));
  const day = d.getUTCDay(); // 0=Sun
  const firstSunday = day === 0 ? 1 : 8 - day;
  const nthSunday = firstSunday + (nth - 1) * 7;
  return Date.UTC(year, month, nthSunday, 2, 0, 0); // 2:00 AM UTC
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const {
      temperatureCelsius,
      deliveryDate,
      driverId,
      timestamp,
      trigger,      // 'change' | 'heartbeat' | 'arrived' | 'completed' | 'failed'
      input_method, // 'ble' | 'manual'
      sensor_mac,   // BLE device name / MAC, null for manual
    } = body || {};

    if (temperatureCelsius === undefined || temperatureCelsius === null) {
      return Response.json({ error: 'temperatureCelsius is required' }, { status: 400 });
    }
    if (!driverId) {
      return Response.json({ error: 'driverId is required' }, { status: 400 });
    }

    // ── Date resolution (most critical fix) ──────────────────────────────────
    // Priority:
    //   1. Use the local date derived from the timestamp the client sends
    //      (client already builds a local ISO string, so just take the date part)
    //   2. Fall back to deliveryDate if provided and looks like YYYY-MM-DD
    //   3. Last resort: derive from server wall-clock in Mountain Time
    let resolvedDate: string;
    if (timestamp) {
      resolvedDate = localDateFromTimestamp(timestamp);
    } else if (deliveryDate && /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
      resolvedDate = deliveryDate;
    } else {
      resolvedDate = localDateFromTimestamp(''); // server wall-clock fallback
    }

    const readingTimestamp = timestamp || (() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    })();

    const reading = {
      timestamp: readingTimestamp,
      temperature_celsius: Number(temperatureCelsius),
      recorded_by_driver_id: driverId,
      ...(trigger      ? { trigger }      : {}),
      ...(input_method ? { input_method } : {}),
      ...(sensor_mac   ? { sensor_mac }   : {}),
    };

    // One RxTempLogs record per driver per date — find-or-create
    const existing = await base44.asServiceRole.entities.RxTempLogs.filter({
      delivery_date: resolvedDate,
      driver_id: driverId
    });

    const existingLog    = existing?.[0];
    const existingReadings = Array.isArray(existingLog?.temperature_readings)
      ? existingLog.temperature_readings
      : [];
    const updatedReadings = [...existingReadings, reading];

    const latestReading = {
      timestamp: reading.timestamp,
      temperature_celsius: reading.temperature_celsius,
      ...(trigger      ? { trigger }      : {}),
      ...(input_method ? { input_method } : {}),
      ...(sensor_mac   ? { sensor_mac }   : {}),
    };

    if (existingLog) {
      await base44.asServiceRole.entities.RxTempLogs.update(existingLog.id, {
        temperature_readings: updatedReadings,
        latest_reading: latestReading,
      });
    } else {
      await base44.asServiceRole.entities.RxTempLogs.create({
        delivery_date: resolvedDate,
        driver_id: driverId,
        temperature_readings: updatedReadings,
        latest_reading: latestReading,
      });
    }

    const isOutOfRange = Number(temperatureCelsius) < TEMP_MIN || Number(temperatureCelsius) > TEMP_MAX;

    return Response.json({
      success: true,
      reading,
      resolvedDate,
      totalReadings: updatedReadings.length,
      isOutOfRange,
      thresholds: { min: TEMP_MIN, max: TEMP_MAX, preferred: TEMP_PREFERRED }
    });

  } catch (error) {
    return Response.json({ error: error?.message || 'Server error' }, { status: 500 });
  }
});
