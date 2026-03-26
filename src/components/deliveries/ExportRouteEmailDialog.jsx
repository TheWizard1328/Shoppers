import React, { useEffect, useMemo, useState } from "react";
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
import { Loader2, Plus, Trash2, FileText, Calendar } from "lucide-react";
import { useUser } from "@/components/utils/UserContext";
import { isAppOwner, userHasRole } from "@/components/utils/userRoles";
import { format, subDays } from "date-fns";

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
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [allDeliveries, setAllDeliveries] = useState([]);
  const [isCheckingCompletion, setIsCheckingCompletion] = useState(false);
  const [isExportEnabled, setIsExportEnabled] = useState(false);
  const [allStoresData, setAllStoresData] = useState([]);
  const [driverNamesByStore, setDriverNamesByStore] = useState({});

  const storeIdsKey = useMemo(() => storeIds.join(","), [storeIds]);

  useEffect(() => {
    if (!open) return;

    let isActive = true;
    setIsLoading(true);
    setSelectedDate(format(new Date(), 'yyyy-MM-dd'));

    Promise.all([
    base44.entities.Store.list(),
    base44.entities.AppSettings.filter({ setting_key: 'route_export_testing_email' }),
    base44.entities.Delivery.list()]
    ).then(([allStores, settings, deliveries]) => {
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

      setIsLoading(false);
    });

    return () => {
      isActive = false;
    };
  }, [open]);

  // Update stores based on selected date and user role
  useEffect(() => {
    if (!open || allStoresData.length === 0 || allDeliveries.length === 0) return;

    const isOwner = isAppOwner(currentUser);
    const isAdmin = userHasRole(currentUser, 'admin');
    
    // Get stores with deliveries on selected date
    const storesWithDeliveries = new Set(
      allDeliveries
        .filter((d) => d && d.delivery_date === selectedDate)
        .map((d) => d.store_id)
    );

    // Filter stores: admins see all stores with deliveries, others see only their assigned stores
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

    // Get driver names for each store on selected date
    const driverNames = {};
    filteredStores.forEach((store) => {
      const storeDeliveries = allDeliveries.filter(
        (d) => d && d.delivery_date === selectedDate && d.store_id === store.id
      );
      const uniqueDrivers = [...new Set(
        storeDeliveries
          .map((d) => d.driver_name || d.driver_id)
          .filter(Boolean)
      )];
      driverNames[store.id] = uniqueDrivers;
    });

    setStores(filteredStores);
    setEmailDrafts(drafts);
    setPendingEmails({});
    setDriverNamesByStore(driverNames);
  }, [open, selectedDate, allStoresData, allDeliveries, currentUser]);

  // Check completion status and find default date
  useEffect(() => {
    if (!open || isLoading || allDeliveries.length === 0 || allStoresData.length === 0) return;

    setIsCheckingCompletion(true);
    const isOwner = isAppOwner(currentUser);
    const isAdmin = userHasRole(currentUser, 'admin');
    let today = new Date();
    today.setHours(0, 0, 0, 0);

    // Try today first, then search backwards for first date with all stops finished
    for (let i = 0; i < 365; i++) {
      const checkDate = subDays(today, i);
      const checkDateStr = format(checkDate, 'yyyy-MM-dd');

      const relevantDeliveries = allDeliveries.filter((d) => {
        if (!d || d.delivery_date !== checkDateStr) return false;
        if (isOwner || isAdmin) return true;
        return currentUser?.store_ids?.includes(d.store_id);
      });

      if (relevantDeliveries.length > 0) {
        const allFinished = relevantDeliveries.every((d) =>
        ['completed', 'failed', 'cancelled'].includes(d?.status)
        );

        if (allFinished) {
          setSelectedDate(checkDateStr);
          setIsExportEnabled(true);
          setIsCheckingCompletion(false);
          return;
        }
      }
    }

    setIsCheckingCompletion(false);
    setIsExportEnabled(false);
  }, [open, isLoading, allDeliveries, allStoresData, currentUser]);

  // Check if selected date is valid for export
  const checkDateCompletion = (dateStr) => {
    const isOwner = isAppOwner(currentUser);
    const isAdmin = userHasRole(currentUser, 'admin');
    const relevantDeliveries = allDeliveries.filter((d) => {
      if (!d || d.delivery_date !== dateStr) return false;
      if (isOwner || isAdmin) return true;
      return currentUser?.store_ids?.includes(d.store_id);
    });

    if (relevantDeliveries.length === 0) return false;
    return relevantDeliveries.every((d) =>
    ['completed', 'failed', 'cancelled'].includes(d?.status)
    );
  };

  const addEmail = (storeId) => {
    const nextEmail = normalizeEmail(pendingEmails[storeId] || "");
    if (!isValidEmail(nextEmail)) {
      alert("Enter a valid email address.");
      return;
    }

    const currentEmails = emailDrafts[storeId] || [];
    if (currentEmails.includes(nextEmail)) {
      alert("That email is already listed.");
      return;
    }

    setEmailDrafts((current) => ({
      ...current,
      [storeId]: [...currentEmails, nextEmail]
    }));
    setPendingEmails((current) => ({ ...current, [storeId]: "" }));
  };

  const removeEmail = (storeId, emailToRemove) => {
    setEmailDrafts((current) => ({
      ...current,
      [storeId]: (current[storeId] || []).filter((email) => email !== emailToRemove)
    }));
  };

  const saveEmails = async () => {
    setIsSaving(true);
    const promises = stores.map((store) =>
    base44.entities.Store.update(store.id, {
      route_export_emails: emailDrafts[store.id] || []
    })
    );

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
      promises.push(
        base44.entities.AppSettings.delete(appSettingsId).then(() => setAppSettingsId(null))
      );
    }

    await Promise.all(promises);
    setIsSaving(false);
  };

  const handleExportRoute = async () => {
    await saveEmails();
    const perStoreEmails = stores.reduce((acc, store) => {
      const emails = [...(emailDrafts[store.id] || [])];
      if (testingEmail && isValidEmail(testingEmail)) {
        emails.push(testingEmail);
      }
      acc[store.id] = emails;
      return acc;
    }, {});

    let allRecipientEmails = stores.flatMap((store) => emailDrafts[store.id] || []);
    if (testingEmail && isValidEmail(testingEmail)) {
      allRecipientEmails.push(testingEmail);
    }
    const recipientEmails = [...new Set(allRecipientEmails)];

    onOpenChange(false);
    await onExportRoute({ recipientEmails, perStoreEmails, exportDate: selectedDate });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background px-4 py-3 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-[10001] flex flex-col w-full translate-x-[-50%] translate-y-[-50%] gap-4 border shadow-lg duration-200 sm:rounded-lg max-w-[750px] max-h-[85vh] overflow-hidden"

      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>

        <DialogHeader>
          <DialogTitle>Route export</DialogTitle>
          <DialogDescription>
            Select a date and review email addresses for the route export.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 pb-1 space-y-1">
          <label className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
            Export Date
          </label>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-500" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              disabled={isLoading || isCheckingCompletion}
              className="flex-1 px-3 py-2 rounded-md border text-sm"
              style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }} />
            
          </div>
          {!checkDateCompletion(selectedDate) &&
          <p className="text-xs" style={{ color: '#dc2626' }}>Not all stops for the selected date are finished.</p>
          }
        </div>

        {(isAppOwner(currentUser) || userHasRole(currentUser, 'admin')) &&
        <div className="space-y-1 mt-2 mb-4">
            <label className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
              Testing Email (App Owner)
            </label>
            <div className="flex gap-2">
              <Input
              type="email"
              value={testingEmail}
              onChange={(e) => setTestingEmail(e.target.value)}
              placeholder="your.email@example.com"
              className="flex-1" />
              
              {onPreviewPdf &&
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                await saveEmails();
                onPreviewPdf();
              }}
              disabled={isLoading || isSaving || isExporting}
              className="shrink-0">
              
                  <FileText className="w-4 h-4 mr-2" />
                  Preview PDF
                </Button>
            }
            </div>
            
            {testingEmail && !isValidEmail(testingEmail) &&
          <p className="text-xs text-red-500">Please enter a valid email address.</p>
          }
          </div>
        }

        {isLoading ?
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Loading store emails...
          </div> :
        stores.length === 0 ?
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            {isAppOwner(currentUser) || userHasRole(currentUser, 'admin') ?
            'No stores have deliveries on the selected date.' :
            'No stores are assigned to this dispatcher.'}
          </div> :

        <div className="flex-1 overflow-y-auto min-h-0 pr-2 custom-scrollbar pb-2">
          <div className={`grid ${stores.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'} gap-2`}>
            {stores.map((store) =>
            <div
              key={store.id} className="px-3 py-3 rounded-xl border space-y-3 flex flex-col"

              style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>

                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{store.name}</h3>
                    <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>{store.address}</p>
                  </div>
                  {driverNamesByStore[store.id] && driverNamesByStore[store.id].length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap shrink-0">
                      {driverNamesByStore[store.id].map((driverName, idx) => (
                        <React.Fragment key={driverName}>
                          {idx > 0 && <span className="text-slate-400 text-xs">•</span>}
                          <span
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                            style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
                            {driverName}
                          </span>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {(emailDrafts[store.id] || []).length === 0 ?
                <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>No email addresses added yet.</p> :

                (emailDrafts[store.id] || []).map((email) =>
                <div
                  key={email} className="px-3 rounded-lg flex items-center justify-between gap-3 border"

                  style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>

                        <span className="text-sm break-all" style={{ color: 'var(--text-slate-700)' }}>{email}</span>
                        <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeEmail(store.id, email)}>

                          <Trash2 className="w-4 h-4 text-slate-500" />
                        </Button>
                      </div>
                )
                }
                </div>

                <div className="flex flex-col sm:flex-row gap-2 mt-auto">
                  <Input
                  type="email"
                  value={pendingEmails[store.id] || ""}
                  placeholder="Add email address"
                  onChange={(event) =>
                  setPendingEmails((current) => ({
                    ...current,
                    [store.id]: event.target.value
                  }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addEmail(store.id);
                    }
                  }} />

                  <Button type="button" variant="outline" onClick={() => addEmail(store.id)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Add
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
        }

        <DialogFooter className="py-4 flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 gap-2 mt-auto pt-2 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              await saveEmails();
              onOpenChange(false);
            }}
            disabled={isLoading || isSaving || isExporting || testingEmail && !isValidEmail(testingEmail)}>
            
            {isSaving && !isExporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Save
          </Button>
          <Button
            type="button"
            onClick={handleExportRoute}
            disabled={isLoading || isSaving || isExporting || !checkDateCompletion(selectedDate)}>

            {isSaving || isExporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Export Route
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>);

}