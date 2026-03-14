import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";

function BulkEditStopsForm({ selectedCount, drivers, values, setValues, onApply, onCancel, isSaving }) {
  const hasChanges = useMemo(() => {
    return Boolean(
      values.delivery_date ||
      values.delivery_time_start ||
      values.delivery_time_end ||
      values.driverChoice !== "unchanged"
    );
  }, [values]);

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

        <div className="space-y-2">
          <Label style={{ color: "var(--text-slate-900)" }}>Delivery Date</Label>
          <Input
            type="date"
            value={values.delivery_date}
            onChange={(event) => setValues((current) => ({ ...current, delivery_date: event.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <Label style={{ color: "var(--text-slate-900)" }}>Assigned Driver</Label>
          <Select
            value={values.driverChoice}
            onValueChange={(value) => setValues((current) => ({ ...current, driverChoice: value }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label style={{ color: "var(--text-slate-900)" }}>Time Window Start</Label>
            <Input
              type="time"
              value={values.delivery_time_start}
              onChange={(event) => setValues((current) => ({ ...current, delivery_time_start: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label style={{ color: "var(--text-slate-900)" }}>Time Window End</Label>
            <Input
              type="time"
              value={values.delivery_time_end}
              onChange={(event) => setValues((current) => ({ ...current, delivery_time_end: event.target.value }))}
            />
          </div>
        </div>
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

export default function BulkEditStopsPanel({ open, onOpenChange, isMobile, selectedCount, drivers, onApply, isSaving }) {
  const [values, setValues] = useState({
    delivery_date: "",
    driverChoice: "unchanged",
    delivery_time_start: "",
    delivery_time_end: "",
  });

  useEffect(() => {
    if (!open) {
      setValues({
        delivery_date: "",
        driverChoice: "unchanged",
        delivery_time_start: "",
        delivery_time_end: "",
      });
    }
  }, [open]);

  const content = (
    <BulkEditStopsForm
      selectedCount={selectedCount}
      drivers={drivers}
      values={values}
      setValues={setValues}
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
        <DrawerContent className="max-h-[85vh]" style={{ background: "var(--bg-white)" }}>
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
      <SheetContent side="right" className="w-full p-0 sm:max-w-xl" style={{ background: "var(--bg-white)" }}>
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