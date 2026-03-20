import React from "react";
import { Button } from "@/components/ui/button";

const tabs = [
  { id: "reconciliation", label: "Reconciliation" },
  { id: "deliveries", label: "Deliveries" },
  { id: "transactions", label: "Transactions" },
  { id: "catalog", label: "Catalog" },
];

export default function SquareCODViewTabs({ activeView, onChange }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {tabs.map((tab) => {
        const isActive = activeView === tab.id;

        return (
          <Button
            key={tab.id}
            type="button"
            variant={isActive ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(tab.id)}
            className="gap-2 text-sm"
          >
            <span className={`h-2 w-2 rounded-full ${isActive ? "bg-white" : "bg-slate-400"}`} />
            {tab.label}
          </Button>
        );
      })}
    </div>
  );
}