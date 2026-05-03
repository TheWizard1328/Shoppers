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
    <div className="grid grid-cols-4 gap-2 md:w=[130px] md:flex-wrap md:items-center md:justify-start">
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
            className="h-11 justify-between rounded-2xl px-4 md:h-9 md:w-[130px]] md:justify-center md:gap-2 md:rounded-full md:px-3"
          >
            <span>{view.label}:</span>
            {typeof count === "number" && (
              <span className="text-xs opacity-80">{count}</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}