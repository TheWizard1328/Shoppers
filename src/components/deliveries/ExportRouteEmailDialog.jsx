import React, { useEffect, useMemo, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle } from
"@/components/ui/dialog";
import { Loader2, Plus, Trash2, Calendar, Eye, Barcode, Hash } from "lucide-react";
import { useUser } from "@/components/utils/UserContext";
import { isAppOwner, userHasRole } from "@/components/utils/userRoles";
import { format, parseISO } from "date-fns";

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const normalizeEmail = (value) => value.trim().toLowerCase();

export default function ExportRouteEmailDialog({
  open,
  onOpenChange,
  storeIds = [],
  isExporting = false,
  onExportRoute,
  onPreviewPdf
}) {
  const { currentUser } = useUser();
  const [stores, setStores] = useState([]);
  const [emailDrafts, setEmailDrafts] = useState({});
  const [pendingEmails, setPendingEmails] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testingEmail, setTestingEmail] = useState("");
  const [appSettingsId, setAppSettingsId] = useState(null);
  const [allDeliveries, setAllDeliveries] = useState([]);
  const [allStoresData, setAllStoresData] = useState([]);
  const [driverNamesByStore, setDriverNamesByStore] = useState({});
  const [useBarcodes, setUseBarcodes] = useState(false);

  // Both date pickers always visible
  const [startDate, setStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const storeIdsKey = useMemo(() => storeIds.join(","), [storeIds]);

  useEffect(() => {
    if (!open) return;
    let isActive = true;
    setIsLoading(true);
    const today = format(new Date(), 'yyyy-MM-dd');
    setStartDate(today);
    setEndDate(today);

    Promise.all([
      base44.entities.Store.list(),
      base44.entities.AppSettings.filter({ setting_key: 'route_export_testing_email' }),
      base44.entities.Delivery.list('-delivery_date', 2000)
    ]).then(([allStores, settings, deliveries]) => {
      if (!isActive) return;
      setAllStoresData(allStores || []);
      setAllDeliveries(deliveries || []);
      if (settings && settings.length > 0) {
        setTestingEmail(settings[0].setting_value?.email || "");
        setAppSettingsId(settings[0].id);
      } else {
        setTestingEmail("");
        setAppSettingsId(null);
      }

      // Auto-select: iterate backwards from yesterday to find the best completed date
      const isOwner = isAppOwner(currentUser);
      const isAdmin = userHasRole(currentUser, 'admin');
      const isDispatcher = userHasRole(currentUser, 'dispatcher') && !isAdmin && !isOwner;

      const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);

      // Build a set of all dates (including today) with at least one delivery
      const allDates = new Set();
      (deliveries || []).forEach((d) => {
        if (d && d.delivery_date && d.delivery_date <= today) allDates.add(d.delivery_date);
      });
      const sortedDates = [...allDates].sort((a, b) => b.localeCompare(a));

      let bestDate = null;

      if (isDispatcher) {
        // Dispatcher: find most recent date where ALL stops for their stores (any driver/company) are finished
        const dispatcherStoreIds = new Set(currentUser?.store_ids || []);
        bestDate = sortedDates.find((dateStr) => {
          const dayDeliveries = (deliveries || []).filter(
            (d) => d && d.delivery_date === dateStr && dispatcherStoreIds.has(d.store_id)
          );
          return dayDeliveries.length > 0 && dayDeliveries.every((d) => finishedStatuses.has(d.status));
        }) || null;
      } else {
        // Admin/Owner: find most recent date where ALL deliveries across ALL stores/drivers are finished
        bestDate = sortedDates.find((dateStr) => {
          const dayDeliveries = (deliveries || []).filter(
            (d) => d && d.delivery_date === dateStr
          );
          return dayDeliveries.length > 0 && dayDeliveries.every((d) => finishedStatuses.has(d.status));
        }) || null;
      }

      if (bestDate) {
        setStartDate(bestDate);
        setEndDate(bestDate);
      }

      setIsLoading(false);
    });

    return () => { isActive = false; };
  }, [open]);

  // Update stores and drivers whenever dates change
  useEffect(() => {
    if (!open || allStoresData.length === 0 || allDeliveries.length === 0) return;

    const isOwner = isAppOwner(currentUser);
    const isAdmin = userHasRole(currentUser, 'admin');

    // Collect all dates in the range
    const datesToCheck = (() => {
      const dates = [];
      const s = parseISO(startDate);
      const e = parseISO(endDate);
      for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        dates.push(format(d, 'yyyy-MM-dd'));
      }
      return dates.length > 0 ? dates : [startDate];
    })();

    const storesWithDeliveries = new Set(
      allDeliveries
        .filter((d) => d && datesToCheck.includes(d.delivery_date))
        .map((d) => d.store_id)
    );

    let filteredStores = (allStoresData || []).filter((store) => {
      if (!storesWithDeliveries.has(store.id)) return false;
      if (isOwner || isAdmin) return true;
      return currentUser?.store_ids?.includes(store.id);
    });

    filteredStores.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));

    const drafts = {};
    filteredStores.forEach((store) => {
      drafts[store.id] = Array.isArray(store.route_export_emails) ? store.route_export_emails : [];
    });

    // Driver names across the full date range
    const driverNames = {};
    filteredStores.forEach((store) => {
      const storeDeliveries = allDeliveries.filter(
        (d) => d && datesToCheck.includes(d.delivery_date) && d.store_id === store.id
      );
      const uniqueDrivers = [...new Set(storeDeliveries.map((d) => d.driver_name || d.driver_id).filter(Boolean))];
      driverNames[store.id] = uniqueDrivers;
    });

    setStores(filteredStores);
    setEmailDrafts(drafts);
    setPendingEmails({});
    setDriverNamesByStore(driverNames);
  }, [open, startDate, endDate, allStoresData, allDeliveries, currentUser]);

  const addEmail = async (storeId) => {
    const nextEmail = normalizeEmail(pendingEmails[storeId] || "");
    if (!isValidEmail(nextEmail)) { alert("Enter a valid email address."); return; }
    const currentEmails = emailDrafts[storeId] || [];
    if (currentEmails.includes(nextEmail)) { alert("That email is already listed."); return; }
    const updatedEmails = [...currentEmails, nextEmail];
    setEmailDrafts((current) => ({ ...current, [storeId]: updatedEmails }));
    setPendingEmails((current) => ({ ...current, [storeId]: "" }));
    await base44.entities.Store.update(storeId, { route_export_emails: updatedEmails });
  };

  const removeEmail = async (storeId, emailToRemove) => {
    const updatedEmails = (emailDrafts[storeId] || []).filter((email) => email !== emailToRemove);
    setEmailDrafts((current) => ({ ...current, [storeId]: updatedEmails }));
    await base44.entities.Store.update(storeId, { route_export_emails: updatedEmails });
  };

  const saveEmails = async () => {
    setIsSaving(true);
    // Store emails are already saved on add/remove — only save app owner testing email here
    const promises = [];
    if (testingEmail) {
      if (appSettingsId) {
        promises.push(base44.entities.AppSettings.update(appSettingsId, { setting_value: { email: testingEmail } }));
      } else {
        promises.push(
          base44.entities.AppSettings.create({
            setting_key: 'route_export_testing_email',
            setting_value: { email: testingEmail },
            description: 'App Owner testing email for route exports'
          }).then((res) => setAppSettingsId(res.id))
        );
      }
    } else if (appSettingsId) {
      promises.push(base44.entities.AppSettings.delete(appSettingsId).then(() => setAppSettingsId(null)));
    }
    await Promise.all(promises);
    setIsSaving(false);
  };

  const [exportProgress, setExportProgress] = useState(0); // 0-100
  const exportProgressRef = useRef(null);

  const startProgressAnimation = (totalDays) => {
    setExportProgress(0);
    const estimatedMs = Math.max(totalDays * 350, 1500);
    const intervalMs = 80;
    const steps = estimatedMs / intervalMs;
    let step = 0;
    exportProgressRef.current = setInterval(() => {
      step++;
      // Ease-out: fast start, slow near 90%
      const raw = step / steps;
      const eased = 1 - Math.pow(1 - raw, 2);
      setExportProgress(Math.min(Math.round(eased * 90), 90));
      if (step >= steps) clearInterval(exportProgressRef.current);
    }, intervalMs);
  };

  const stopProgressAnimation = (success = true) => {
    if (exportProgressRef.current) clearInterval(exportProgressRef.current);
    setExportProgress(success ? 100 : 0);
  };

  const handleExportRoute = async () => {
    await saveEmails();
    const perStoreEmails = stores.reduce((acc, store) => {
      const emails = [...(emailDrafts[store.id] || [])];
      if (testingEmail && isValidEmail(testingEmail)) emails.push(testingEmail);
      acc[store.id] = emails;
      return acc;
    }, {});

    let allRecipientEmails = stores.flatMap((store) => emailDrafts[store.id] || []);
    if (testingEmail && isValidEmail(testingEmail)) allRecipientEmails.push(testingEmail);
    const recipientEmails = [...new Set(allRecipientEmails)];

    startProgressAnimation(dayCount);
    try {
      await onExportRoute({
        recipientEmails,
        perStoreEmails,
        exportDate: startDate,
        startDate,
        endDate,
        stores,
        storeName: stores.length === 1 ? stores[0]?.name : undefined,
        useBarcodes
      });
      stopProgressAnimation(true);
      setTimeout(() => { onOpenChange(false); setExportProgress(0); }, 600);
    } catch {
      stopProgressAnimation(false);
    }
  };

  const isRange = endDate > startDate;
  const dayCount = isRange ? Math.round((parseISO(endDate) - parseISO(startDate)) / 86400000) + 1 : 1;
  const rangeTooBig = dayCount > 31;
  const canExport = !isLoading && !isExporting && stores.length > 0 && startDate && !rangeTooBig;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bg-background px-4 py-3 fixed left-[50%] top-[50%] z-[10001] flex flex-col w-full translate-x-[-50%] translate-y-[-50%] gap-4 border shadow-lg duration-200 sm:rounded-lg max-h-[85vh] overflow-hidden max-w-[480px]"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>

        <DialogHeader>
          <DialogTitle>Route export</DialogTitle>
          <DialogDescription>
            Select a date or date range, then review recipient email addresses below.
          </DialogDescription>
        </DialogHeader>

        {/* ── Fixed top section: date pickers + testing email ─────────── */}
        <div className="flex-shrink-0 space-y-3">
          {/* Date range */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="text-sm font-medium block mb-1" style={{ color: 'var(--text-slate-900)' }}>
                Start Date
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                <input
                  type="date"
                  value={startDate}
                  max={format(new Date(), 'yyyy-MM-dd')}
                  onChange={(e) => {
                    const val = e.target.value;
                    setStartDate(val);
                    if (val > endDate) setEndDate(val);
                  }}
                  className="w-full pl-10 pr-3 py-2 rounded-md border text-sm"
                  style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}
                />
              </div>
            </div>

            <div className="flex-1">
              <label className="text-sm font-medium block mb-1" style={{ color: 'var(--text-slate-900)' }}>
                End Date
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                <input
                  type="date"
                  value={endDate}
                  max={format(new Date(), 'yyyy-MM-dd')}
                  onChange={(e) => {
                    const val = e.target.value;
                    setEndDate(val);
                    if (val < startDate) setStartDate(val);
                  }}
                  className="w-full pl-10 pr-3 py-2 rounded-md border text-sm"
                  style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}
                />
              </div>
            </div>

            {/* Preview button — admins, owners, dispatchers */}
            {onPreviewPdf && (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) && (
              <div className="flex flex-col justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isExporting || isLoading || rangeTooBig}
                  onClick={() => onPreviewPdf({ startDate, endDate, useBarcodes })}
                  className="gap-1.5 whitespace-nowrap"
                >
                  <Eye className="w-4 h-4" />
                  Preview
                </Button>
              </div>
            )}
          </div>

          {isRange && !isExporting && (
            <p className={`text-xs -mt-1 ${rangeTooBig ? 'text-red-500 font-medium' : 'text-slate-500'}`}>
              {rangeTooBig
                ? `⚠️ ${dayCount} days selected — maximum is 31. Please shorten the range.`
                : `Exporting ${dayCount} days — stores with deliveries in any day of this range will appear below.`}
            </p>
          )}
          {isExporting && (
            <div className="-mt-1 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-blue-600 font-medium">
                  {exportProgress < 100 ? `Generating PDF… ${exportProgress}%` : '✓ Done!'}
                </span>
                <span className="text-xs text-slate-400">{dayCount} day{dayCount !== 1 ? 's' : ''}</span>
              </div>
              <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-slate-200, #e2e8f0)' }}>
                <div
                  className="h-full rounded-full transition-all duration-150"
                  style={{
                    width: `${exportProgress}%`,
                    background: exportProgress === 100 ? '#16a34a' : '#2563eb'
                  }}
                />
              </div>
            </div>
          )}

          {/* Testing email — fixed below date pickers */}
          {isAppOwner(currentUser) && (
            <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--border-blue-200)', background: 'var(--bg-blue-50, #eff6ff)' }}>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                Preview / Testing Email <span className="text-xs font-normal text-slate-400">(App Owner only — always receives a copy)</span>
              </p>
              <Input
                type="email"
                placeholder="owner@example.com"
                value={testingEmail}
                onChange={(e) => setTestingEmail(e.target.value)}
                className="h-8 text-sm"
                style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}
              />
            </div>
          )}
        </div>

        {/* ── Scrollable store cards ───────────────────────────────────── */}
        <div className="overflow-y-auto flex-1 pr-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          ) : stores.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">
              No stores with deliveries found for the selected date{isRange ? ' range' : ''}.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {stores.map((store) => (
                <div key={store.id} className="rounded-lg border p-3 space-y-2"
                  style={{ borderColor: 'var(--border-slate-200)' }}>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{store.name}</p>
                    {driverNamesByStore[store.id]?.length > 0 && (
                      <p className="text-xs text-slate-500">
                        Driver{driverNamesByStore[store.id].length > 1 ? 's' : ''}: {driverNamesByStore[store.id].join(', ')}
                      </p>
                    )}
                  </div>

                  {/* Existing emails */}
                  <div className="space-y-1">
                    {(emailDrafts[store.id] || []).map((email) => (
                      <div key={email} className="flex items-center justify-between rounded px-2 py-1 text-xs"
                        style={{ background: 'var(--bg-slate-50)', color: 'var(--text-slate-700)' }}>
                        <span className="truncate">{email}</span>
                        <button type="button" onClick={() => removeEmail(store.id, email)}
                          className="text-red-400 hover:text-red-600 ml-2 flex-shrink-0">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Add email */}
                  <div className="flex gap-1.5">
                    <Input
                      type="email"
                      placeholder="Add email..."
                      value={pendingEmails[store.id] || ""}
                      onChange={(e) => setPendingEmails((p) => ({ ...p, [store.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addEmail(store.id); } }}
                      className="flex-1 h-7 text-xs"
                      style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}
                    />
                    <Button type="button" size="sm" variant="outline" onClick={() => addEmail(store.id)}
                      className="h-7 px-2 flex-shrink-0">
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-shrink-0 pt-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
          {/* Left: Rx Type label + # / barcode segmented toggle */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-600">Rx Type:</span>
          <div className="flex-shrink-0 flex rounded-md border overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
            <button
              type="button"
              onClick={() => setUseBarcodes(false)}
              className="flex items-center justify-center w-9 h-8 transition-colors"
              style={{ background: !useBarcodes ? '#1e293b' : 'var(--bg-white)', color: !useBarcodes ? '#fff' : '#64748b' }}
            >
              <Hash className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setUseBarcodes(true)}
              className="flex items-center justify-center w-9 h-8 border-l transition-colors"
              style={{ borderColor: 'var(--border-slate-200)', background: useBarcodes ? '#1e293b' : 'var(--bg-white)', color: useBarcodes ? '#fff' : '#64748b' }}
            >
              <Barcode className="w-3.5 h-3.5" />
            </button>
          </div>
          </div>

          {/* Right: Cancel + Export */}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isExporting}>
              Cancel
            </Button>
            <Button
              onClick={handleExportRoute}
              disabled={!canExport}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {isExporting ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Exporting…</>
              ) : isRange ? (
                'Export Date Range'
              ) : (
                'Export Route'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}