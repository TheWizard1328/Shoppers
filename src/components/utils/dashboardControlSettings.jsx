import { saveSettings } from './userSettingsManager';

export function persistDashboardControlSettings(currentUserId, updates = {}) {
  if (!currentUserId || !updates || Object.keys(updates).length === 0) return;
  saveSettings(currentUserId, updates);
}