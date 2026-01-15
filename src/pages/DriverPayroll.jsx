import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText } from "lucide-react";

export default function DriverPayroll() {
  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <FileText className="w-8 h-8 text-emerald-600" />
          <h1 className="text-2xl font-bold text-slate-900">Driver Payroll</h1>
        </div>
        
        <Card>
          <CardHeader>
            <CardTitle>Payroll Management</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-slate-600">Driver payroll management coming soon.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}