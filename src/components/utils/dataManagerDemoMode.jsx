import { base44 } from '@/api/base44Client';

let demoModeState = { active: false };

export const refreshDemoModeState = async () => {
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
  }
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