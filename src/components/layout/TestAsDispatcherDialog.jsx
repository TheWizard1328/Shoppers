import React, { useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FlaskConical, DoorOpen, UserRound } from 'lucide-react';
import { isTestModeActive, getTestModeConfig, activateTestMode, exitTestMode } from '@/components/utils/testMode';
import { getUserAvatarGradient } from '@/components/layout/sidebarUserUtils';
import { formatPhoneNumber } from '@/components/utils/phoneFormatter';

/**
 * App Owner "Test as Dispatcher" dialog (Sep 15, 2026).
 * Opened by tapping the avatar / name in the sidebar footer.
 * Simulates a dispatcher view on ANY device — APK, browser PWA, desktop —
 * with a hard write guard so test clicks can't change real data.
 */
export default function TestAsDispatcherDialog({ open, onOpenChange, appUsers, stores }) {
  const active = isTestModeActive();
  const cfg = active ? getTestModeConfig() : null;

  const storeNameById = useMemo(() => {
    const m = new Map();
    (stores || []).forEach((s) => { if (s?.id) m.set(s.id, s.name || s.id); });
    return m;
  }, [stores]);

  // Store sort_order lookup — same field used everywhere else in the app to
  // order stores (dashboard filters, stats cards, etc.)
  const storeSortOrderById = useMemo(() => {
    const m = new Map();
    (stores || []).forEach((s) => { if (s?.id) m.set(s.id, typeof s.sort_order === 'number' ? s.sort_order : Infinity); });
    return m;
  }, [stores]);

  // Active dispatchers (no admin hybrids) to mirror store/city assignments
  // from — ordered by their FIRST assigned store's sort_order (matching the
  // store order used elsewhere in the app), then alphabetically as a
  // tiebreak / fallback for dispatchers with no store assigned.
  const dispatchers = useMemo(() => {
    return (appUsers || [])
      .filter((u) => u && Array.isArray(u.app_roles)
        && u.app_roles.includes('dispatcher')
        && !u.app_roles.includes('admin')
        && u.status !== 'inactive'
        && u.user_name)
      .sort((a, b) => {
        const aOrder = storeSortOrderById.get(a.store_ids?.[0]) ?? Infinity;
        const bOrder = storeSortOrderById.get(b.store_ids?.[0]) ?? Infinity;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return (a.user_name || '').localeCompare(b.user_name || '');
      });
  }, [appUsers, storeSortOrderById]);

  const mirrorFrom = (au) => activateTestMode({
    store_ids: Array.isArray(au?.store_ids) ? au.store_ids : [],
    city_ids: Array.isArray(au?.city_ids) ? au.city_ids : (au?.city_id ? [au.city_id] : []),
    mirrored_from: au?.user_name || null,
  });

  const activateGeneric = () => activateTestMode({ store_ids: [], city_ids: [], mirrored_from: null });

  const storeLabel = (au) => {
    const ids = Array.isArray(au?.store_ids) ? au.store_ids : [];
    if (!ids.length) return 'No stores assigned';
    const first = storeNameById.get(ids[0]) || 'Store';
    return ids.length === 1 ? first : `${first} +${ids.length - 1} more`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-red-600" />
            Test as Dispatcher
          </DialogTitle>
          <DialogDescription>
            {active
              ? `You're currently acting as a dispatcher${cfg?.mirrored_from ? ` (mirroring ${cfg.mirrored_from})` : ''}. You have full dispatcher privileges and every action you take is real. Exit to return to App Owner.`
              : 'Switch to a real dispatcher\u2019s role on this device \u2014 same privileges, same store and city assignments. Everything you do acts exactly as that dispatcher would. Exit anytime.'}
          </DialogDescription>
        </DialogHeader>

        {active ? (
          <div className="py-2 space-y-3">
            <div className="rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800 p-3 text-sm">
              <p className="font-semibold">ACTING AS DISPATCHER</p>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                {cfg?.mirrored_from ? `Mirroring store/city assignments from ${cfg.mirrored_from}.` : 'Generic dispatcher (no store filter).'}
                {' '}Full dispatcher privileges are live. Auto-expires after 2 hours.
              </p>
            </div>
            <Button
              type="button"
              className="w-full bg-slate-800 hover:bg-slate-900 text-white h-11"
              onClick={() => { onOpenChange(false); exitTestMode(); }}
            >
              <DoorOpen className="w-4 h-4 mr-2" />
              Exit — Back to App Owner
            </Button>
          </div>
        ) : (
          <div className="py-2 space-y-2">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Mirror a dispatcher's store & city assignments</p>
            {dispatchers.length === 0 && (
              <p className="text-sm text-slate-500">No active dispatcher accounts found.</p>
            )}
            {dispatchers.map((au) => (
              <button
                key={au.id || au.user_id}
                type="button"
                className="w-full flex items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-700 p-2.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                onClick={() => mirrorFrom(au)}
              >
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: getUserAvatarGradient(au) }}>
                  <span className="text-white font-bold text-sm">{(au.user_name || 'D')?.charAt(0)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{au.user_name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {storeLabel(au)}{au.phone ? ` · ${formatPhoneNumber(au.phone)}` : ''}
                  </p>
                </div>
                <UserRound className="w-4 h-4 text-slate-400 flex-shrink-0" />
              </button>
            ))}

            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide pt-2">Or</p>
            <button
              type="button"
              className="w-full flex items-center gap-3 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 p-2.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              onClick={activateGeneric}
            >
              <div className="w-9 h-9 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                <UserRound className="w-4 h-4 text-slate-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">Generic dispatcher</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">No store filter — sees everything a dispatcher with no assigned stores sees</p>
              </div>
            </button>

            <p className="text-[11px] text-slate-400 dark:text-slate-500 pt-1">
              Note: you keep your own sign-in — actions run under your account with dispatcher privileges. Auto-expires after 2 hours.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
