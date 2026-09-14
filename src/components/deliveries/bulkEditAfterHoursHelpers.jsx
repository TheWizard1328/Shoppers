// Resolve the After Hours checkbox state for a bulk-edit selection.
//
// after_hours_pickup is a real field on BOTH pickups and deliveries — for a patient
// delivery it doubles the base pay (see payCalculator), so it is meaningful to
// bulk-edit it on deliveries, not just pickups.
//
// A pickup stop (no patient_id) is its own "linked pickup".
// A delivery stop links to its originating pickup via puid -> pickup.stop_id (or puid).

export const findLinkedPickup = (delivery, allDeliveries = []) => {
  if (!delivery) return null;
  if (!delivery.patient_id) return delivery; // pickup links to itself
  const puid = delivery.puid;
  if (!puid) return null;
  return (allDeliveries || []).find(
    (d) => d && !d.patient_id && (d.stop_id === puid || d.puid === puid)
  ) || null;
};

// A stop is "after-hours eligible" when it is itself flagged after hours, or when
// its linked pickup (if resolvable) is flagged after hours. This is the condition
// under which the After Hours checkbox is activated (enabled) for the selection.
const isStopAfterHoursEligible = (delivery, allDeliveries) => {
  if (!delivery) return false;
  if (delivery.after_hours_pickup === true) return true;
  const pickup = findLinkedPickup(delivery, allDeliveries);
  return !!pickup && pickup.after_hours_pickup === true;
};

// Returns { enabled, checked } where checked is true | false | "indeterminate".
//  - enabled: true when at least one selected stop is after-hours eligible
//    (honors "keep disabled when none of the selected stops have a pickup marked
//    after hours"). Self-flagged stops count as eligible even if the linked pickup
//    cannot be resolved, so previously-flagged deliveries don't get falsely locked.
//  - checked:
//      true          — every selected stop is itself after hours
//      "indeterminate" — some stops are after hours, others are not
//      false         — no selected stop is itself after hours
export const resolveAfterHoursCheckboxState = (selectedDeliveries = [], allDeliveries = []) => {
  if (!selectedDeliveries || selectedDeliveries.length === 0) {
    return { enabled: false, checked: false };
  }
  // Enable only when EVERY selected stop has its pickup set as after hours.
  // A stop whose pickup is not after hours disables the checkbox for the whole
  // selection (per the requirement).
  const allEligible = selectedDeliveries.every((d) => isStopAfterHoursEligible(d, allDeliveries));
  if (!allEligible) return { enabled: false, checked: false };

  const allTrue = selectedDeliveries.every((d) => d && d.after_hours_pickup === true);
  if (allTrue) return { enabled: true, checked: true };
  const allFalse = selectedDeliveries.every((d) => !d || d.after_hours_pickup !== true);
  if (allFalse) return { enabled: true, checked: false };
  return { enabled: true, checked: "indeterminate" };
};