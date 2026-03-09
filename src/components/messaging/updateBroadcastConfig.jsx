export const APP_UPDATE_TRIGGER_PHRASE = 'Your app has just been updated.';

export const APP_UPDATE_BROADCAST_MESSAGE = `${APP_UPDATE_TRIGGER_PHRASE} Please click the update button to complete the update. Will restart your app and apply the update. Otherwise your app will update automatically the next time you restart.`;

export const isAppUpdateBroadcast = (content = '') => {
  return content.trim().startsWith(APP_UPDATE_TRIGGER_PHRASE);
};