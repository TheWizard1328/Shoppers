import React from "react";
import { Button } from "@/components/ui/button";

const VIEWS = [
{ key: "deliveries", label: "Deliveries" },
{ key: "transactions", label: "Transactions" },
{ key: "catalog", label: "Catalog" },
{ key: "reconciliation", label: "Reconciliation" }];


export default function SquareCodViewSwitcher({ activeView, onChange, counts = {}, hidden = false }) {
  if (hidden) return null;
  return (
    <div className="flex flex-row gap-2 md:flex md:flex-row md:flex-wrap md:items-center md:gap-3 py-1">
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
            className="flex-1 h-auto min-h-[3rem] justify-center rounded-2xl px-2 md:flex-none md:w-[130px] md:rounded-md md:min-h-[3rem] md:py-2 md:px-3">
            
            <span className="flex flex-col items-center justify-center text-center leading-tight">
              <span className="text-xs font-medium">{view.label}</span>
              {typeof count === "number" &&
              <span className="text-[11px] opacity-70">({count})</span>
              }
            </span>
          </Button>);

      })}
    </div>);

}