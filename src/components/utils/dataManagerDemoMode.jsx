import { base44 } from '@/api/base44Client';

/**
 * Demo-mode resolver for getData().
 *
 * CACHED (owner report Nov 15 2026): every getData() call re-resolved the demo
 * entity name, so a boot fired several `DemoSettings · GET` reads — the
 * DemoSettings entries in the RATE LIMIT tooltip. The answer is per-user and
 * only changes when someone flips the demo toggle, so it is cached for five
 * minutes (kept in sessionStorage so a soft reload does not re-read it) and
 * invalidated whenever the app announces `demoModeChanged`.
 */
const CACHE_KEY = 'rxdeliver_demo_mode_state';
const CACHE_MS = 5 * 60 * 1000;

let demoModeState = { active: false };
let inflight = null;

const readCached = () => {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Number.isFinite(parsed.ts) || Date.now() - parsed.ts > CACHE_MS) return null;
    return { active: parsed.active === true };
  } catch {
    return null;
  }
};

export const invalidateDemoModeState = () => {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* storage blocked */ }
  inflight = null;
};

export const refreshDemoModeState = async () => {
  const cached = readCached();
  if (cached) {
    demoModeState = cached;
    return demoModeState;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const me = await base44.auth.me();
      if (!me) {
        demoModeState = { active: false };
        return demoModeState;
      }
      const rows = await base44.entities.DemoSettings.filter({ user_id: me.id });
      demoModeState = { active: rows?.[0]?.is_demo_mode_active === true };
      return demoModeState;
    } catch {
      demoModeState = { active: false };
      return demoModeState;
    } finally {
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ active: demoModeState.active === true, ts: Date.now() }));
      } catch { /* storage blocked */ }
      inflight = null;
    }
  })();

  return inflight;
};

export const resolveEntityName = async (entityName) => {
  const state = await refreshDemoModeState();
  if (!state.active) return entityName;
  if (entityName === 'Patient') return 'DemoPatient';
  if (entityName === 'Delivery') return 'DemoRoute';
  if (entityName === 'Store') return 'DemoStore';
  if (entityName === 'AppUser') return 'DemoAppUser';
  return entityName;
};

// The demo toggle announces its change — drop the cache so the next read is true.
if (typeof window !== 'undefined' && !window.__demoModeInvalidateRegistered) {
  window.__demoModeInvalidateRegistered = true;
  window.addEventListener('demoModeChanged', invalidateDemoModeState);
}