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
    const completedStops = (routeDeliveries || [])
      .filter((d) => finishedStatuses.has(d?.status))
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));
    const activeStops = (routeDeliveries || [])
      .filter((d) => !finishedStatuses.has(d?.status) && d?.status !== 'pending')
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));
    const pendingStops = (routeDeliveries || [])
      .filter((d) => d?.status === 'pending')
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));

    const normalizedTime = normalizeLocalTimeString(currentLocalTime) || getCurrentLocalTimeString();
    const previousNextDelivery = (routeDeliveries || []).find((d) => d?.id !== deliveryId && d?.isNextDelivery === true) || null;

    const reorderedActiveStops = activeStops
      .filter((d) => d?.id !== deliveryId)
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));
    const selectedDelivery = (routeDeliveries || []).find((d) => d?.id === deliveryId) || null;
    if (!selectedDelivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }
    reorderedActiveStops.unshift(selectedDelivery);

    const reorderedRoute = [...completedStops, ...reorderedActiveStops, ...pendingStops].filter(Boolean);
    const updatesToPersist = reorderedRoute
      .map((delivery, index) => {
        const nextOrder = index + 1;
        const isTargetDelivery = delivery.id === deliveryId;
        const payload = {
          stop_order: nextOrder,
          display_stop_order: nextOrder,
          isNextDelivery: isTargetDelivery
        };
        return { delivery, payload };
      })
      .filter(({ delivery, payload }) => {
        return Number(delivery?.stop_order || 0) !== Number(payload.stop_order)
          || Number(delivery?.display_stop_order || 0) !== Number(payload.display_stop_order)
          || Boolean(delivery?.isNextDelivery) !== Boolean(payload.isNextDelivery);
      });

    await Promise.all(
      updatesToPersist.map(({ delivery, payload }) =>
        base44.asServiceRole.entities.Delivery.update(delivery.id, payload).catch((error) => {
          if (!isNotFoundError(error) && !isRateLimitError(error)) {
            console.warn(`⚠️ [handleStartDelivery] Failed updating stop ${delivery.id}:`, error?.message || error);
          }
          if (isRateLimitError(error)) throw error;
          return null;
        })
      )
    );

    console.log(`🔄 [handleStartDelivery] Route serialized for stop ${deliveryId}`);

    // Don't call optimizeRemainingStops here — it causes cascading 400 errors
    // The start action is just for marking the delivery as next and toggling driver to on_duty
    // Optimization will happen naturally via automations or other triggers

    return Response.json({
      success: true,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId: previousNextDelivery?.id || null,
      selectedStopOrder: reorderedRoute.findIndex((d) => d?.id === deliveryId) + 1,
      routeChanged: Boolean(updatesToPersist.length > 0)
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});