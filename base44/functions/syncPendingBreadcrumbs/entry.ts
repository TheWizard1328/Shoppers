import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

function parseBreadcrumbPayload(payload) {
  if (!payload) return [];
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((point) => Array.isArray(point) && point.length >= 2);
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, breadcrumbPayload, sourcePendingKey, stopOrder, breadcrumbDate, overwrite = false } = await req.json();

    if (!deliveryId) {
      return Response.json({ error: 'Missing deliveryId' }, { status: 400 });
    }

    const breadcrumbs = parseBreadcrumbPayload(breadcrumbPayload);
    if (!breadcrumbs.length) {
      return Response.json({ status: 'skipped', reason: 'empty_breadcrumbs', deliveryId, sourcePendingKey, stopOrder, breadcrumbDate });
    }

    const deliveries = await base44.asServiceRole.entities.Delivery.filter({ id: deliveryId });
    const delivery = deliveries?.[0];

    if (!delivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUsers?.[0] || null;
    const isAdmin = Array.isArray(appUser?.app_roles) && appUser.app_roles.includes('admin');

    if (delivery.driver_id !== user.id && !isAdmin) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (!overwrite && typeof delivery.delivery_route_breadcrumbs === 'string' && delivery.delivery_route_breadcrumbs.trim().length > 0) {
      return Response.json({
        status: 'skipped',
        reason: 'already_present',
        deliveryId,
        sourcePendingKey,
        stopOrder,
        breadcrumbDate,
        breadcrumbCount: breadcrumbs.length
      });
    }

    let updatedDelivery = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        updatedDelivery = await base44.asServiceRole.entities.Delivery.update(deliveryId, {
          delivery_route_breadcrumbs: JSON.stringify(breadcrumbs)
        });
        break;
      } catch (error) {
        if (isNotFoundError(error)) {
          return Response.json({ status: 'skipped', reason: 'delivery_not_found', deliveryId, sourcePendingKey, stopOrder, breadcrumbDate, breadcrumbCount: breadcrumbs.length });
        }
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        }
      }
    }

    if (!updatedDelivery) {
      throw lastError || new Error('Failed to sync breadcrumbs');
    }

    return Response.json({
      status: 'synced',
      deliveryId,
      sourcePendingKey,
      stopOrder,
      breadcrumbDate,
      breadcrumbCount: breadcrumbs.length
    });
  } catch (error) {
    console.error('❌ [syncPendingBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
});