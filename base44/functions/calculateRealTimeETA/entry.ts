import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const APP_TIMEZONE = 'America/Edmonton';

const formatLocalIsoWithoutOffset = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value || '0000';
  const month = parts.find((part) => part.type === 'month')?.value || '00';
  const day = parts.find((part) => part.type === 'day')?.value || '00';
  const hour = parts.find((part) => part.type === 'hour')?.value || '00';
  const minute = parts.find((part) => part.type === 'minute')?.value || '00';
  const second = parts.find((part) => part.type === 'second')?.value || '00';

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
};

const parseTimestamp = (value) => {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toPositiveMinutes = (value) => {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    const deliveries = Array.isArray(payload?.deliveries) ? payload.deliveries : [];
    const lastStopCompletionTime = payload?.lastStopCompletionTime || payload?.actualDeliveryTime || payload?.completionTime || null;
    const lastStopServiceTime = toPositiveMinutes(payload?.lastStopServiceTime ?? payload?.extra_time) ?? 0;

    const baseTime = parseTimestamp(lastStopCompletionTime);
    if (!baseTime || deliveries.length === 0) {
      return Response.json({ etaEstimates: [] });
    }

    const orderedDeliveries = [...deliveries]
      .filter((delivery) => delivery?.id || delivery?.delivery_id)
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));

    let rollingTime = new Date(baseTime.getTime() + lastStopServiceTime * 60000);

    const etaEstimates = orderedDeliveries
      .map((delivery) => {
        const estimatedDurationMinutes = toPositiveMinutes(delivery?.estimated_duration_minutes);
        if (estimatedDurationMinutes === null) return null;

        rollingTime = new Date(rollingTime.getTime() + estimatedDurationMinutes * 60000);

        return {
          delivery_id: delivery?.id || delivery?.delivery_id || null,
          estimated_duration_minutes: estimatedDurationMinutes,
          estimated_arrival_time: formatLocalIsoWithoutOffset(rollingTime),
        };
      })
      .filter(Boolean);

    return Response.json({ etaEstimates });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});