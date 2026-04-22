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
    <div className="grid w-full grid-cols-2 gap-1 sm:gap-2 md:flex md:w-auto md:flex-wrap md:items-center md:justify-start">
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
            className="h-10 w-full min-w-0 justify-between rounded-xl px-2 text-xs sm:h-11 sm:px-3 sm:text-sm md:h-9 md:w-auto md:justify-center md:gap-2 md:rounded-full md:px-3"
          >
            <span className="truncate">{view.label}</span>
            {typeof count === "number" && (
              <span className="shrink-0 text-[11px] opacity-80 sm:text-xs">{count}</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}