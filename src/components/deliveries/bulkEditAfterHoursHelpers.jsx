// Resolve the After Hours checkbox state for a bulk-edit selection.
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

// Returns { enabled, checked } where checked is true | false | "indeterminate".
//  - enabled: true only when EVERY selected stop is linked to a pickup marked after hours
//    (this is the "activate the checkbox" condition).
//  - checked:
//      true          — all selected stops are themselves after hours
//      "indeterminate" — linked pickup(s) are after hours but not all stops are
//                        (e.g. an after-hours pickup selected alongside its non-after-hours
//                        deliveries) → shown as a gray dash (3-stage check)
//      false         — otherwise (also when disabled)
export const resolveAfterHoursCheckboxState = (selectedDeliveries = [], allDeliveries = []) => {
  if (!selectedDeliveries || selectedDeliveries.length === 0) {
    return { enabled: false, checked: false };
  }
  const linkedPickups = selectedDeliveries.map((d) => findLinkedPickup(d, allDeliveries));
  const allLinkedToAfterHours = linkedPickups.every((p) => p && p.after_hours_pickup === true);
  if (!allLinkedToAfterHours) return { enabled: false, checked: false };

  const allStopsAfterHours = selectedDeliveries.every((d) => d && d.after_hours_pickup === true);
  return { enabled: true, checked: allStopsAfterHours ? true : "indeterminate" };
};