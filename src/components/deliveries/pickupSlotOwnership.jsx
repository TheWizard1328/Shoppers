// WHO OWNS THE AM/PM SLOT ON SAVE (owner report Nov 14 2026)
//
// A patient stop follows the pickup it hangs off — that rule is correct and is
// enforced at write time (DeliveryForm submit + updateDeliveryLocal reconcile).
//
// But when the record being saved IS that pickup, its own AM/PM edit is
// authoritative. The old lookup matched the pickup against ITSELF
// (stop_id === puid), rewrote the new slot back to the old one, and the pickup
// snapshot compare then saw "no change" — so "Update Pickup" closed the form and
// saved nothing at all.
//
// Kept in its own tiny module so the rule is unit-testable without dragging the
// whole delivery form (and the Base44 SDK) into a node test.
export const shouldInheritSlotFromPickup = ({ delivery = null, formData = {}, dataToSave = {} } = {}) => {
  const savingPickupRecord = !formData?.patient_id && !dataToSave?.patient_id && !delivery?.patient_id;
  return !savingPickupRecord;
};

export default shouldInheritSlotFromPickup;
