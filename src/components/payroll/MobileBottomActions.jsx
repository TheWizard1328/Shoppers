import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Share2, RefreshCw, ListChecks } from "lucide-react";
import useMobileChromeHeights from "@/components/utils/useMobileChromeHeights";

/**
 * Mobile action bar (Summary / Share / Refresh).
 *
 * OWNER REPORT (Nov 7 2026): on his phone the three buttons were half hidden
 * BEHIND the app's bottom navigation bar. The bar was `fixed bottom-0`, which
 * puts it at the true viewport edge - exactly where the fixed bottom nav lives -
 * so the nav painted over it. It now sits ON TOP OF THE NAV: `bottom` is the
 * measured nav height plus the phone's bottom safe area, the same formula the
 * patient/delivery forms use. The page's scroll area adds matching bottom
 * padding so the last card is not hidden behind this bar either.
 */
export default function MobileBottomActions({ onSummary, onShare, onRefresh, refreshing, capturing, onHeightChange }) {
  const { bottomNav } = useMobileChromeHeights(true);
  const barRef = useRef(null);

  // Sit exactly on the nav's TOP EDGE, measured from the live element.
  // OWNER REPORT (Nov 7 2026, second pass): adding the nav height PLUS the
  // bottom safe area counted the inset twice - the nav already contains it -
  // which left a big empty band between these buttons and the bottom nav.
  // Measuring `innerHeight - navRect.top` is the distance from the viewport
  // bottom to the top of the nav, so no inset can be double-counted.
  const [navOffset, setNavOffset] = useState(null);
  useEffect(() => {
    const read = () => {
      const nav = document.querySelector('[data-mobile-bottom-nav]');
      if (!nav) { setNavOffset(null); return; }
      const r = nav.getBoundingClientRect();
      if (!r || !r.height) { setNavOffset(null); return; }
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      setNavOffset(Math.max(0, Math.round(vh - r.top)));
    };
    read();
    const nav = document.querySelector('[data-mobile-bottom-nav]');
    let ro = null;
    if (nav && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(read);
      ro.observe(nav);
    }
    window.addEventListener('resize', read);
    window.addEventListener('orientationchange', read);
    const vv = window.visualViewport;
    if (vv) vv.addEventListener('resize', read);
    const t = setTimeout(read, 200);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', read);
      window.removeEventListener('orientationchange', read);
      if (vv) vv.removeEventListener('resize', read);
      clearTimeout(t);
    };
  }, []);

  // Report the bar's real rendered height so the page can reserve exactly that
  // much bottom padding. A fixed value was wrong: the bar is visible up to lg
  // (1024px) while the old padding collapsed to 4px from md (768px), so on a
  // wide phone / small tablet the last cards sat behind the buttons.
  const report = () => {
    const h = barRef.current?.offsetHeight || 0;
    if (typeof onHeightChange === 'function') onHeightChange(h);
  };
  useLayoutEffect(() => {
    report();
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bottomNav]);
  useEffect(() => {
    // Re-measure after fonts/dynamic nav metrics settle.
    const t = setTimeout(report, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={barRef}
      className="lg:hidden fixed left-0 right-0 z-20 w-full max-w-full bg-white/95 backdrop-blur border-t border-slate-200 dark:border-slate-700 overflow-hidden"
      style={{
        bottom: navOffset != null
          ? `${navOffset}px`
          : `calc(${bottomNav}px + var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)))`
      }}>
      <div className="w-full max-w-full px-2 py-2 grid grid-cols-3 gap-2">
        <Button size="sm" variant="outline" onClick={onSummary} className="w-full min-w-0 px-2">
          <ListChecks className="h-4 w-4 shrink-0" />
          <span className="ml-1 truncate text-xs sm:text-sm">Summary</span>
        </Button>
        <Button size="sm" variant="outline" onClick={onShare} disabled={capturing} className="w-full min-w-0 px-2">
          {capturing ? <span className="truncate text-xs sm:text-sm">Sharing...</span> : (<><Share2 className="h-4 w-4 shrink-0" /><span className="ml-1 truncate text-xs sm:text-sm">Share</span></>)}
        </Button>
        <Button size="sm" variant="default" onClick={onRefresh} disabled={refreshing} className="w-full min-w-0 px-2">
          <RefreshCw className={`h-4 w-4 shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
          <span className="ml-1 truncate text-xs sm:text-sm">Refresh</span>
        </Button>
      </div>
    </div>
  );
}