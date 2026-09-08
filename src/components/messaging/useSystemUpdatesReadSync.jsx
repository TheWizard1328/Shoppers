import { useEffect, useRef } from 'react';
import { markAllSystemUpdatesRead } from './updateBroadcastConfig';

/**
 * useSystemUpdatesReadSync
 *
 * On app load / refresh, mark every unread message in the "System Updates"
 * thread as read. The System Updates thread is the per-user conversation with
 * SYSTEM_UPDATES_SENDER_ID; its messages stay `read: false` until the device
 * actually restarts/refreshes to apply the update. Running this once per boot
 * clears the unread state after the restart/refresh the user just performed
 * (whether triggered by the Update button, the auto-update timer, a push
 * "Update Now" action, or a manual refresh).
 */
export function useSystemUpdatesReadSync(currentUser) {
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current) return;
    if (!currentUser?.id) return;
    doneRef.current = true;
    markAllSystemUpdatesRead(currentUser);
  }, [currentUser?.id]);
}