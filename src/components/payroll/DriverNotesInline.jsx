import React, { useState, useEffect } from "react";

export default function DriverNotesInline({
  showAdmin = false,
  canEditAdmin = false,
  canEditDriver = false,
  initialAdminNotes = "",
  initialDriverNotes = "",
  onSaveAdmin,
  onSaveDriver,
}) {
  const [adminNotes, setAdminNotes] = useState(initialAdminNotes || "");
  const [driverNotes, setDriverNotes] = useState(initialDriverNotes || "");
  const [savingAdmin, setSavingAdmin] = useState(false);
  const [savingDriver, setSavingDriver] = useState(false);

  // Sync when props change (e.g., live refresh)
  useEffect(() => { setAdminNotes(initialAdminNotes || ""); }, [initialAdminNotes]);
  useEffect(() => { setDriverNotes(initialDriverNotes || ""); }, [initialDriverNotes]);

  const handleAdminBlur = async () => {
    if (!onSaveAdmin || !canEditAdmin) return;
    setSavingAdmin(true);
    try { await onSaveAdmin(adminNotes); } finally { setSavingAdmin(false); }
  };

  const handleDriverBlur = async () => {
    if (!onSaveDriver || !canEditDriver) return;
    setSavingDriver(true);
    try { await onSaveDriver(driverNotes); } finally { setSavingDriver(false); }
  };

  return (
    <div data-notes-section="true" className="mt-2 space-y-2">
      {showAdmin && (
        <div>
          <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">Admin Notes</div>
          <textarea
            value={adminNotes}
            onChange={(e) => setAdminNotes(e.target.value)}
            onBlur={handleAdminBlur}
            disabled={!canEditAdmin}
            className="w-full min-h-[56px] text-xs p-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-60"
            placeholder="Private notes (admins only)"
          />
          {savingAdmin && <div className="text-[10px] text-slate-500 mt-1">Saving...</div>}
        </div>
      )}

      <div>
        <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">Driver Notes</div>
        <textarea
          value={driverNotes}
          onChange={(e) => setDriverNotes(e.target.value)}
          onBlur={handleDriverBlur}
          disabled={!canEditDriver}
          className="w-full min-h-[56px] text-xs p-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-60"
          placeholder="Visible to driver + admins"
        />
        {savingDriver && <div className="text-[10px] text-slate-500 mt-1">Saving...</div>}
      </div>
    </div>
  );
}