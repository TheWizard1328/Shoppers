import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');

const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);

const getCurrentLocalTimeString = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

const normalizeLocalTimeString = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const getTimeStringFromTimestamp = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : null;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, driverId, deliveryDate, currentLocalTime } = await req.json();

    if (!deliveryId || !driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields: deliveryId, driverId, deliveryDate' }, { status: 400 });
    }

    if (!isValidObjectId(deliveryId) || !isValidObjectId(driverId)) {
      return Response.json({ error: 'Start was blocked because this stop is still syncing.' }, { status: 400 });
    }

    const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 5000);

    const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const selectedStopOrder = numCompleted + 1;
    const normalizedTime = normalizeLocalTimeString(currentLocalTime) || getCurrentLocalTimeString();

    const startPayload = {
      isNextDelivery: true,
      stop_order: selectedStopOrder,
      display_stop_order: selectedStopOrder,
    };

    // Clear isNextDelivery on any other stop that had it
    const nextFlagResetUpdates = (routeDeliveries || [])
      .filter((d) => d?.id !== deliveryId && d?.isNextDelivery === true)
      .map((d) =>
        base44.asServiceRole.entities.Delivery.update(d.id, { isNextDelivery: false }).catch((error) => {
          if (!isNotFoundError(error) && !isRateLimitError(error)) {
            console.warn(`⚠️ [handleStartDelivery] Failed clearing next-stop flag ${d.id}:`, error?.message || error);
          }
          if (isRateLimitError(error)) throw error;
          return null;
        })
      );

    await Promise.all([
      ...nextFlagResetUpdates,
      base44.asServiceRole.entities.Delivery.update(deliveryId, startPayload)
    ]);

    console.log(`🔄 [handleStartDelivery] Stop ${deliveryId} set as next (stop_order=${selectedStopOrder}, numCompleted=${numCompleted})`);

    return Response.json({
      success: true,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId,
      selectedStopOrder,
      routeChanged: false,
      optimization: {
        skipped: true,
        reason: 'start_button_sets_next_delivery_only'
      }
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});