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
import { Loader2, Plus, Trash2 } from "lucide-react";

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const normalizeEmail = (value) => value.trim().toLowerCase();

export default function ExportRouteEmailDialog({
  open,
  onOpenChange,
  storeIds = [],
  isExporting = false,
  onExportRoute
}) {
  const [stores, setStores] = useState([]);
  const [emailDrafts, setEmailDrafts] = useState({});
  const [pendingEmails, setPendingEmails] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const storeIdsKey = useMemo(() => storeIds.join(","), [storeIds]);

  useEffect(() => {
    if (!open) return;

    let isActive = true;
    setIsLoading(true);

    base44.entities.Store.list().then((allStores) => {
      if (!isActive) return;

      const selectedStores = (allStores || []).filter((store) => storeIds.includes(store.id));
      const drafts = {};
      selectedStores.forEach((store) => {
        drafts[store.id] = Array.isArray(store.route_export_emails) ? store.route_export_emails : [];
      });

      setStores(selectedStores);
      setEmailDrafts(drafts);
      setPendingEmails({});
      setIsLoading(false);
    });

    return () => {
      isActive = false;
    };
  }, [open, storeIds, storeIdsKey]);

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
    await Promise.all(
      stores.map((store) =>
      base44.entities.Store.update(store.id, {
        route_export_emails: emailDrafts[store.id] || []
      })
      )
    );
    setIsSaving(false);
  };

  const handleExportRoute = async () => {
    await saveEmails();
    const perStoreEmails = stores.reduce((acc, store) => {
      acc[store.id] = emailDrafts[store.id] || [];
      return acc;
    }, {});
    const recipientEmails = [...new Set(stores.flatMap((store) => emailDrafts[store.id] || []))];
    onOpenChange(false);
    await onExportRoute({ recipientEmails, perStoreEmails });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background px-3 py-3 fixed left-[50%] top-[50%] z-[10001] grid w-full translate-x-[-50%] translate-y-[-50%] gap-4 border shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg max-w-[350px] max-h-[85vh] overflow-y-auto"

      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>

        <DialogHeader>
          <DialogTitle>Route export emails</DialogTitle>
          <DialogDescription>
            Review, add, or remove store email addresses before exporting the route log by email.
          </DialogDescription>
        </DialogHeader>

        {isLoading ?
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Loading store emails...
          </div> :
        stores.length === 0 ?
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No stores are assigned to this dispatcher.
          </div> :

        <div className="space-y-4">
            {stores.map((store) =>
          <div
            key={store.id} className="px-2 py-2 rounded-xl border space-y-1"

            style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>

                <div>
                  <h3 className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{store.name}</h3>
                  <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>{store.address}</p>
                </div>

                <div className="space-y-2">
                  {(emailDrafts[store.id] || []).length === 0 ?
              <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>No email addresses added yet.</p> :

              (emailDrafts[store.id] || []).map((email) =>
              <div
                key={email}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
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

                <div className="flex flex-col sm:flex-row gap-2">
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
        }

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            type="button"
            onClick={handleExportRoute}
            disabled={
            isLoading ||
            isSaving ||
            isExporting ||
            stores.length === 0 ||
            !stores.some((store) => (emailDrafts[store.id] || []).length > 0)
            }>

            {isSaving || isExporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Export Route
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>);

}