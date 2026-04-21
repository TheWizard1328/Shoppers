import React from 'react';
import { format } from 'date-fns';
import { RotateCcw } from 'lucide-react';
import { isAppOwner } from '@/components/utils/userRoles';
import { Checkbox } from '@/components/ui/checkbox';
import ResetPolylinesButton from '@/components/dashboard/ResetPolylinesButton';

export default function CompletedRouteControls({
  currentUser,
  isMobile,
  selectedDriverId,
  selectedDate,
  isRouteComplete,
  showRoutes,
  setShowRoutes,
  showBreadcrumbs,
  setShowBreadcrumbs,
  setBreadcrumbsData,
  appUsers,
  deliveriesWithStopOrder,
}) {
  if (isMobile) return null;
  if (!isAppOwner(currentUser)) return null;
  if (!selectedDriverId || selectedDriverId === 'all') return null;
  if (!isRouteComplete) return null;

  return (
    <div className="absolute top-3 right-3 z-[700] pointer-events-auto">
      <div
        className="rounded-lg border shadow-md overflow-hidden"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
      >
        <div className="flex items-stretch">
          <div className="px-3 py-2 flex flex-col gap-2 min-w-[148px]">
            <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-slate-900)' }}>
              <Checkbox
                checked={showRoutes}
                onCheckedChange={(checked) => {
                  const enabled = checked === true;
                  setShowRoutes(enabled);
                  if (!enabled) {
                    setShowBreadcrumbs(false);
                    setBreadcrumbsData({ historical: [], current: [] });
                  }
                }}
                className="h-4 w-4 min-h-4 min-w-4 rounded-sm"
              />
              <span>Show Polylines</span>
            </label>

            <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-slate-900)' }}>
              <Checkbox
                checked={showBreadcrumbs}
                onCheckedChange={(checked) => {
                  const enabled = checked === true;
                  setShowBreadcrumbs(enabled);
                  if (enabled) {
                    setShowRoutes(false);
                  } else {
                    setBreadcrumbsData({ historical: [], current: [] });
                  }
                }}
                className="h-4 w-4 min-h-4 min-w-4 rounded-sm"
              />
              <span>Show Breadcrumbs</span>
            </label>
          </div>

          <div className="border-l flex items-start justify-center p-2" style={{ borderColor: 'var(--border-slate-200)' }}>
            <ResetPolylinesButton
              selectedDriverIds={[selectedDriverId]}
              selectedDate={format(selectedDate, 'yyyy-MM-dd')}
              selectedPolylineOption={showBreadcrumbs ? 'breadcrumbs' : 'polylines'}
              mode="inline"
              disabled={!deliveriesWithStopOrder?.length}
              className="h-8 w-8 p-0"
            />
          </div>
        </div>
      </div>
    </div>
  );
}