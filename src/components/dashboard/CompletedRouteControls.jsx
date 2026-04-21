import React from 'react';
import { format } from 'date-fns';
import { isAppOwner } from '@/components/utils/userRoles';
import BreadcrumbToggleButton from '@/components/dashboard/BreadcrumbToggleButton';
import ResetPolylinesButton from '@/components/dashboard/ResetPolylinesButton';
import { Button } from '@/components/ui/button';

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
        className="rounded-xl border shadow-lg backdrop-blur-sm p-2 flex items-center gap-2"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setShowRoutes(!showRoutes);
            if (showRoutes) {
              setShowBreadcrumbs(false);
              setBreadcrumbsData({ historical: [], current: [] });
            }
          }}
          className={`h-8 ${showRoutes ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
          style={!showRoutes ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
        >
          Polylines
        </Button>

        <BreadcrumbToggleButton
          isMobile={false}
          isDriver={false}
          isRouteComplete={isRouteComplete}
          showBreadcrumbs={showBreadcrumbs}
          setShowBreadcrumbs={setShowBreadcrumbs}
          setShowRoutes={setShowRoutes}
          setBreadcrumbsData={setBreadcrumbsData}
          selectedDate={selectedDate}
          showAllDriverMarkers={false}
          selectedDriverId={selectedDriverId}
          currentUser={currentUser}
          appUsers={appUsers}
        />

        <ResetPolylinesButton
          selectedDriverIds={[selectedDriverId]}
          selectedDate={format(selectedDate, 'yyyy-MM-dd')}
          selectedPolylineOption={showBreadcrumbs ? 'breadcrumbs' : 'polylines'}
          mode="inline"
          disabled={!deliveriesWithStopOrder?.length}
        />
      </div>
    </div>
  );
}