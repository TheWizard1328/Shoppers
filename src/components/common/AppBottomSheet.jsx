import React from 'react';
import { createPortal } from 'react-dom';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { useChrome } from '@/components/utils/appChrome';

/**
 * AppBottomSheet — the ONE slide-up panel for the app.
 *
 * Owner decisions baked in (Nov 20 2026):
 *  - The panel slides up from the bottom and floats ABOVE the bottom nav, never
 *    underneath it (same behaviour as Bulk Edit Stops).
 *  - The fade behind it covers only the app's real vertical band, i.e. from the
 *    bottom of the mobile header to the top of the bottom nav. The primitive's
 *    own `fixed inset-0` overlay is suppressed (`hideOverlay`) because it dimmed
 *    the header and the nav icons.
 *  - The backdrop is gated on `open` AND portalled to body: vaul keeps its root
 *    mounted, so a bare fixed div left a permanent grey sheet over the dashboard.
 *  - No dead strip above the buttons: `pb-0` cancels the primitive's baked-in
 *    safe-area bottom padding, because `bottom` already lifts the whole panel
 *    past the nav and the inset.
 *
 * Geometry comes from useChrome()/readBand() — never hardcode nav height or
 * safe-area numbers here.
 */
export default function AppBottomSheet({
  open,
  onOpenChange,
  children,
  className = '',
  style,
  zIndex = 11000,
  showHandle = false,
}) {
  const chrome = useChrome();
  const band = chrome.band;

  const overlayStyle = band
    ? { top: band.top, bottom: Math.max(0, chrome.viewportH - band.bottom), left: 0, right: 0 }
    : {
        top: 'var(--app-inset-top)',
        bottom: 'calc(var(--actual-bottom-nav-height, 0px) + var(--app-inset-bottom))',
        left: 0,
        right: 0,
      };

  const panelStyle = {
    bottom: band
      ? Math.max(0, chrome.viewportH - band.bottom)
      : 'calc(var(--actual-bottom-nav-height, 0px) + var(--app-inset-bottom))',
    // Never taller than the band, so the body scrolls inside the panel instead
    // of running past the header or the nav.
    maxHeight: band ? Math.max(240, band.height - 12) : undefined,
    ...style,
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      {open && createPortal(
        <div
          className="fixed bg-black/70"
          style={{ ...overlayStyle, zIndex }}
          onClick={() => onOpenChange?.(false)}
        />,
        document.body
      )}
      <DrawerContent
        hideOverlay
        hideHandle={!showHandle}
        data-lifted-sheet="true"
        className={`pb-0 bg-surface ${className}`}
        style={{ ...panelStyle, zIndex: zIndex + 1 }}
      >
        {children}
      </DrawerContent>
    </Drawer>
  );
}
