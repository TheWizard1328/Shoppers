import React from 'react';

export default function MobileOverlayBackHandler({ isMobile, isTabletPortrait, isOverlayOpen, onRequestCloseOverlay }) {
  const overlayHistoryActiveRef = React.useRef(false);
  const overlayPopClosingRef = React.useRef(false);

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
      if (!overlayHistoryActiveRef.current && !isOverlayOpen) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();

      if (overlayHistoryActiveRef.current) {
        window.history.back();
      } else {
        closeOverlay();
      }
    };

    window.addEventListener('popstate', handlePopState);
    document.addEventListener('backbutton', handleNativeBack, false);

    const capacitorApp = window.Capacitor?.Plugins?.App;
    if (capacitorApp?.addListener) {
      nativeBackListener = capacitorApp.addListener('backButton', handleNativeBack);
    }

    return () => {
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('backbutton', handleNativeBack, false);
      nativeBackListener?.remove?.();
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
      window.history.back();
      return;
    }

    if (!isOverlayOpen) {
      overlayPopClosingRef.current = false;
    }
  }, [isOverlayOpen, isMobile, isTabletPortrait]);

  return null;
}