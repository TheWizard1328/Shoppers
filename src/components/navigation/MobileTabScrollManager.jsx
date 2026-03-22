import React from 'react';
import { useLocation } from 'react-router-dom';
import { useMobileNavigation } from './MobileNavigationProvider';

const getScrollContainer = () => document.querySelector('main') || document.querySelector('[data-page-content]');

export default function MobileTabScrollManager() {
  const location = useLocation();
  const currentPath = `${location.pathname.toLowerCase()}${location.search}`;
  const { saveScrollPosition, getScrollPosition } = useMobileNavigation();

  React.useEffect(() => {
    const scrollContainer = getScrollContainer();
    if (!scrollContainer) return undefined;

    let frameId = null;
    let restoreFrameId = null;

    const persistScrollPosition = () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }

      frameId = requestAnimationFrame(() => {
        saveScrollPosition(currentPath, scrollContainer.scrollTop);
      });
    };

    const restoreScrollPosition = () => {
      restoreFrameId = requestAnimationFrame(() => {
        scrollContainer.scrollTop = getScrollPosition(currentPath);
      });
    };

    restoreScrollPosition();
    scrollContainer.addEventListener('scroll', persistScrollPosition, { passive: true });

    return () => {
      saveScrollPosition(currentPath, scrollContainer.scrollTop);
      scrollContainer.removeEventListener('scroll', persistScrollPosition);
      if (frameId) cancelAnimationFrame(frameId);
      if (restoreFrameId) cancelAnimationFrame(restoreFrameId);
    };
  }, [currentPath, getScrollPosition, saveScrollPosition]);

  return null;
}