// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const EDMONTON_TIMEZONE = 'America/Edmonton';

function isPlainLocalDateTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value);
}

function parsePlainLocalDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '00'] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatPlainLocalFromUtcMillis(value) {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function formatEdmontonLocalFromAbsoluteMillis(value) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDMONTON_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(new Date(value));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}T${lookup.hour}:${lookup.minute}:${lookup.second}`;
}

function getCompletionReference(delivery) {
  const actualValue = delivery?.actual_delivery_time;
  if (isPlainLocalDateTime(actualValue)) {
    const millis = parsePlainLocalDateTime(actualValue);
    if (millis) {
      return { millis, mode: 'plain_local' };
    }
  }

  const fallbackValue = actualValue || delivery?.updated_date || null;
  if (!fallbackValue) return null;

  const millis = new Date(fallbackValue).getTime();
  if (!Number.isFinite(millis)) return null;

  return { millis, mode: 'absolute' };
}

function subtractMinutes(reference, minutes) {
  const adjustedMillis = reference.millis - minutes * 60 * 1000;
  if (reference.mode === 'plain_local') {
    return formatPlainLocalFromUtcMillis(adjustedMillis);
  }
  return formatEdmontonLocalFromAbsoluteMillis(adjustedMillis);
}

function isPatientReturn(delivery) {
  const notes = `${delivery?.delivery_notes || ''} ${delivery?.tracking_number || ''}`;
  return /\(RTN\)|\breturn(?:ed)?\b/i.test(notes);
}

async function getHereTravelDurationMinutes(origin, destination) {
  const hereApiKey = Deno.env.get('HERE_API_KEY');
  if (!hereApiKey) {
    throw new Error('HERE_API_KEY secret is not set');
  }

  const params = new URLSearchParams({
    transportMode: 'car',
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    return: 'summary',
    apikey: hereApiKey
  });

  const response = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
    headers: { accept: 'application/json' }
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`HERE routing failed (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = await response.json();
  const sections = Array.isArray(payload?.routes?.[0]?.sections) ? payload.routes[0].sections : [];
  if (!sections.length) {
    throw new Error('HERE routing returned no route sections');
  }

  const totalSeconds = sections.reduce((sum, section) => sum + (section?.summary?.duration || 0), 0);
  return Math.round(totalSeconds / 60);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const delivery = payload?.data || null;
    const oldDelivery = payload?.old_data || null;
    const event = payload?.event || null;

    if (event?.entity_name !== 'Delivery' || event?.type !== 'update' || !delivery?.id) {
      return Response.json({ success: true, skipped: true, reason: 'not_relevant_event' });
    }

    if (!['completed', 'failed'].includes(delivery.status) || oldDelivery?.status === delivery.status) {
      return Response.json({ success: true, skipped: true, reason: 'delivery_status_not_targeted' });
    }

    if (!delivery.patient_id || !delivery.puid || isPatientReturn(delivery)) {
      return Response.json({ success: true, skipped: true, reason: 'excluded_delivery_type' });
    }

    const pickupMatches = await base44.asServiceRole.entities.Delivery.filter({
      stop_id: delivery.puid,
      delivery_date: delivery.delivery_date,
      driver_id: delivery.driver_id
    }, '-created_date', 10);

    const pickup = (pickupMatches || []).find((candidate) => !candidate?.patient_id);
    if (!pickup) {
      return Response.json({ success: true, skipped: true, reason: 'pickup_not_found' });
    }

    if (pickup.status !== 'en_route') {
      return Response.json({ success: true, skipped: true, reason: 'pickup_not_en_route', pickup_status: pickup.status || null });
    }

    const completionReference = getCompletionReference(delivery);
    if (!completionReference) {
      return Response.json({ success: true, skipped: true, reason: 'missing_delivery_completion_time' });
    }

    const storeMatches = await base44.asServiceRole.entities.Store.filter({ id: pickup.store_id }, '-created_date', 1);
    const patientMatches = await base44.asServiceRole.entities.Patient.filter({ id: delivery.patient_id }, '-created_date', 1);
    const store = storeMatches?.[0] || null;
    const patient = patientMatches?.[0] || null;

    const origin = {
      lat: Number(store?.latitude),
      lng: Number(store?.longitude)
    };
    const destination = {
      lat: Number(patient?.latitude),
      lng: Number(patient?.longitude)
    };

    if (![origin.lat, origin.lng, destination.lat, destination.lng].every(Number.isFinite)) {
      return Response.json({ success: true, skipped: true, reason: 'missing_route_coordinates' });
    }

    const estimatedDurationMinutes = await getHereTravelDurationMinutes(origin, destination);
    if (!Number.isFinite(estimatedDurationMinutes) || estimatedDurationMinutes < 0) {
      return Response.json({ success: true, skipped: true, reason: 'invalid_estimated_duration' });
    }

    const pickupCompletionTime = subtractMinutes(completionReference, estimatedDurationMinutes);

    const updatedPickup = await base44.asServiceRole.entities.Delivery.update(pickup.id, {
      status: 'completed',
      actual_delivery_time: pickupCompletionTime
    }).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });

    if (!updatedPickup) {
      return Response.json({ success: true, skipped: true, reason: 'pickup_not_found_during_update' });
    }

    return Response.json({
      success: true,
      pickup_id: pickup.id,
      estimated_duration_minutes: estimatedDurationMinutes,
      actual_delivery_time: pickupCompletionTime,
      updated_pickup: updatedPickup
    });
  } catch (error) {
    console.error('[ensurePickupCompletion] error', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
});