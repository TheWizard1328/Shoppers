import { base44 } from '@/api/base44Client';

let demoModeState = { active: false };
let lastDemoModeCheckAt = 0;
const DEMO_MODE_CHECK_TTL_MS = 5 * 60 * 1000;

export const refreshDemoModeState = async (force = false) => {
  if (!force && lastDemoModeCheckAt && Date.now() - lastDemoModeCheckAt < DEMO_MODE_CHECK_TTL_MS) {
    return demoModeState;
  }

  try {
    const me = await base44.auth.me();
    if (!me) {
      demoModeState = { active: false };
      lastDemoModeCheckAt = Date.now();
      return demoModeState;
    }
    const rows = await base44.entities.DemoSettings.filter({ user_id: me.id });
    demoModeState = { active: rows?.[0]?.is_demo_mode_active === true };
    lastDemoModeCheckAt = Date.now();
    return demoModeState;
  } catch {
    demoModeState = { active: false };
    lastDemoModeCheckAt = Date.now();
    return demoModeState;
  }
};

export const setDemoModeState = (active) => {
  demoModeState = { active: active === true };
  lastDemoModeCheckAt = Date.now();
  return demoModeState;
};

export const getDemoModeState = () => demoModeState;

export const resolveEntityName = async (entityName) => {
  if (!demoModeState.active) return entityName;
  const state = await refreshDemoModeState();
  if (!state.active) return entityName;
  if (entityName === 'Patient') return 'DemoPatient';
  if (entityName === 'Delivery') return 'DemoRoute';
  if (entityName === 'Store') return 'DemoStore';
  if (entityName === 'AppUser') return 'DemoAppUser';
  return entityName;
};