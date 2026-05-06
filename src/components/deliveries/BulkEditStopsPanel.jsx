import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerOverlay } from "@/components/ui/drawer";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetOverlay } from "@/components/ui/sheet";
import { getPickupStopIdForDelivery } from "@/components/utils/ampmUtils";
import { userHasRole } from "@/components/utils/userRoles";
import { X, Car, Bike } from "lucide-react";

const getStoreSlotOptions = (store, deliveryDate, driverId = null) => {
  if (!store || !deliveryDate) return [];

  const day = new Date(`${deliveryDate}T00:00:00`).getDay();
  const slotConfigs = day === 0 ? [
    { slot: "AM", enabled: !!store.sunday_am_enabled, slotDriverId: store.sunday_am_driver_id },
    { slot: "PM", enabled: !!store.sunday_pm_enabled, slotDriverId: store.sunday_pm_driver_id },
  ] : day === 6 ? [
    { slot: "AM", enabled: !!store.saturday_am_enabled, slotDriverId: store.saturday_am_driver_id },
    { slot: "PM", enabled: !!store.saturday_pm_enabled, slotDriverId: store.saturday_pm_driver_id },
  ] : [
    { slot: "AM", enabled: !!store.weekday_am_enabled, slotDriverId: store.weekday_am_driver_id },
    { slot: "PM", enabled: !!store.weekday_pm_enabled, slotDriverId: store.weekday_pm_driver_id },
  ];

  return slotConfigs
    .filter(({ enabled, slotDriverId }) => enabled && (!driverId || !slotDriverId || String(slotDriverId) === String(driverId)))
    .map(({ slot }) => ({
      value: `${store.id}::${slot}`,
      storeId: store.id,
      slot,
      label: `${store.name} [${slot}]`
    }));
};

function TimeField({ value, onChange, onClear, disabled, style }) {
  return (
    <div className="relative">
      <Input
        type="time"
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="pr-10"
        style={style}
      />
      {value && !disabled && (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-slate-500 hover:text-slate-900"
          aria-label="Clear time"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function TravelModeButtons({ value, onChange, disabled, isMixed = false }) {
  const options = [
    { value: 'driving', label: 'Driving', icon: Car },
    { value: 'cycling', label: 'Cycling', icon: Bike }
  ];

  return (
    <div className="flex flex-row gap-2 shrink-0">
      {options.map((option) => {
        const Icon = option.icon;
        const isActive = !isMixed && value === option.value;
        const isGrayMixed = isMixed;

        return (
          <button
            key={option.value}
            type="button"
            title={option.label}
            aria-label={option.label}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={`h-9 w-9 rounded-full border transition-all flex items-center justify-center ${isActive ? 'bg-emerald-600 border-emerald-600 text-white' : isGrayMixed ? 'bg-slate-200 border-slate-300 text-slate-500' : 'bg-white text-slate-700'}`}
          >
            <Icon className="w-4 h-4" />
          </button>
        );
      })}
    </div>
  );
}

function BulkEditStopsForm({ selectedCount, drivers, stores, allDeliveries, currentUser, values, setValues, onApply, onCancel, isSaving, initialValues }) {
  const isAdmin = userHasRole(currentUser, "admin");
  const isDriver = userHasRole(currentUser, "driver");
  const isMixedTravelMode = initialValues.travelModeChoice === "mixed" && values.travelModeChoice === "mixed";
  const effectiveDriverId = values.driverChoice !== "unchanged" && values.driverChoice !== "unassigned" ? values.driverChoice : null;
  const changedFieldStyle = { background: '#fef3c7', borderColor: '#f59e0b' };
  const getFieldStyle = (fieldName) => values[fieldName] !== initialValues[fieldName] ? changedFieldStyle : undefined;

  const allowedStores = useMemo(() => {
    if (isAdmin) return stores || [];
    const assignedStoreIds = new Set(currentUser?.store_ids || []);
    return (stores || []).filter((store) => assignedStoreIds.has(store.id));
  }, [currentUser, isAdmin, stores]);

  const pickupOptions = useMemo(() => {
    if (!values.delivery_date) return [];
    return allowedStores.flatMap((store) => getStoreSlotOptions(store, values.delivery_date, effectiveDriverId));
  }, [allowedStores, effectiveDriverId, values.delivery_date]);

  useEffect(() => {
    if (values.storeChoice === "unchanged") return;

    if (pickupOptions.length === 1 && values.storeChoice !== pickupOptions[0].value) {
      setValues((current) => ({ ...current, storeChoice: pickupOptions[0].value }));
      return;
    }

    if (pickupOptions.length > 0 && !pickupOptions.some((option) => option.value === values.storeChoice)) {
      setValues((current) => ({ ...current, storeChoice: "unchanged", puid: isAdmin ? "" : current.puid }));
    }
  }, [isAdmin, pickupOptions, setValues, values.storeChoice]);

  useEffect(() => {
    if (!values.delivery_date || values.storeChoice === "unchanged") return;
    const selectedPickupOption = pickupOptions.find((option) => option.value === values.storeChoice);
    if (!selectedPickupOption) return;

    const nextPuid = getPickupStopIdForDelivery(
      selectedPickupOption.storeId,
      values.delivery_date,
      selectedPickupOption.slot,
      allDeliveries || []
    ) || "";

    if (values.puid !== nextPuid) {
      setValues((current) => ({ ...current, puid: nextPuid }));
    }
  }, [allDeliveries, pickupOptions, setValues, values.delivery_date, values.puid, values.storeChoice]);

  const hasChanges = useMemo(() => {
    return Object.keys(initialValues).some((key) => values[key] !== initialValues[key]);
  }, [initialValues, values]);

  const shouldShowTimeWindows = !['completed', 'failed'].includes(values.statusChoice);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!hasChanges || isSaving) return;
        onApply(values);
      }}
      className="flex h-full flex-col"
    >
      <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <div className="rounded-lg border p-3" style={{ background: "var(--bg-slate-50)", borderColor: "var(--border-slate-200)" }}>
          <p className="text-sm font-medium" style={{ color: "var(--text-slate-900)" }}>
            {selectedCount} stop{selectedCount === 1 ? "" : "s"} selected
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-slate-500)" }}>
            Leave any field blank or set to Keep current to skip it.
          </p>
        </div>

        <div className={`grid grid-cols-1 gap-4 ${isDriver ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]' : 'sm:grid-cols-2'}`}>
          <div className="space-y-2">
            <Label style={{ color: "var(--text-slate-900)" }}>Assigned Driver</Label>
            <Select
              value={values.driverChoice}
              onValueChange={(value) => setValues((current) => ({ ...current, driverChoice: value }))}
            >
              <SelectTrigger style={getFieldStyle('driverChoice')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[50060]">
                <SelectItem value="unchanged">Keep current</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {drivers.map((driver) => (
                  <SelectItem key={driver.id} value={driver.id}>
                    {driver.user_name || driver.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label style={{ color: "var(--text-slate-900)" }}>Delivery Date</Label>
            <Input
              type="date"
              value={values.delivery_date}
              onChange={(event) => setValues((current) => ({ ...current, delivery_date: event.target.value }))}
              style={getFieldStyle('delivery_date')}
            />
          </div>

          {isDriver && (
            <div className="space-y-2 sm:w-fit">
              <Label style={{ color: "var(--text-slate-900)" }}>Travel Mode</Label>
              <TravelModeButtons
                value={values.travelModeChoice || 'driving'}
                isMixed={isMixedTravelMode}
                onChange={(mode) => setValues((current) => ({ ...current, travelModeChoice: mode }))}
                disabled={isSaving}
              />
            </div>
          )}
        </div>

        <div className={`grid grid-cols-1 gap-4 ${isAdmin ? "lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
          <div className="space-y-2">
            <Label style={{ color: "var(--text-slate-900)" }}>Status</Label>
            <Select
              value={values.statusChoice}
              onValueChange={(value) => setValues((current) => ({ ...current, statusChoice: value }))}
            >
              <SelectTrigger style={getFieldStyle('statusChoice')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[50060]">
                <SelectItem value="unchanged">Keep current</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="in_transit_or_en_route">In Transit / En Route</SelectItem>
                <SelectItem value="completed">Complete</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label style={{ color: "var(--text-slate-900)" }}>Pickup Location</Label>
            <Select
              value={values.storeChoice}
              onValueChange={(value) => setValues((current) => ({ ...current, storeChoice: value }))}
              disabled={isSaving || pickupOptions.length === 0}
            >
              <SelectTrigger style={getFieldStyle('storeChoice')}>
                <SelectValue placeholder={pickupOptions.length === 0 ? "No store slots available" : "Select store [AM/PM]"} />
              </SelectTrigger>
              <SelectContent className="z-[50060]">
                <SelectItem value="unchanged">Keep current</SelectItem>
                {pickupOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label style={{ color: "var(--text-slate-900)" }}>AM/PM</Label>
            <Select
              value={values.ampmChoice}
              onValueChange={(value) => setValues((current) => ({ ...current, ampmChoice: value }))}
            >
              <SelectTrigger style={getFieldStyle('ampmChoice')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[50060]">
                <SelectItem value="unchanged">Keep current</SelectItem>
                <SelectItem value="AM">AM</SelectItem>
                <SelectItem value="PM">PM</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isAdmin && (
            <div className="space-y-2">
              <Label style={{ color: "var(--text-slate-900)" }}>PUID</Label>
              <Input
                value={values.puid}
                onChange={(event) => setValues((current) => ({ ...current, puid: event.target.value }))}
                disabled={isSaving}
                style={getFieldStyle('puid')}
              />
            </div>
          )}
        </div>

        {shouldShowTimeWindows && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label style={{ color: "var(--text-slate-900)" }}>Time Window Start</Label>
              <TimeField
                value={values.delivery_time_start}
                onChange={(event) => setValues((current) => ({ ...current, delivery_time_start: event.target.value }))}
                onClear={() => setValues((current) => ({ ...current, delivery_time_start: '' }))}
                disabled={isSaving}
                style={getFieldStyle('delivery_time_start')}
              />
            </div>
            <div className="space-y-2">
              <Label style={{ color: "var(--text-slate-900)" }}>Time Window End</Label>
              <TimeField
                value={values.delivery_time_end}
                onChange={(event) => setValues((current) => ({ ...current, delivery_time_end: event.target.value }))}
                onClear={() => setValues((current) => ({ ...current, delivery_time_end: '' }))}
                disabled={isSaving}
                style={getFieldStyle('delivery_time_end')}
              />
            </div>
          </div>
        )}
      </div>

      <div className="border-t px-4 py-4" style={{ borderColor: "var(--border-slate-200)" }}>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" disabled={!hasChanges || isSaving}>
            {isSaving ? "Updating..." : "Apply to Selected Stops"}
          </Button>
        </div>
      </div>
    </form>
  );
}

const getSharedValue = (items, getter, fallback = "") => {
  const resolved = items.map(getter).filter((value) => value !== undefined && value !== null && value !== "");
  if (resolved.length !== items.length) return fallback;
  return new Set(resolved.map((value) => String(value))).size === 1 ? String(resolved[0]) : fallback;
};

export default function BulkEditStopsPanel({ open, onOpenChange, isMobile, selectedCount, selectedDeliveries = [], drivers, stores = [], allDeliveries = [], currentUser, onApply, isSaving }) {
  const initialValues = useMemo(() => ({
    delivery_date: getSharedValue(selectedDeliveries, (delivery) => delivery?.delivery_date, ""),
    driverChoice: getSharedValue(selectedDeliveries, (delivery) => delivery?.driver_id, "unchanged"),
    travelModeChoice: getSharedValue(selectedDeliveries, (delivery) => delivery?.transport_mode ?? delivery?.finished_leg_transport_mode, "mixed"),
    delivery_time_start: getSharedValue(selectedDeliveries, (delivery) => delivery?.delivery_time_start, ""),
    delivery_time_end: getSharedValue(selectedDeliveries, (delivery) => delivery?.delivery_time_end, ""),
    statusChoice: getSharedValue(selectedDeliveries, (delivery) => delivery?.status, "unchanged"),
    storeChoice: "unchanged",
    ampmChoice: getSharedValue(selectedDeliveries, (delivery) => delivery?.ampm_deliveries, "unchanged"),
    puid: getSharedValue(selectedDeliveries, (delivery) => delivery?.puid, ""),
  }), [selectedDeliveries]);

  const [values, setValues] = useState(initialValues);

  useEffect(() => {
    setValues(initialValues);
  }, [initialValues, open]);

  const content = (
    <BulkEditStopsForm
      selectedCount={selectedCount}
      drivers={drivers}
      stores={stores}
      allDeliveries={allDeliveries}
      currentUser={currentUser}
      values={values}
      setValues={setValues}
      initialValues={initialValues}
      isSaving={isSaving}
      onCancel={() => onOpenChange(false)}
      onApply={async (nextValues) => {
        await onApply(nextValues);
        onOpenChange(false);
      }}
    />
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerOverlay className="z-[490] bg-black/70" />
        <DrawerContent
          className="z-[500] max-h-[calc(100vh-var(--bottom-nav-height)-0.75rem)]"
          style={{
            background: "var(--bg-white)",
            bottom: "var(--bottom-nav-height)",
          }}
        >
          <DrawerHeader>
            <DrawerTitle style={{ color: "var(--text-slate-900)" }}>Bulk Edit Stops</DrawerTitle>
            <DrawerDescription style={{ color: "var(--text-slate-500)" }}>
              Update the basic route info for the selected stops.
            </DrawerDescription>
          </DrawerHeader>
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetOverlay className="z-[490] bg-black/70" />
      <SheetContent side="right" className="z-[500] w-full p-0 sm:max-w-xl" style={{ background: "var(--bg-white)" }}>
        <SheetHeader className="border-b px-6 py-4" style={{ borderColor: "var(--border-slate-200)" }}>
          <SheetTitle style={{ color: "var(--text-slate-900)" }}>Bulk Edit Stops</SheetTitle>
          <SheetDescription style={{ color: "var(--text-slate-500)" }}>
            Update the basic route info for the selected stops.
          </SheetDescription>
        </SheetHeader>
        <div className="h-[calc(100%-88px)]">{content}</div>
      </SheetContent>
    </Sheet>
  );
}