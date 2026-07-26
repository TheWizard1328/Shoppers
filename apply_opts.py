import re

def apply_optimizations():
    with open('src/pages/DriverScheduleCalendar.jsx', 'r') as f:
        content = f.read()

    # 1. Add _driverColorCache and getCachedDriverColor helper
    # Place it right after 'function slotLockKey(dateStr, storeId, slotKey) { ... }'
    color_cache_helper = """
const _driverColorCache = new Map();
function getCachedDriverColor(nameOrId) {
  if (!nameOrId) return generateDriverColor(nameOrId);
  if (!_driverColorCache.has(nameOrId)) {
    _driverColorCache.set(nameOrId, generateDriverColor(nameOrId));
  }
  return _driverColorCache.get(nameOrId);
}
"""
    # Insert getCachedDriverColor after slotLockKey
    slot_lock_key_end = "return `${dateStr}|${storeId}|${slotKey}`;\n}"
    content = content.replace(slot_lock_key_end, slot_lock_key_end + "\n" + color_cache_helper)

    # 2. Update DriverSlotCell props & wrap in React.memo
    # Replace the start of DriverSlotCell function
    old_driver_slot_cell_start = """function DriverSlotCell({
  date, slotKey, store, overrides, drivers, appUsers, currentUser,
  onDriverChange, deliveriesByDay, isAdmin, unlockedSlots, onToggleSlotLock, isMobile,
  isDeliveryDriven = false, deliveryDrivenDriverId = null
}) {"""
    
    new_driver_slot_cell_start = """const DriverSlotCell = React.memo(function DriverSlotCell({
  date, slotKey, store, overrides, overrideMap, drivers, appUsers, appUserMap, currentUser,
  onDriverChange, deliveriesByDay, isAdmin, unlockedSlots, onToggleSlotLock, isMobile,
  isDeliveryDriven = false, deliveryDrivenDriverId = null
}) {"""
    content = content.replace(old_driver_slot_cell_start, new_driver_slot_cell_start)

    # Replace override finding with map lookup inside DriverSlotCell
    old_override_find = "const override = overrides.find((o) => o.date === dateStr && o.slot_key === slotKey && o.store_id === store.id);"
    new_override_find = "const override = overrideMap?.get(`${dateStr}|${store.id}|${slotKey}`) || null;"
    content = content.replace(old_override_find, new_override_find)

    # Replace default driver name resolution inside DriverSlotCell
    old_default_driver_find = "appUsers.find((u) => u.user_id === defaultDriverId || u.id === defaultDriverId)"
    new_default_driver_find = "appUserMap?.get(defaultDriverId)"
    content = content.replace(old_default_driver_find, new_default_driver_find)

    # Replace consolidated useMemo block in DriverSlotCell
    # We find the three old useMemos:
    # Use re to locate and replace them
    old_usememos_pattern = r"  const slotDeliveries = useMemo\(\(\) => \{.*?\}\[deliveriesByDay, dateStr, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven, isBookedOff, store\.id, isAM\]\);"
    # Wait, let's write a precise multi-line search and replace for the three useMemos
    # Let's inspect the original lines in the file for slotDeliveries, assignedDeliveryCount, allSlotDeliveries:
    # slotDeliveries is from line 169 to 184
    # assignedDeliveryCount is from line 187 to 204
    # allSlotDeliveries is from line 207 to 223
    
    old_slot_deliveries_block = """  const slotDeliveries = useMemo(() => {
    if (!deliveriesByDay || !isMySlot) return [];
    const ampm = isAM ? 'AM' : 'PM';
    const filterDriverId = isDeliveryDriven ? deliveryDrivenDriverId : effectiveDriverId;
    return (deliveriesByDay[dateStr] || []).filter((d) => {
      const isPatientOrAHPickup = (d.patient_id && d.patient_id !== '') || d.after_hours_pickup;
      if (isBookedOff && !filterDriverId) {
        return !d.driver_id && d.store_id === store.id &&
          isPatientOrAHPickup && d.status === 'pending' &&
          (!d.ampm_deliveries || d.ampm_deliveries === ampm);
      }
      return d.driver_id === filterDriverId && d.store_id === store.id &&
        isPatientOrAHPickup &&
        (!d.ampm_deliveries || d.ampm_deliveries === ampm);
    });
  }, [deliveriesByDay, dateStr, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven, isBookedOff, store.id, isAM, isMySlot]);

  // Raw count for visibility check — always computed regardless of isMySlot
  const assignedDeliveryCount = useMemo(() => {
    if (!deliveriesByDay) return 0;
    const ampm = isAM ? 'AM' : 'PM';
    const filterDriverId = isDeliveryDriven ? deliveryDrivenDriverId : effectiveDriverId;
    if (isBookedOff && !filterDriverId) {
      return (deliveriesByDay[dateStr] || []).filter((d) =>
        !d.driver_id && d.store_id === store.id &&
        ((d.patient_id && d.patient_id !== '') || d.after_hours_pickup) && d.status === 'pending' &&
        (!d.ampm_deliveries || d.ampm_deliveries === ampm)
      ).length;
    }
    if (!filterDriverId) return 0;
    return (deliveriesByDay[dateStr] || []).filter((d) =>
      d.driver_id === filterDriverId && d.store_id === store.id &&
      ((d.patient_id && d.patient_id !== '') || d.after_hours_pickup) &&
      (!d.ampm_deliveries || d.ampm_deliveries === ampm)
    ).length;
  }, [deliveriesByDay, dateStr, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven, isBookedOff, store.id, isAM]);

  // Always compute timing from the assigned driver's deliveries (not gated by isMySlot)
  const allSlotDeliveries = useMemo(() => {
    if (!deliveriesByDay) return [];
    const ampm = isAM ? 'AM' : 'PM';
    const filterDriverId = isDeliveryDriven ? deliveryDrivenDriverId : effectiveDriverId;
    if (!filterDriverId && !isBookedOff) return [];
    return (deliveriesByDay[dateStr] || []).filter((d) => {
      const isPatientOrAHPickup = (d.patient_id && d.patient_id !== '') || d.after_hours_pickup;
      if (isBookedOff && !filterDriverId) {
        return !d.driver_id && d.store_id === store.id &&
          isPatientOrAHPickup && d.status === 'pending' &&
          (!d.ampm_deliveries || d.ampm_deliveries === ampm);
      }
      return d.driver_id === filterDriverId && d.store_id === store.id &&
        isPatientOrAHPickup &&
        (!d.ampm_deliveries || d.ampm_deliveries === ampm);
    });
  }, [deliveriesByDay, dateStr, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven, isBookedOff, store.id, isAM]);"""

    new_consolidated_usememo = """  const { slotDeliveries, assignedCount, allSlotDeliveries } = useMemo(() => {
    if (!deliveriesByDay) return { slotDeliveries: [], assignedCount: 0, allSlotDeliveries: [] };
    const ampm = isAM ? 'AM' : 'PM';
    const filterDriverId = isDeliveryDriven ? deliveryDrivenDriverId : effectiveDriverId;
    const dayDelivs = deliveriesByDay[dateStr] || [];
    const matched = dayDelivs.filter((d) => {
      const isPatientOrAHPickup = (d.patient_id && d.patient_id !== '') || d.after_hours_pickup;
      if (!isPatientOrAHPickup) return false;
      if (isBookedOff && !filterDriverId) {
        return !d.driver_id && d.store_id === store.id && d.status === 'pending' &&
          (!d.ampm_deliveries || d.ampm_deliveries === ampm);
      }
      return d.driver_id === filterDriverId && d.store_id === store.id &&
        (!d.ampm_deliveries || d.ampm_deliveries === ampm);
    });
    return {
      slotDeliveries: isMySlot ? matched : [],
      assignedCount: matched.length,
      allSlotDeliveries: matched,
    };
  }, [deliveriesByDay, dateStr, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven, isBookedOff, store.id, isAM, isMySlot]);"""

    content = content.replace(old_slot_deliveries_block, new_consolidated_usememo)

    # Replace references inside DriverSlotCell:
    content = content.replace("assignedDeliveryCount", "assignedCount")

    # Wrap the end of DriverSlotCell with React.memo
    # DriverSlotCell ends right before "// ── StatHolidayBanner ─────────────────────────────────────────────────────────" or something.
    # In our case, the end of the file/component is:
    # "    </Popover>);\n}"
    # Wait, let's find the exact end of DriverSlotCell. Let's do a search or check.
    # Let's inspect around lines 390-410 of DriverSlotCell.
    # DriverSlotCell ends with "    </Popover>);\n}"
    # Let's verify by checking the line:
    # "// ── DriverScheduleCalendar ──────────────────────────────────────────────────"
    # Wait! DriverSlotCell is followed by "// ── DriverScheduleCalendar ──────────────────────────────────────────────────"
    # Let's print that boundary in python to verify.

apply_optimizations()