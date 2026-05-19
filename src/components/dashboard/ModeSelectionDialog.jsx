import React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { isMobileDevice } from '@/components/utils/deviceUtils';

const STATUS_STYLES = {
  en_route:   { label: 'En Route',   bg: 'bg-blue-500',   text: 'text-white' },
  in_transit: { label: 'In Transit', bg: 'bg-green-600',  text: 'text-white' },
  pending:    { label: 'Pending',    bg: 'bg-amber-300',  text: 'text-amber-900' },
};

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || { label: status, bg: 'bg-slate-200', text: 'text-slate-700' };
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-0.5 text-sm font-semibold ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

export default function ModeSelectionDialog({
  open,
  onOpenChange,
  modeLabel,
  nearbyStops = [],
  selectedStopIds = [],
  onToggleStop,
  returnToCurrentLocation,
  onToggleReturn,
  onOptimize,
  isSubmitting = false,
}) {
  const isMobile = isMobileDevice();

  if (!open) return null;

  const panelContent = (
    <>
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-200" style={{ borderColor: 'var(--border-slate-200)' }}>
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
          Select Stops for Cycling Mode
        </h2>
      </div>

      {/* Stop list */}
      <div className="max-h-[55vh] overflow-y-auto divide-y" style={{ borderColor: 'var(--border-slate-200)' }}>
        {nearbyStops.length === 0 && (
          <div className="px-6 py-8 text-sm text-center" style={{ color: 'var(--text-slate-500)' }}>
            No stops found on this route.
          </div>
        )}

        {nearbyStops.map((stop) => {
          const checked = selectedStopIds.includes(stop.id);
          return (
            <label
              key={stop.id}
              className="flex items-center gap-4 px-6 py-4 cursor-pointer hover:bg-slate-50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-bold" style={{ color: 'var(--text-slate-900)' }}>{stop.label}</span>
                  <StatusBadge status={stop.status} />
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-sm" style={{ color: 'var(--text-slate-500)' }}>
                    {stop.distanceKm != null ? `${stop.distanceKm.toFixed(1)} km away` : 'Distance unknown'}
                  </span>
                </div>
              </div>
              <Checkbox
                checked={checked}
                onCheckedChange={() => onToggleStop(stop.id)}
                className="h-5 w-5 shrink-0 rounded-md border-2 border-slate-300 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
              />
            </label>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex gap-3 px-6 py-4 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <Button
          variant="outline"
          onClick={() => onOpenChange?.(false)}
          disabled={isSubmitting}
          className="flex-1 h-12 rounded-xl text-base font-bold border-2"
        >
          Cancel
        </Button>
        <Button
          onClick={onOptimize}
          disabled={isSubmitting || selectedStopIds.length === 0}
          className="flex-1 h-12 rounded-xl text-base font-bold bg-blue-600 hover:bg-blue-700 text-white border-0"
        >
          {isSubmitting ? 'Processing…' : 'Continue'}
        </Button>
      </div>
    </>
  );

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: isMobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onOpenChange?.(false); }}
    >
      <div
        style={{
          background: 'var(--bg-white, #fff)',
          width: isMobile ? '100%' : undefined,
          minWidth: isMobile ? undefined : 420,
          maxWidth: isMobile ? '100vw' : 480,
          borderRadius: isMobile ? '16px 16px 0 0' : 16,
          boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {panelContent}
      </div>
    </div>,
    document.body
  );
}