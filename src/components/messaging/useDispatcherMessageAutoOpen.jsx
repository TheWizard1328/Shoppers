import { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { userHasRole } from '../utils/userRoles';
import {
  SYSTEM_UPDATES_SENDER_ID,
  isAppUpdateBroadcast,
  isHiddenSystemBroadcastMessageForThisDevice,
} from './updateBroadcastConfig';

/**
 * useDispatcherMessageAutoOpen
 *
 * For dispatcher recipients only: when a direct user message arrives over the
 * Message realtime channel, automatically open the in-app Messages panel with
 * that conversation selected + focused.
 *
 * Rules (per approved PRD):
 *  - Only `dispatcher` role recipients trigger auto-open (non-dispatchers keep
 *    the existing MessageNotificationBalloon toast behavior).
 *  - System Updates / app-generated messages are excluded
 *    (sender_id === SYSTEM_UPDATES_SENDER_ID, or app-update broadcast content,
 *    or per-device-hidden system broadcasts).
 *  - If the "Add to Route" delivery form is open (isFormOverlayOpen), the message
 *    is QUEUED (latest only); when the form closes the panel auto-opens to it.
 *  - If the panel is already open on a different conversation, do NOT switch
 *    focus — instead flag the sender's conversation to BLINK in the list
 *    (via setPendingBlinkConversationId).
 *  - If the panel is already open on the SAME conversation, ChatWindow handles
 *    mark-as-read + scroll; nothing to do here.
 */
export function useDispatcherMessageAutoOpen({
  currentUser,
  isFormOverlayOpen,
  showMessaging,
  setShowMessaging,
  setInitialConversation,
  setPendingBlinkConversationId,
}) {
  // Latest qualifying message held while the Add to Route form is open.
  const queueRef = useRef(null);
  // De-dup IDs because both the SDK subscription and the window event fire for
  // the same message.
  const seenIdsRef = useRef(new Set());
  // Refs mirror latest values so the stable subscription handler reads current
  // state without re-subscribing on every render.
  const isFormOverlayOpenRef = useRef(isFormOverlayOpen);
  const showMessagingRef = useRef(showMessaging);

  useEffect(() => { isFormOverlayOpenRef.current = isFormOverlayOpen; }, [isFormOverlayOpen]);
  useEffect(() => { showMessagingRef.current = showMessaging; }, [showMessaging]);

  // ── Realtime subscription (stable, keyed on user id) ───────────────────
  useEffect(() => {
    if (!currentUser?.id) return;
    if (!userHasRole(currentUser, 'dispatcher')) return;

    const handleRealtime = (payload) => {
      const event = payload?.detail || payload;
      if (!event || event.type !== 'create') return;
      const msg = event.data;
      if (!msg || !msg.id) return;

      // De-dup the SDK + window event double-fire
      if (seenIdsRef.current.has(msg.id)) return;
      seenIdsRef.current.add(msg.id);
      if (seenIdsRef.current.size > 200) {
        seenIdsRef.current = new Set(Array.from(seenIdsRef.current).slice(-100));
      }

      // Must be a direct user message TO this dispatcher
      if (msg.receiver_id !== currentUser.id) return;
      if (msg.sender_id === currentUser.id) return;
      if (msg.sender_id === SYSTEM_UPDATES_SENDER_ID) return;
      if (isAppUpdateBroadcast(msg.content)) return;
      if (isHiddenSystemBroadcastMessageForThisDevice(msg.id)) return;

      const conversation = {
        conversationId: msg.conversation_id,
        otherUserId: msg.sender_id,
        otherUserName: msg.sender_name,
      };

      // Add to Route form open → queue latest qualifying message, open when form closes
      if (isFormOverlayOpenRef.current) {
        queueRef.current = conversation;
        return;
      }

      // Panel closed → auto-open with this conversation selected/focused
      if (!showMessagingRef.current) {
        setInitialConversation(conversation);
        setShowMessaging(true);
        setPendingBlinkConversationId(null);
        return;
      }

      // Panel already open → do not steal focus; flag the sender's card to blink
      setPendingBlinkConversationId(conversation.conversationId);
    };

    const unsubscribe = base44.entities.Message.subscribe(handleRealtime);
    window.addEventListener('messageRealtimeUpdate', handleRealtime);
    return () => {
      unsubscribe();
      window.removeEventListener('messageRealtimeUpdate', handleRealtime);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  // ── Form-close release: open the queued conversation when Add to Route closes ─
  useEffect(() => {
    if (isFormOverlayOpen) return; // form still open — keep waiting
    const queued = queueRef.current;
    if (!queued) return;
    queueRef.current = null;

    if (!showMessaging) {
      setInitialConversation(queued);
      setShowMessaging(true);
      setPendingBlinkConversationId(null);
    } else {
      // Panel was opened manually while the form was open → blink instead
      setPendingBlinkConversationId(queued.conversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFormOverlayOpen, showMessaging]);
}