import React, { useEffect, useRef, useState } from 'react';
import { X, FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { isTestModeActive, getTestModeConfig, exitTestMode } from '@/components/utils/testMode';

/**
 * Persistent red banner shown while Test Mode ("Test as Dispatcher") is
 * active. Counts blocked write attempts and lets the owner exit from
 * any screen. Fixed top-center, above page content, below modals.
 */
export default function TestModeBanner() {
  const [active, setActive] = useState(isTestModeActive());
  const [blockedCount, setBlockedCount] = useState(0);
  const lastToastRef = useRef(0);

  useEffect(() => {
    const onChanged = () => setActive(isTestModeActive());
    const onBlocked = (e) => {
      setBlockedCount((c) => c + 1);
      const now = Date.now();
      if (now - lastToastRef.current > 3000) {
        lastToastRef.current = now;
        const name = e?.detail?.name || 'a write';
        toast(`Blocked — Test Mode is active`, {
          description: `${name} was NOT saved.`,
          duration: 4000,
        });
      }
    };
    window.addEventListener('testModeChanged', onChanged);
    window.addEventListener('testModeWriteBlocked', onBlocked);
    return () => {
      window.removeEventListener('testModeChanged', onChanged);
      window.removeEventListener('testModeWriteBlocked', onBlocked);
    };
  }, []);

  if (!active) return null;
  const cfg = getTestModeConfig();

  return (
    <div
      className="fixed top-0 left-1/2 -translate-x-1/2 z-[9998] flex items-center gap-2 bg-red-600 text-white pl-3 pr-1.5 py-1 rounded-b-lg shadow-lg text-xs font-medium max-w-[92vw]"
      role="alert"
    >
      <FlaskConical className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate">
        TEST MODE — Dispatcher{cfg?.mirrored_from ? ` (${cfg.mirrored_from})` : ''}
        {blockedCount > 0 ? ` · ${blockedCount} write${blockedCount === 1 ? '' : 's'} blocked` : ''}
      </span>
      <button
        type="button"
        className="flex-shrink-0 ml-1 bg-white/15 hover:bg-white/25 rounded-md px-2 py-0.5 flex items-center gap-1 font-semibold"
        onClick={() => exitTestMode()}
        title="Exit Test Mode"
      >
        <X className="w-3 h-3" />
        Exit
      </button>
    </div>
  );
}
