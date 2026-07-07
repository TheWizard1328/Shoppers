import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Cold-chain thresholds (°C)
const TEMP_MIN       = 2;
const TEMP_MAX       = 6;
const TEMP_PREFERRED = 4;

function localDateFromTimestamp(ts: string): string {
  if (!ts) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const dstStart = getNthSundayUTC(year, 2, 2);
    const dstEnd   = getNthSundayUTC(year, 10, 1);
    const utcMs    = now.getTime();
    const offsetMs = (utcMs >= dstStart && utcMs < dstEnd) ? -6 * 3600000 : -7 * 3600000;
    const local    = new Date(utcMs + offsetMs);
    return isoDate(local);
  }
  const clean = ts.replace('Z', '').replace(/[+-]\d{2}:\d{2}$/, '');
  return clean.substring(0, 10);
}

function getNthSundayUTC(year: number, month: number, nth: number): number {
  const d = new Date(Date.UTC(year, month, 1));
  const day = d.getUTCDay();
  const firstSunday = day === 0 ? 1 : 8 - day;
  const nthSunday = firstSunday + (nth - 1) * 7;
  return Date.UTC(year, month, nthSunday, 2, 0, 0);
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isOutOfRange(t: number): boolean {
  return t < TEMP_MIN || t > TEMP_MAX;
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
      trigger,
      input_method,
      sensor_mac,
    } = body || {};

    if (temperatureCelsius === undefined || temperatureCelsius === null) {
      return Response.json({ error: 'temperatureCelsius is required' }, { status: 400 });
    }
    if (!driverId) {
      return Response.json({ error: 'driverId is required' }, { status: 400 });
    }

    const newTemp = Number(temperatureCelsius);

    let resolvedDate: string;
    if (timestamp) {
      resolvedDate = localDateFromTimestamp(timestamp);
    } else if (deliveryDate && /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
      resolvedDate = deliveryDate;
    } else {
      resolvedDate = localDateFromTimestamp('');
    }

    const readingTimestamp = timestamp || (() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    })();

    // One RxTempLogs record per driver per date — find-or-create
    const existing = await base44.asServiceRole.entities.RxTempLogs.filter({
      delivery_date: resolvedDate,
      driver_id: driverId
    });

    const existingLog      = existing?.[0];
    const existingReadings = Array.isArray(existingLog?.temperature_readings)
      ? existingLog.temperature_readings
      : [];

    // ── Only record if temperature has changed since the last reading ───────
    const lastRecordedTemp = existingLog?.latest_reading?.temperature_celsius ?? null;
    if (lastRecordedTemp !== null && lastRecordedTemp === newTemp) {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'Temperature unchanged',
        resolvedDate,
        totalReadings: existingReadings.length,
        isOutOfRange: isOutOfRange(newTemp),
      });
    }

    const reading = {
      timestamp: readingTimestamp,
      temperature_celsius: newTemp,
      recorded_by_driver_id: driverId,
      ...(trigger      ? { trigger }      : {}),
      ...(input_method ? { input_method } : {}),
      ...(sensor_mac   ? { sensor_mac }   : {}),
    };

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

    // ── Range-transition push notification ──────────────────────────────────
    // Only notify when the reading crosses the in/out boundary.
    // prev=in, new=out → "Temperature out of range" alert
    // prev=out, new=in → "Temperature back in range" confirmation
    const prevOutOfRange = lastRecordedTemp !== null ? isOutOfRange(lastRecordedTemp) : null;
    const nowOutOfRange  = isOutOfRange(newTemp);
    const rangeTransition = prevOutOfRange !== null && prevOutOfRange !== nowOutOfRange;

    if (rangeTransition) {
      try {
        // Get driver's push subscriptions
        const subs = await base44.asServiceRole.entities.PushSubscription.filter({ user_id: driverId });
        if (subs?.length) {
          const title = nowOutOfRange
            ? '⚠️ Cooler Temperature Alert'
            : '✅ Cooler Temperature Restored';
          const bodyMsg = nowOutOfRange
            ? `Temperature is now ${newTemp}°C — outside the safe range (${TEMP_MIN}–${TEMP_MAX}°C). Check cooler immediately.`
            : `Temperature is now ${newTemp}°C — back within safe range (${TEMP_MIN}–${TEMP_MAX}°C).`;

          await base44.asServiceRole.functions.invoke('sendPushNotification', {
            userId: driverId,
            title,
            body: bodyMsg,
            data: { type: 'temp_alert', temperature: newTemp, resolvedDate },
          });
        }
      } catch (_) {
        // Non-fatal — don't fail the temperature save if push fails
      }
    }

    return Response.json({
      success: true,
      reading,
      resolvedDate,
      totalReadings: updatedReadings.length,
      isOutOfRange: nowOutOfRange,
      rangeTransition,
      thresholds: { min: TEMP_MIN, max: TEMP_MAX, preferred: TEMP_PREFERRED }
    });

  } catch (error) {
    return Response.json({ error: error?.message || 'Server error' }, { status: 500 });
  }
});