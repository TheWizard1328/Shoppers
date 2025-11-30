import React from "react";
import AuthDiagnostics from "../components/utils/AuthDiagnostics";

export default function DiagnosticsPage() {
  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-slate-900 mb-6">System Diagnostics</h1>
        <AuthDiagnostics />
      </div>
    </div>
  );
}