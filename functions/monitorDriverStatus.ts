import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const appUsers = await base44.asServiceRole.entities.AppUser.list();
    const today = getEdmDate();
    const cutoff = Date.now() - (30 * 60 * 1000);

    let checked = 0;
    let updated = 0;
    const updates = [];

    for (const appUser of appUsers) {
      const roles = Array.isArray(appUser?.app_roles) ? appUser.app_roles : [];
      if (!roles.includes('driver')) continue;

      if (appUser?.driver_status === 'off_duty') {
        const hasResidualLocation = appUser?.current_latitude !== null || appUser?.current_longitude !== null || appUser?.location_updated_at !== null;
        if (hasResidualLocation) {
          await base44.asServiceRole.entities.AppUser.update(appUser.id, {
            location_tracking_enabled: false,
            current_latitude: null,
            current_longitude: null,
            location_updated_at: null
          });
          updates.push({
            user_id: appUser.user_id,
            user_name: appUser.user_name,
            reason: 'Normalized existing off duty driver location fields',
            last_location_update_at: appUser.location_updated_at,
            cleared_next_flags: 0
          });
          updated += 1;
        }
        continue;
      }

      if (!appUser?.location_updated_at) continue;

      checked += 1;
      const lastUpdateTime = new Date(appUser.location_updated_at).getTime();
      if (!Number.isFinite(lastUpdateTime) || lastUpdateTime > cutoff) continue;

      const todayDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id: appUser.user_id,
        delivery_date: today
      });

      const activeStops = todayDeliveries.filter((delivery) =>
        delivery && !FINISHED.includes(delivery.status)
      );

      if (activeStops.length > 0) continue;

      const nextFlaggedStops = todayDeliveries.filter((delivery) => delivery?.isNextDelivery === true);
      for (const delivery of nextFlaggedStops) {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, { isNextDelivery: false });
      }

      await base44.asServiceRole.entities.AppUser.update(appUser.id, {
        driver_status: 'off_duty',
        location_tracking_enabled: false,
        current_latitude: null,
        current_longitude: null,
        location_updated_at: null
      });

      updated += 1;
      updates.push({
        user_id: appUser.user_id,
        user_name: appUser.user_name,
        reason: 'No movement for 30+ minutes and all stops finished',
        last_location_update_at: appUser.location_updated_at,
        cleared_next_flags: nextFlaggedStops.length
      });
    }

    return Response.json({ success: true, checked, updated, updates });
  } catch (error) {
    console.error('monitorDriverStatus error:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});