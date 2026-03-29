export const APP_UPDATE_TRIGGER_PHRASE = 'Your app has just been updated.';
export const SYSTEM_UPDATES_SENDER_ID = 'system_updates';
export const SYSTEM_UPDATES_SENDER_NAME = 'System Updates';
const HIDDEN_SYSTEM_BROADCAST_IDS_KEY = 'hiddenSystemBroadcastMessageIds';
const ACKED_SYSTEM_BROADCAST_IDS_KEY = 'ackedSystemBroadcastMessageIds';

export const APP_UPDATE_BROADCAST_MESSAGE = `${APP_UPDATE_TRIGGER_PHRASE} Please click the update button to complete the update. Will restart your app and apply the update. Otherwise your app will update automatically the next time you restart.`;

export const UPDATE_BROADCAST_PROMPT_POSITION = {
  mobile: 'top-stats-card',
  desktop: 'center'
};

export const UPDATE_BROADCAST_PROMPT_THEME = {
  surface: 'var(--bg-white)',
  surfaceElevated: 'var(--bg-slate-50)',
  border: 'var(--border-slate-200)',
  title: 'var(--text-slate-900)',
  body: 'var(--text-slate-600)',
  meta: 'var(--text-slate-500)'
};

export const isAppUpdateBroadcast = (content = '') => {
  return content.trim().startsWith(APP_UPDATE_TRIGGER_PHRASE);
};

export const hideSystemBroadcastMessageForThisDevice = (messageId) => {
  if (!messageId) return;
  const existingIds = JSON.parse(localStorage.getItem(HIDDEN_SYSTEM_BROADCAST_IDS_KEY) || '[]');
  const nextIds = Array.from(new Set([...existingIds, messageId]));
  localStorage.setItem(HIDDEN_SYSTEM_BROADCAST_IDS_KEY, JSON.stringify(nextIds));
};

export const isHiddenSystemBroadcastMessageForThisDevice = (messageId) => {
  if (!messageId) return false;
  const hiddenIds = JSON.parse(localStorage.getItem(HIDDEN_SYSTEM_BROADCAST_IDS_KEY) || '[]');
  return hiddenIds.includes(messageId);
};

export const markSystemBroadcastAckedForThisDevice = (messageId) => {
  if (!messageId) return;
  const existingIds = JSON.parse(localStorage.getItem(ACKED_SYSTEM_BROADCAST_IDS_KEY) || '[]');
  const nextIds = Array.from(new Set([...existingIds, messageId]));
  localStorage.setItem(ACKED_SYSTEM_BROADCAST_IDS_KEY, JSON.stringify(nextIds));
};

export const hasSystemBroadcastBeenAckedForThisDevice = (messageId) => {
  if (!messageId) return false;
  const ackedIds = JSON.parse(localStorage.getItem(ACKED_SYSTEM_BROADCAST_IDS_KEY) || '[]');
  return ackedIds.includes(messageId);
};