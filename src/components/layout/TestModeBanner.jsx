import React, { useEffect, useState } from 'react';
import { X, UserRound } from 'lucide-react';
import { isTestModeActive, getTestModeConfig, exitTestMode } from '@/components/utils/testMode';

/**
 * Persistent banner shown while "Test as Dispatcher" mode is active.
 * Full dispatcher privileges are live — the banner is just a constant
 * reminder of who you're currently acting as, with a one-tap Exit.
 */
export default function TestModeBanner() {
  const [active, setActive] = useState(isTestModeActive());

  useEffect(() => {
    const onChanged = () => setActive(isTestModeActive());
    window.addEventListener('testModeChanged', onChanged);
    return () => window.removeEventListener('testModeChanged', onChanged);
  }, []);

  if (!active) return null;
  const cfg = getTestModeConfig();

  return (
    <div
      className="fixed top-0 left-1/2 -translate-x-1/2 z-[9998] flex items-center gap-2 bg-slate-800 text-white pl-3 pr-1.5 py-1 rounded-b-lg shadow-lg text-xs font-medium max-w-[92vw]"
      role="status"
    >
      <UserRound className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate">
        Acting as Dispatcher{cfg?.mirrored_from ? ` — ${cfg.mirrored_from}` : ''}
      </span>
      <button
        type="button"
        className="flex-shrink-0 ml-1 bg-white/15 hover:bg-white/25 rounded-md px-2 py-0.5 flex items-center gap-1 font-semibold"
        onClick={() => exitTestMode()}
        title="Exit — back to App Owner"
      >
        <X className="w-3 h-3" />
        Exit
      </button>
    </div>
  );
}
