import React from 'react';
import { ShieldAlert } from 'lucide-react';
import EmergencySettingsPanel from '@/components/admin/EmergencySettingsPanel';

// OWNER REQUEST (Nov 26 2026): "move the crash detection settings utilities
// section into a link of its own on the sidebar under admin, just above the
// stats holiday link." The panel itself is unchanged — it simply lives on its
// own page now instead of at the top of Admin Utilities > Alerts.
export default function CrashDetectionSettings() {
  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center shrink-0">
          <ShieldAlert className="h-5 w-5 text-red-600" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg md:text-xl font-semibold text-slate-900 leading-tight">Crash Detection</h1>
          <p className="text-xs md:text-sm text-slate-500">
            Emergency impact detection, alert scope and siren settings.
          </p>
        </div>
      </div>
      <EmergencySettingsPanel />
    </div>
  );
}
