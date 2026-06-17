import React from "react";
import { Button } from "@/components/ui/button";

const viewOptions = [
  { key: "reconciliation", label: "Reconciliation", disabled: true },
  { key: "deliveries", label: "Deliveries" },
  { key: "transactions", label: "Transactions" },
  { key: "catalog", label: "Catalog" },
];

export default function SquareViewToggle({ selectedView, onSelect }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {viewOptions.map((view) => (
        <Button
          key={view.key}
          type="button"
          size="sm"
          variant={selectedView === view.key ? "default" : "outline"}
          disabled={view.disabled}
          onClick={() => onSelect(view.key)}
          className="text-xs md:text-sm"
        >
          {view.label}
        </Button>
      ))}
    </div>
  );
}