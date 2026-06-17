// Redeployed on 2026-04-03
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const FINISHED = ['completed', 'failed', 'cancelled', 'returned'];

const getEdmDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
};

const hasResidualLocation = (appUser) =>
  appUser?.current_latitude !== null ||
  appUser?.current_longitude !== null ||
  appUser?.location_updated_at !== null;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const today = getEdmDate();
    const cutoff = Date.now() - (30 * 60 * 1000);

    const [appUsers, todayDeliveries] = await Promise.all([
      base44.asServiceRole.entities.AppUser.list(),
      base44.asServiceRole.entities.Delivery.filter({ delivery_date: today })
    ]);

    const driverDeliveriesMap = new Map();
    for (const delivery of todayDeliveries) {
      if (!delivery?.driver_id) continue;
      if (!driverDeliveriesMap.has(delivery.driver_id)) {
        driverDeliveriesMap.set(delivery.driver_id, []);
      }
      driverDeliveriesMap.get(delivery.driver_id).push(delivery);
    }

    let checked = 0;
    let updated = 0;
    const updates = [];
    const deliveryUpdates = [];
    const appUserUpdates = [];

    for (const appUser of appUsers) {
      const roles = Array.isArray(appUser?.app_roles) ? appUser.app_roles : [];
      if (!roles.includes('driver')) continue;

      if (appUser?.driver_status === 'off_duty') {
        if (!hasResidualLocation(appUser)) continue;

        appUserUpdates.push(
          base44.asServiceRole.entities.AppUser.update(appUser.id, {
            location_tracking_enabled: false,
            current_latitude: null,
            current_longitude: null,
            location_updated_at: null
          }).catch((error) => {
            if (isNotFoundError(error)) return null;
            throw error;
          })
        );

        updates.push({
          user_id: appUser.user_id,
          user_name: appUser.user_name,
          reason: 'Normalized existing off duty driver location fields',
          last_location_update_at: appUser.location_updated_at,
          cleared_next_flags: 0
        });
        updated += 1;
        continue;
      }

      if (!appUser?.location_updated_at) continue;

      checked += 1;
      const lastUpdateTime = new Date(appUser.location_updated_at).getTime();
      if (!Number.isFinite(lastUpdateTime) || lastUpdateTime > cutoff) continue;

      const driverDeliveries = driverDeliveriesMap.get(appUser.user_id) || [];
      const activeStops = driverDeliveries.filter((delivery) => delivery && !FINISHED.includes(delivery.status));
      if (activeStops.length > 0) continue;

      const nextFlaggedStops = driverDeliveries.filter((delivery) => delivery?.isNextDelivery === true);
      for (const delivery of nextFlaggedStops) {
        deliveryUpdates.push(
          base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false }).catch((error) => {
            if (isNotFoundError(error)) return null;
            throw error;
          })
        );
      }

      appUserUpdates.push(
        base44.asServiceRole.entities.AppUser.update(appUser.id, {
          driver_status: 'off_duty',
          location_tracking_enabled: false,
          current_latitude: null,
          current_longitude: null,
          location_updated_at: null
        }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        })
      );

      updated += 1;
      updates.push({
        user_id: appUser.user_id,
        user_name: appUser.user_name,
        reason: 'No movement for 30+ minutes and all stops finished',
        last_location_update_at: appUser.location_updated_at,
        cleared_next_flags: nextFlaggedStops.length
      });
    }

    await Promise.all([...deliveryUpdates, ...appUserUpdates]);

    return Response.json({ success: true, checked, updated, updates });
  } catch (error) {
    console.error('monitorDriverStatus error:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});