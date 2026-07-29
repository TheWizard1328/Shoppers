/**
 * Checks if a driver has zero active/pending stops remaining for a given date
 * after deletions, and if so:
 *   1. Toggles the driver's driver_status to 'off_duty' via the setDriverStatus backend
 *      function (which handles DriverDailyActivity segment recording with 5-min rounding,
 *      location sharing, isNextDelivery clearing, and WebSocket broadcast)
 *   2. Uses the actual_delivery_time of the last completed stop as the anchor time
 *      so the segment end_time reflects when the driver actually finished, not "now".
 *
 * SINGLE SOURCE OF TRUTH: All DriverDailyActivity segment recording goes through
 * the setDriverStatus backend function. This module does NOT directly manipulate
 * DriverDailyActivity entities.
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

  const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

  // Active/pending = anything NOT in a finished state
  const activePending = (remainingDeliveries || []).filter(
    (d) => d && !FINISHED_STATUSES.includes(d.status)
  );

  if (activePending.length > 0) {
    return { toggledOffDuty: false, lastStopTime: null };
  }

  console.log('🔓 [PostDelete] Zero active/pending stops remaining — toggling driver off duty:', driverId);

  // Find the last completed stop's actual_delivery_time (for logging only)
  const completedStops = (remainingDeliveries || [])
    .filter((d) => d && d.status === 'completed' && d.actual_delivery_time)
    .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));

  const lastStopTime = completedStops.length > 0
    ? completedStops[0].actual_delivery_time
    : null;

  if (lastStopTime) {
    console.log('⏱️ [PostDelete] Last completed stop time:', lastStopTime);
  }

  // Check if the driver is currently on_duty before calling setDriverStatus
  const driverAppUser = appUsers.find((au) => au?.user_id === driverId);
  const currentStatus = driverAppUser?.driver_status;

  if (currentStatus !== 'on_duty') {
    console.log(`ℹ️ [PostDelete] Driver already ${currentStatus || 'off_duty'} — skipping setDriverStatus`);
    return { toggledOffDuty: false, lastStopTime };
  }

  // Route through setDriverStatus backend — it handles:
  //   - DriverDailyActivity segment recording with 5-min rounding (off_duty → ceil)
  //   - Using last delivery time as anchor (so segment end_time = last stop, not now)
  //   - AppUser update + WebSocket broadcast
  //   - isNextDelivery flag clearing
  try {
    await base44.functions.invoke('setDriverStatus', {
      newStatus: 'off_duty',
      targetUserId: driverId,
      selectedDate: deliveryDate,
    });
    console.log('✅ [PostDelete] setDriverStatus off_duty succeeded for driver:', driverId);

    // Optimistic local UI update
    if (driverAppUser?.id) {
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: {
          appUsers: [{ ...driverAppUser, driver_status: 'off_duty', location_tracking_enabled: false }],
          singleUpdate: true,
        },
      }));
    }
  } catch (err) {
    console.warn('⚠️ [PostDelete] setDriverStatus failed:', err?.message || err);
    // Fallback: direct AppUser update (no segment recording, but at least update status)
    if (driverAppUser?.id) {
      try {
        await base44.entities.AppUser.update(driverAppUser.id, {
          driver_status: 'off_duty',
          location_tracking_enabled: false,
        });
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: {
            appUsers: [{ ...driverAppUser, driver_status: 'off_duty', location_tracking_enabled: false }],
            singleUpdate: true,
          },
        }));
      } catch (fallbackErr) {
        console.warn('⚠️ [PostDelete] Fallback AppUser update also failed:', fallbackErr?.message);
      }
    }
  }

  return { toggledOffDuty: true, lastStopTime };
}
