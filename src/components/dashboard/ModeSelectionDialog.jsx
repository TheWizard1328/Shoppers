import React from 'react';
import { useDevice } from '@/components/utils/DeviceContext';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

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
  const { isMobile } = useDevice();

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
      <div className="flex-1 overflow-y-auto divide-y" style={{ borderColor: 'var(--border-slate-200)' }}>
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
              className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors"
            >
              {/* Name */}
              <span className="font-semibold text-sm truncate" style={{ color: 'var(--text-slate-900)', flex: '1 1 0', minWidth: 0 }}>
                {stop.label}
              </span>
              {/* Distance */}
              <span className="text-xs shrink-0 whitespace-nowrap text-center" style={{ color: 'var(--text-slate-500)', width: 52 }}>
                {stop.distanceKm != null ? `${stop.distanceKm.toFixed(1)} km` : '—'}
              </span>
              {/* Status badge */}
              <StatusBadge status={stop.status} />
              {/* Checkbox */}
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

  // Mobile: header ~56px, bottom nav ~60px — panel fits the gap between them
  const MOBILE_TOP = 56;
  const MOBILE_BOTTOM = 60;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: isMobile ? MOBILE_TOP : 0,
        bottom: isMobile ? MOBILE_BOTTOM : 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onOpenChange?.(false); }}
    >
      <div
        style={{
          background: 'var(--bg-white, #fff)',
          width: isMobile ? 'calc(100% - 32px)' : undefined,
          minWidth: isMobile ? undefined : 420,
          maxWidth: isMobile ? '100vw' : 480,
          maxHeight: isMobile ? '100%' : '90vh',
          borderRadius: 16,
          boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {panelContent}
      </div>
    </div>,
    document.body
  );
}