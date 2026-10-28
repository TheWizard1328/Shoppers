import React, { useEffect, useState } from 'react';
import { Loader2, MapPin, Activity, History, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PatientGPSUpdatesDialog from './PatientGPSUpdatesDialog';
import { useAppData } from '@/components/utils/AppDataContext';
import { useDevice } from '@/components/utils/DeviceContext';
import { Link } from 'react-router-dom';
import {
  startPatientHistoryBackfill,
  cancelPatientHistoryBackfill,
  subscribePatientHistoryBackfillRun,
} from '@/components/utils/patientHistoryBackfillRunner';

export default function AdminPatientsTab({ dataViewMode, setDataViewMode, children, onBackfillLastDeliveryDates, isBackfilling: externalBackfillLoading = false, stores: storesProp }) {
  const { stores: contextStores } = useAppData();
  const { isMobile } = useDevice();
  const stores = storesProp || contextStores || [];
  const [showPatientGpsUpdates, setShowPatientGpsUpdates] = useState(false);

  // Live progress for the store-by-store patient history backfill (owner spec
  // Oct 27 2026): rendered in the "dead space" left of the action buttons.
  const [historyRun, setHistoryRun] = useState(null);
  const [historyBannerDismissed, setHistoryBannerDismissed] = useState(false);
  useEffect(() => {
    const unsub = subscribePatientHistoryBackfillRun(setHistoryRun);
    return unsub;
  }, []);
  const historyRunActive = historyRun?.status === 'running';
  useEffect(() => { if (historyRunActive) setHistoryBannerDismissed(false); }, [historyRunActive]);

  const handleStartHistoryBackfill = () => {
    // Fire-and-forget: progress arrives via subscribePatientHistoryBackfillRun.
    startPatientHistoryBackfill(stores).catch((e) => console.warn('[PatientsTab] history backfill failed to start:', e?.message || e));
  };

  // Mobile-only layout (Sep 14 2026 fix): the whole tab becomes a flex column
  // capped at the height the page hands the "patients" TabsContent
  // (calc(100vh - 220px), set in AdminUtilities.jsx). This block of top
  // buttons stays a non-shrinking header; the children wrapper below flexes
  // to fill the remaining space so ONLY the table body scrolls — no more
  // double page-scroll pushing the table off the bottom of the screen with
  // dead white space beneath it. Desktop is untouched (original flex row).
  //
  // NOTE: flex-1 (flex-basis:0%) on a flex-wrap row lets 5 buttons squeeze
  // onto one line instead of wrapping (each item's hypothetical size is 0,
  // so the flexbox wrap algorithm never triggers a break) — that's what was
  // truncating the button labels on mobile. Grid with explicit columns fixes
  // it outright, independent of content width.
  const buttonRowClass = isMobile
    ? 'mb-4 grid grid-cols-2 gap-2 shrink-0'
    : 'mb-4 flex flex-wrap justify-end gap-2';
  const buttonClass = isMobile ? 'min-h-10 w-full' : 'min-h-10';

  // Progress banner (owner spec Oct 27 2026): sits in the empty space left of
  // the action buttons (below the tab bar, above the Patients content panel).
  // Shows live per-store progress while running, then a done summary that
  // auto-dismisses on the next run (or via the X).
  const historyBanner = historyRun && !historyBannerDismissed &&
    (historyRunActive || historyRun.status === 'done' || historyRun.status === 'cancelled' || historyRun.status === 'error') ? (() => {
      const storePct = historyRun.storeCount > 0 ? Math.round((historyRun.storeIndex / historyRun.storeCount) * 100) : 0;
      const isDone = !historyRunActive;
      const tone = historyRun.status === 'error'
        ? 'border-red-500/40 bg-red-500/10'
        : historyRun.status === 'cancelled'
          ? 'border-amber-500/40 bg-amber-500/10'
          : isDone
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : 'border-sky-500/40 bg-sky-500/10';
      return (
        <div className={`flex items-center gap-2 rounded-lg border ${tone} px-3 py-1.5 text-xs text-slate-200 min-w-0`}>
          {historyRunActive
            ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400" />
            : isDone
              ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              : <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap leading-tight">
              <span className="font-semibold whitespace-nowrap">
                {historyRunActive
                  ? `History backfill — store ${historyRun.storeIndex}/${historyRun.storeCount}${historyRun.currentStoreName ? ` (${historyRun.currentStoreName})` : ''}`
                  : historyRun.status === 'cancelled' ? 'History backfill — cancelled' : 'History backfill — done'}
              </span>
              <span className="text-slate-400 tabular-nums whitespace-nowrap">
                {historyRun.processedPatients} processed · {historyRun.changedPatients} changed · {historyRun.uploaded} uploaded
                {historyRun.uploadFailed > 0 ? ` · ${historyRun.uploadFailed} failed` : ''}
                {historyRunActive && historyRun.uploadPending > 0 ? ` · ${historyRun.uploadPending} uploading` : ''}
              </span>
            </div>
            {historyRunActive && (
              <div className="mt-1 h-1 w-full max-w-md overflow-hidden rounded-full bg-slate-700/60">
                <div className="h-full rounded-full bg-sky-400 transition-all duration-500" style={{ width: `${Math.max(3, storePct)}%` }} />
              </div>
            )}
            {!historyRunActive && historyRun.message && (
              <div className="text-slate-400 truncate">{historyRun.message}</div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0 text-slate-400 hover:text-slate-100"
            onClick={() => (historyRunActive ? cancelPatientHistoryBackfill() : setHistoryBannerDismissed(true))}
            title={historyRunActive ? 'Cancel backfill' : 'Dismiss'}
          >
            {historyRunActive ? <X className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          </Button>
        </div>
      );
    })() : null;

  const buttons = (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowPatientGpsUpdates(true)}
        className={buttonClass}
      >
        <MapPin className="mr-2 h-4 w-4" />
        GPS Updates
      </Button>
      <Button
        variant="outline"
        size="sm"
        asChild
        className={buttonClass}
      >
        <Link to="/PatientActivityReview">
          <Activity className="mr-2 h-4 w-4" />
          Activity Review
        </Link>
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={handleStartHistoryBackfill}
        disabled={historyRunActive}
        className={buttonClass}
        title="Rebuild every patient's delivery history AND last delivery date store by store — IDB-first, only changed patients are uploaded (replaces the old 90-day last-delivery backfill)"
      >
        {historyRunActive ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <History className="mr-2 h-4 w-4" />}
        Backfill History & Last Delivery
      </Button>
      <div className={`flex gap-1 ${buttonClass}`}>
        <Button
          variant={dataViewMode.patients === 'offline' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDataViewMode((prev) => ({ ...prev, patients: 'offline' }))}
          className="flex-1 min-h-10 px-2"
        >
          Offline
        </Button>
        <Button
          variant={dataViewMode.patients !== 'offline' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDataViewMode((prev) => ({ ...prev, patients: 'online' }))}
          className="flex-1 min-h-10 px-2"
        >
          Online
        </Button>
      </div>
    </>
  );

  if (!isMobile) {
    return (
      <>
        <div className="mb-4 flex items-center gap-3">
          <div className="min-w-0 flex-1">{historyBanner}</div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">{buttons}</div>
        </div>
        {children}
        <PatientGPSUpdatesDialog
          open={showPatientGpsUpdates}
          onOpenChange={setShowPatientGpsUpdates}
          stores={stores}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {historyBanner && <div className="mb-2 shrink-0">{historyBanner}</div>}
      <div className={buttonRowClass}>{buttons}</div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {children}
      </div>

      <PatientGPSUpdatesDialog
        open={showPatientGpsUpdates}
        onOpenChange={setShowPatientGpsUpdates}
        stores={stores}
      />
    </div>
  );
}
