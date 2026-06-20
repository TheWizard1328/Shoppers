import { getUserAgentInfo } from '@/components/utils/deviceUtils';

const getDeviceType = () => {
  try { return getUserAgentInfo().deviceType; } catch (_) { return 'Desktop'; }
};

// Mobile/Tablet: 90 days. Desktop: full year from Jan 1 of current year (~6 months avg).
const isMobileOrTablet = () => { const t = getDeviceType(); return t === 'Mobile' || t === 'Tablet'; };

export const offlineSyncConfig = {
  PATIENT_BATCH_SIZE: 25,
  PATIENT_SYNC_COOLDOWN: 30000,
  BATCH_COOLDOWN: 10000,
  // Mobile/Tablet = 90 days; Desktop = days since Jan 1 of current year
  get DELIVERY_DATE_RANGE_DAYS() {
    if (isMobileOrTablet()) return 90;
    const now = new Date();
    const jan1 = new Date(now.getFullYear(), 0, 1);
    return Math.ceil((now - jan1) / (1000 * 60 * 60 * 24)) + 30; // +30 buffer for future dates
  },
  PATIENT_SYNC_INTERVAL_HOURS: 168,
  BACKGROUND_SYNC_MIN_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes — allows faster historical delivery catch-up
  HISTORICAL_SYNC_COOLDOWN_MS: 1500,
  HISTORICAL_PATIENT_STORE_BATCH_SIZE: 100,
  IS_MOBILE_OR_TABLET: isMobileOrTablet,
};