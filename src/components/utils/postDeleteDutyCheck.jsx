/**
 * Checks if a driver has zero active/pending stops remaining for a given date
 * after deletions, and if so:
 *   1. Toggles the driver's driver_status to 'off_duty'
 *   2. Closes the open DriverDailyActivity segment with end_time set to the
 *      actual_delivery_time of the last completed stop (not "now" — the driver
 *      effectively finished at the last stop, not when the admin deleted the
 *      remaining stops).
 *
 * @param {object} params
 * @param {string} params.driverId - The driver's user_id (Delivery.driver_id)
 * @param {string} params.deliveryDate - YYYY-MM-DD
 * @param {Array}  params.remainingDeliveries - Deliveries for this driver/date AFTER deletion
 * @param {Array}  [params.appUsers] - appUsers array (to find the AppUser record)
 * @param {object} params.base44 - Base44 SDK client
 * @returns {Promise<{ toggledOffDuty: boolean, lastStopTime: string|null }>}
 */
export async function checkAndToggleOffDutyAfterDelete({
  driverId,
  deliveryDate,
  remainingDeliveries,
  appUsers = [],
  base44,
}) {
  if (!driverId || !deliveryDate) return { toggledOffDuty: false, lastStopTime: null };

  const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

  // Active/pending = anything NOT in a finished state
  const activePending = (remainingDeliveries || []).filter(
    (d) => d && !FINISHED_STATUSES.includes(d.status)
  );

  if (activePending.length > 0) {
    return { toggledOffDuty: false, lastStopTime: null };
  }

  console.log('🔓 [PostDelete] Zero active/pending stops remaining — toggling driver off duty:', driverId);

  // Find the last completed stop's actual_delivery_time
  const completedStops = (remainingDeliveries || [])
    .filter((d) => d && d.status === 'completed' && d.actual_delivery_time)
    .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));

  const lastStopTime = completedStops.length > 0
    ? completedStops[0].actual_delivery_time
    : null;

  if (lastStopTime) {
    console.log('⏱️ [PostDelete] Last completed stop time:', lastStopTime);
  } else {
    console.log('⏱️ [PostDelete] No completed stops found — using null end_time');
  }

  // 1. Update AppUser driver_status to off_duty
  const driverAppUser = appUsers.find((au) => au?.user_id === driverId);
  if (driverAppUser?.id) {
    try {
      await base44.entities.AppUser.update(driverAppUser.id, {
        driver_status: 'off_duty',
        location_tracking_enabled: false,
      });
      console.log('✅ [PostDelete] AppUser set to off_duty:', driverAppUser.id);

      // Broadcast so other devices/views update immediately
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: {
          appUsers: [{ ...driverAppUser, driver_status: 'off_duty', location_tracking_enabled: false }],
          singleUpdate: true,
        },
      }));
    } catch (err) {
      console.warn('⚠️ [PostDelete] Failed to set AppUser off_duty:', err?.message || err);
    }
  }

  // 2. Close the open DriverDailyActivity segment with end_time = lastStopTime
  try {
    const dailyActivity = await base44.entities.DriverDailyActivity.filter({
      driver_id: driverId,
      activity_date: deliveryDate,
    });

    if (dailyActivity && dailyActivity.length > 0) {
      const activity = dailyActivity[0];
      const segments = Array.isArray(activity.activity_segments)
        ? [...activity.activity_segments]
        : [];

      const openIdx = segments.findIndex((s) => s.start_time && !s.end_time);
      if (openIdx !== -1) {
        const startTime = segments[openIdx].start_time;
        const endTime = lastStopTime || new Date().toISOString();
        const startMs = new Date(startTime).getTime();
        const endMs = new Date(endTime).getTime();
        const tot = Math.max(0, Math.round((endMs - startMs) / 60000));

        segments[openIdx] = { ...segments[openIdx], end_time: endTime, tot };

        await base44.entities.DriverDailyActivity.update(activity.id, {
          activity_segments: segments,
        });

        console.log(`✅ [PostDelete] DriverDailyActivity segment closed — ${tot} min on duty (end_time: ${endTime})`);
      } else {
        console.log('ℹ️ [PostDelete] No open segment found in DriverDailyActivity — nothing to close');
      }
    } else {
      console.log('ℹ️ [PostDelete] No DriverDailyActivity record found for driver/date');
    }
  } catch (err) {
    console.warn('⚠️ [PostDelete] Failed to close DriverDailyActivity segment:', err?.message || err);
  }

  return { toggledOffDuty: true, lastStopTime };
}
