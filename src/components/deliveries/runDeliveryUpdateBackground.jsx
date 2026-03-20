import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { calculateRealTimeETA } from "@/functions/calculateRealTimeETA";
import { optimizeRemainingStops } from "@/functions/optimizeRemainingStops";
import { sendDeliveryMessage } from "../utils/deliveryMessaging";
import { getDriverDisplayName } from "../utils/driverUtils";
import { updateDelivery as updateDeliveryLocal } from "../utils/entityMutations";
import { reorderStops } from "../utils/stopReorderer";

const COMPLETION_STATUSES = ["completed", "failed", "cancelled", "returned"];

const isDriverUser = (user) => Array.isArray(user?.app_roles) && user.app_roles.includes("driver");

export function runDeliveryUpdateBackground({
  delivery,
  formData,
  completionTime,
  timeWindowChanged,
  currentUser,
  oldDriver,
  newDriver,
  selectedPatient,
  allDeliveries,
  isPickupMode,
}) {
  Promise.resolve().then(async () => {
    const statusChangedToCompletion = Boolean(delivery && COMPLETION_STATUSES.includes(formData.status) && delivery.status !== formData.status);
    const actualDeliveryTime = COMPLETION_STATUSES.includes(formData.status) && completionTime
      ? `${formData.delivery_date}T${completionTime}:00`
      : delivery?.actual_delivery_time;
    const actualDeliveryTimeChanged = Boolean(
      delivery &&
      COMPLETION_STATUSES.includes(formData.status) &&
      actualDeliveryTime &&
      actualDeliveryTime !== (delivery.actual_delivery_time || "")
    );

    if (delivery?.driver_id !== formData.driver_id && oldDriver && newDriver && currentUser && isDriverUser(currentUser)) {
      const patientName = delivery.patient_name || selectedPatient?.full_name || "Unknown";
      await sendDeliveryMessage({
        senderId: currentUser.id,
        senderName: getDriverDisplayName(currentUser),
        receiverId: newDriver.id,
        receiverName: getDriverDisplayName(newDriver),
        content: `🚚 ${getDriverDisplayName(oldDriver)} reassigned a Delivery to you:\n• ${patientName}\n• ${format(new Date(formData.delivery_date), "MMM d, yyyy")}`
      });
    }

    if (statusChangedToCompletion && delivery?.isNextDelivery) {
      const appUsers = await base44.entities.AppUser.filter({ user_id: formData.driver_id });
      const driverAppUser = appUsers?.[0];
      if (driverAppUser?.driver_status === "on_break") {
        await base44.entities.AppUser.update(driverAppUser.id, { driver_status: "on_duty" });
      }
    }

    if (isPickupMode && delivery && formData.status === "completed" && formData.store_id && formData.ampm_deliveries) {
      const relatedDeliveries = (allDeliveries || []).filter((d) =>
        d &&
        d.id !== delivery.id &&
        d.delivery_date === formData.delivery_date &&
        d.store_id === formData.store_id &&
        d.ampm_deliveries === formData.ampm_deliveries &&
        d.status === "pending" &&
        d.patient_id
      );
      await Promise.allSettled(relatedDeliveries.map((relatedDelivery) => updateDeliveryLocal(relatedDelivery.id, { status: "in_transit" })));
    }

    if (statusChangedToCompletion && formData.status === "completed") {
      base44.functions.invoke("updatePatientsAfterRouteCompletion", {
        deliveryDate: formData.delivery_date,
        driverId: formData.driver_id
      }).catch((error) => {
        console.error("❌ [DeliveryForm] Patient update failed:", error);
      });
    }

    if (delivery && formData.driver_id && formData.delivery_date && statusChangedToCompletion) {
      const driverDeliveries = (allDeliveries || []).filter((d) => d && d.driver_id === formData.driver_id && d.delivery_date === formData.delivery_date);
      const completedDeliveries = driverDeliveries.filter((d) => COMPLETION_STATUSES.includes(d.id === delivery.id ? formData.status : d.status));
      completedDeliveries.sort((a, b) => {
        const timeA = a.id === delivery.id && actualDeliveryTime ? new Date(actualDeliveryTime).getTime() : a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : 0;
        const timeB = b.id === delivery.id && actualDeliveryTime ? new Date(actualDeliveryTime).getTime() : b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : 0;
        return timeA - timeB;
      });
      let stopOrder = 1;
      await Promise.all(completedDeliveries.map((d) => {
        const newStopOrder = stopOrder++;
        return d.stop_order !== newStopOrder ? base44.entities.Delivery.update(d.id, { stop_order: newStopOrder }) : Promise.resolve();
      }));
      const incompleteDeliveries = driverDeliveries
        .filter((d) => d.id !== delivery.id && !COMPLETION_STATUSES.includes(d.status) && d.status !== "pending")
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      if (incompleteDeliveries.length > 0) {
        await base44.functions.invoke("setNextDeliveryFlag", {
          driverId: formData.driver_id,
          deliveryDate: formData.delivery_date,
          targetDeliveryId: incompleteDeliveries[0].id
        });
      }
    }

    if (delivery && formData.driver_id && formData.delivery_date) {
      const currentLocalTime = format(new Date(), "HH:mm");
      if (timeWindowChanged) {
        await optimizeRemainingStops({
          driverId: formData.driver_id,
          deliveryDate: formData.delivery_date,
          currentLocalTime,
          deviceTime: currentLocalTime
        });
      } else {
        await calculateRealTimeETA({
          driverId: formData.driver_id,
          deliveryDate: formData.delivery_date,
          currentLocalTime,
          deviceTime: currentLocalTime
        });
      }

      window.dispatchEvent(new CustomEvent("deliveriesUpdated", {
        detail: {
          triggeredBy: timeWindowChanged ? "routeOptimizationAfterUpdate" : "etaUpdateAfterDeliveryUpdate",
          driverId: formData.driver_id,
          deliveryDate: formData.delivery_date
        }
      }));
    }

    if (delivery && formData.driver_id && formData.delivery_date) {
      reorderStops(formData.driver_id, formData.delivery_date, allDeliveries)
        .then(() => console.log("✅ [DeliveryForm] Stop reordering complete (bg)"))
        .catch((error) => console.error("❌ [DeliveryForm] Stop reordering failed (bg):", error));
    }

    window.dispatchEvent(new CustomEvent("refreshDeliveryStats"));
  }).catch((error) => {
    console.error("❌ [DeliveryForm] Background post-update work failed:", error);
  });
}