import React from 'react';

export default function MobileOverlayBackHandler({ isMobile, isTabletPortrait, isOverlayOpen, onRequestCloseOverlay }) {
  const overlayHistoryActiveRef = React.useRef(false);
  const overlayPopClosingRef = React.useRef(false);
  const suppressCloseBackRef = React.useRef(false);

  React.useEffect(() => {
    if (!isMobile && !isTabletPortrait) return;

    let nativeBackListener = null;

    const closeOverlay = () => {
      onRequestCloseOverlay?.();
    };

    const handlePopState = () => {
      if (!overlayHistoryActiveRef.current) return;
      overlayPopClosingRef.current = true;
      overlayHistoryActiveRef.current = false;
      closeOverlay();
    };

    const handleNativeBack = (event) => {
      const canGoBack = (window.history.state?.idx ?? 0) > 0;

      if (isOverlayOpen || overlayHistoryActiveRef.current) {
        event?.preventDefault?.();
        event?.stopPropagation?.();

        if (overlayHistoryActiveRef.current) {
          window.history.back();
        } else {
          closeOverlay();
        }
        return;
      }

      if (canGoBack) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        window.history.back();
      }
    };

    const handleOverlayNavigateClose = () => {
      suppressCloseBackRef.current = true;
    };

    window.addEventListener('popstate', handlePopState);
    document.addEventListener('backbutton', handleNativeBack, false);
    window.addEventListener('overlayNavigateClose', handleOverlayNavigateClose);

    const capacitorApp = window.Capacitor?.Plugins?.App || window.Capacitor?.App;
    if (window.Capacitor?.isNativePlatform?.() && capacitorApp?.addListener) {
      const listenerResult = capacitorApp.addListener('backButton', handleNativeBack);
      Promise.resolve(listenerResult).then((listener) => {
        nativeBackListener = listener;
      }).catch(() => {
        nativeBackListener = null;
      });
    }

    return () => {
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('backbutton', handleNativeBack, false);
      window.removeEventListener('overlayNavigateClose', handleOverlayNavigateClose);
      if (nativeBackListener && typeof nativeBackListener.remove === 'function') {
        nativeBackListener.remove();
      }
    };
  }, [isMobile, isTabletPortrait, isOverlayOpen, onRequestCloseOverlay]);

  React.useEffect(() => {
    if (!isMobile && !isTabletPortrait) return;

    if (isOverlayOpen && !overlayHistoryActiveRef.current) {
      window.history.pushState({ ...(window.history.state || {}), overlayOpen: true }, '', window.location.href);
      overlayHistoryActiveRef.current = true;
      return;
    }

    if (!isOverlayOpen && overlayHistoryActiveRef.current && !overlayPopClosingRef.current) {
      overlayHistoryActiveRef.current = false;
      if (suppressCloseBackRef.current) {
        suppressCloseBackRef.current = false;
        return;
      }
      window.history.back();
      return;
    }

    if (!isOverlayOpen) {
      overlayPopClosingRef.current = false;
      suppressCloseBackRef.current = false;
    }
  }, [isOverlayOpen, isMobile, isTabletPortrait]);

  return null;
}