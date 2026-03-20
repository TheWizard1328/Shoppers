import React from "react";
import { Button } from "@/components/ui/button";

const VIEWS = [
  { key: "deliveries", label: "Deliveries" },
  { key: "transactions", label: "Transactions" },
  { key: "catalog", label: "Catalog" },
  { key: "reconciliation", label: "Reconciliation" }
];

export default function SquareCodViewSwitcher({ activeView, onChange, counts = {} }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {VIEWS.map((view) => {
        const count = counts[view.key];
        const isActive = activeView === view.key;

        return (
          <Button
            key={view.key}
            type="button"
            variant={isActive ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(view.key)}
            className="gap-2 rounded-full px-3"
          >
            <span>{view.label}</span>
            {typeof count === "number" && (
              <span className="text-xs opacity-80">{count}</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}