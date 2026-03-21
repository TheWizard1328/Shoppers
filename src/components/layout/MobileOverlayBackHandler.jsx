import React from 'react';

export default function MobileOverlayBackHandler({ isMobile, isTabletPortrait, isFormOverlayOpen }) {
  const overlayHistoryActiveRef = React.useRef(false);
  const overlayPopClosingRef = React.useRef(false);

  React.useEffect(() => {
    if (!isMobile && !isTabletPortrait) return;

    const handlePopState = () => {
      if (!overlayHistoryActiveRef.current) return;
      overlayPopClosingRef.current = true;
      overlayHistoryActiveRef.current = false;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isMobile, isTabletPortrait]);

  React.useEffect(() => {
    if (!isMobile && !isTabletPortrait) return;

    if (isFormOverlayOpen && !overlayHistoryActiveRef.current) {
      window.history.pushState({ ...(window.history.state || {}), overlayOpen: true }, '', window.location.href);
      overlayHistoryActiveRef.current = true;
      return;
    }

    if (!isFormOverlayOpen && overlayHistoryActiveRef.current && !overlayPopClosingRef.current) {
      overlayHistoryActiveRef.current = false;
      window.history.back();
      return;
    }

    if (!isFormOverlayOpen) {
      overlayPopClosingRef.current = false;
    }
  }, [isFormOverlayOpen, isMobile, isTabletPortrait]);

  return null;
}