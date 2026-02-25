import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Minimal placeholder to keep app working after moving file
// Accepts all props but renders a simple summary for now
export default function PayrollSummaryCard({
  deliveries = [],
  drivers = [],
  appUsers = [],
  patients = [],
  cities = [],
  stores = [],
  selectedYear,
  selectedDriverId,
  selectedCityId,
  payPeriod,
  currentPeriod,
  onFinalizePayroll,
  onPayrollRecordsChange,
  payrollRecords = [],
  refreshPayrollRecords,
}) {
  const periodLabel = currentPeriod?.label || "Selected Period";
  const totalDeliveries = Array.isArray(deliveries) ? deliveries.length : 0;
  const driverCount = Array.isArray(drivers) ? drivers.length : 0;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">Payroll Summary (temporarily simplified)</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-slate-600 space-y-1">
        <div>Period: <strong>{periodLabel}</strong></div>
        <div>Year: <strong>{selectedYear}</strong></div>
        <div>Total Deliveries: <strong>{totalDeliveries}</strong></div>
        <div>Drivers Shown: <strong>{driverCount}</strong></div>
        <div className="text-xs text-slate-500 mt-2">Note: Component was moved to src/components/payroll/PayrollSummaryCard.jsx. Detailed UI will render once the full component content is restored.</div>
      </CardContent>
    </Card>
  );
}