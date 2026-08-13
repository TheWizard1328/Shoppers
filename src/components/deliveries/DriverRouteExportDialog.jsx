import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import { Loader2, Plus, Trash2, Calendar, Eye, Barcode, Hash } from "lucide-react";
import { format, parseISO } from "date-fns";

const LS_KEY = "rxdeliver_route_export_driver_emails";
const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const norm = (v) => v.trim().toLowerCase();

// Driver-scoped route export dialog: one manifest for the logged-in driver across ALL stores.
// Mirrors the admin ExportRouteEmailDialog UX (date range + Rx type toggle + Preview/Export)
// but uses a single recipient list instead of per-store email cards.
export default function DriverRouteExportDialog({ open, onOpenChange, isExporting = false, onExportRoute, onPreviewPdf }) {
  const [startDate, setStartDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [endDate, setEndDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [emails, setEmails] = useState([]);
  const [pending, setPending] = useState("");
  const [useBarcodes, setUseBarcodes] = useState(true);

  // Load persisted recipient list (per-device) on open
  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setEmails(parsed.filter((e) => typeof e === "string"));
    } catch { setEmails([]); }
    setPending("");
  }, [open]);

  const persist = (next) => {
    setEmails(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* non-critical */ }
  };

  const addEmail = () => {
    const e = norm(pending);
    if (!isValidEmail(e)) { alert("Enter a valid email address."); return; }
    if (emails.includes(e)) { alert("That email is already listed."); return; }
    persist([...emails, e]);
    setPending("");
  };

  const removeEmail = (e) => persist(emails.filter((x) => x !== e));

  const isRange = endDate > startDate;
  const dayCount = isRange ? Math.round((parseISO(endDate) - parseISO(startDate)) / 86400000) + 1 : 1;
  const rangeTooBig = dayCount > 31;
  const canExport = !isExporting && emails.length > 0 && !rangeTooBig;

  const handleExport = async () => {
    if (!canExport) return;
    await onExportRoute({ recipientEmails: emails, startDate, endDate, useBarcodes });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bg-background px-4 py-3 fixed left-[50%] top-[50%] z-[10001] flex flex-col w-full translate-x-[-50%] translate-y-[-50%] gap-4 border shadow-lg duration-200 sm:rounded-lg max-h-[85vh] overflow-hidden max-w-[480px]"
        style={{ background: "var(--bg-white)", borderColor: "var(--border-slate-200)", color: "var(--text-slate-900)" }}
      >
        <DialogHeader>
          <DialogTitle>Export my route</DialogTitle>
          <DialogDescription>
            Exports your own stops (all stores) for the selected date range.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-shrink-0 space-y-3">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="text-sm font-medium block mb-1" style={{ color: "var(--text-slate-900)" }}>Start Date</label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-400 pointer-events-none" />
                <input type="date" value={startDate} max={format(new Date(), "yyyy-MM-dd")}
                  onChange={(e) => { setStartDate(e.target.value); if (e.target.value > endDate) setEndDate(e.target.value); }}
                  className="w-full pl-10 pr-3 py-2 rounded-md border text-sm"
                  style={{ borderColor: "var(--border-slate-200)", background: "var(--bg-white)", color: "var(--text-slate-900)" }} />
              </div>
            </div>
            <div className="flex-1">
              <label className="text-sm font-medium block mb-1" style={{ color: "var(--text-slate-900)" }}>End Date</label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-400 pointer-events-none" />
                <input type="date" value={endDate} max={format(new Date(), "yyyy-MM-dd")}
                  onChange={(e) => { setEndDate(e.target.value); if (e.target.value < startDate) setStartDate(e.target.value); }}
                  className="w-full pl-10 pr-3 py-2 rounded-md border text-sm"
                  style={{ borderColor: "var(--border-slate-200)", background: "var(--bg-white)", color: "var(--text-slate-900)" }} />
              </div>
            </div>
            {onPreviewPdf && (
              <div className="flex flex-col justify-end">
                <Button type="button" variant="outline" disabled={isExporting || rangeTooBig}
                  onClick={() => onPreviewPdf({ startDate, endDate, useBarcodes })}
                  className="gap-1.5 whitespace-nowrap">
                  <Eye className="w-4 h-4" /> Preview
                </Button>
              </div>
            )}
          </div>

          {isRange && !isExporting && (
            <p className={`text-xs -mt-1 ${rangeTooBig ? "text-red-500 font-medium" : "text-slate-500 dark:text-slate-400"}`}>
              {rangeTooBig ? `⚠️ ${dayCount} days selected — maximum is 31.` : `Exporting ${dayCount} days of your route.`}
            </p>
          )}

          <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: "var(--border-slate-200)" }}>
            <p className="text-sm font-semibold" style={{ color: "var(--text-slate-900)" }}>Recipients</p>
            <div className="space-y-1">
              {emails.map((e) => (
                <div key={e} className="flex items-center justify-between rounded px-2 py-1 text-xs"
                  style={{ background: "var(--bg-slate-50)", color: "var(--text-slate-700)" }}>
                  <span className="truncate">{e}</span>
                  <button type="button" onClick={() => removeEmail(e)} className="text-red-400 hover:text-red-600 ml-2 flex-shrink-0">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5">
              <Input type="email" placeholder="Add email..." value={pending}
                onChange={(e) => setPending(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }}
                className="flex-1 h-7 text-xs"
                style={{ borderColor: "var(--border-slate-200)", background: "var(--bg-white)", color: "var(--text-slate-900)" }} />
              <Button type="button" size="sm" variant="outline" onClick={addEmail} className="h-7 px-2 flex-shrink-0">
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-shrink-0 pt-2 border-t flex items-center justify-between gap-2" style={{ borderColor: "var(--border-slate-200)" }}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-600 dark:text-slate-400">Rx Type:</span>
            <div className="flex-shrink-0 flex rounded-md border overflow-hidden" style={{ borderColor: "var(--border-slate-200)" }}>
              <button type="button" onClick={() => setUseBarcodes(false)}
                className="flex items-center justify-center w-9 h-8 transition-colors"
                style={{ background: !useBarcodes ? "#1e293b" : "var(--bg-white)", color: !useBarcodes ? "#fff" : "#64748b" }}>
                <Hash className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => setUseBarcodes(true)}
                className="flex items-center justify-center w-9 h-8 border-l transition-colors"
                style={{ borderColor: "var(--border-slate-200)", background: useBarcodes ? "#1e293b" : "var(--bg-white)", color: useBarcodes ? "#fff" : "#64748b" }}>
                <Barcode className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isExporting}>Cancel</Button>
            <Button onClick={handleExport} disabled={!canExport} className="bg-blue-600 hover:bg-blue-700 text-white">
              {isExporting ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Exporting…</>) : isRange ? "Export Date Range" : "Export Route"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}