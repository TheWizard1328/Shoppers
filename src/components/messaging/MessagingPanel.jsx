import { useState, useEffect, useCallback, memo } from 'react';
import { base44 } from '@/api/base44Client';
import ConversationsList from './ConversationsList';
import ChatWindow from './ChatWindow';
import PatientThreadsPanel from './PatientThreadsPanel';
import { loadPatientThreadMessages, isPatientSender } from './patientThreads';
import { Loader2, RefreshCw, X, Search, Users } from 'lucide-react';
import { isAppOwner } from '@/components/utils/userRoles';
import {
  APP_UPDATE_BROADCAST_MESSAGE,
  SYSTEM_UPDATES_SENDER_ID,
  SYSTEM_UPDATES_SENDER_NAME,
  hideSystemBroadcastMessageForThisDevice,
} from './updateBroadcastConfig';


function MessagingPanel({ currentUser, users, onClose, initialConversation, onUnreadCountChange, pendingBlinkConversationId, onClearBlink }) {
  const [selectedConversation, setSelectedConversation] = useState(initialConversation || null);
  // Patient portal threads (owner build Nov 2 2026) live beside staff chat.
  // A push notification or balloon for a patient/driver thread arrives as a
  // conversation id (`patient:<id>` or `driver:<d>:patient:<id>`) — open the
  // Patients tab straight onto that thread instead of a staff chat window.
  const initialPatientId = (() => {
    const cid = String(initialConversation?.conversationId || '');
    if (cid.startsWith('driver:') || cid.startsWith('patient:')) {
      const parts = cid.split('patient:');
      if (parts[1]) return parts[1];
    }
    const other = String(initialConversation?.otherUserId || '');
    if (other.startsWith('patient:')) return other.slice('patient:'.length);
    return null;
  })();
  const [tab, setTab] = useState(initialPatientId ? 'patients' : 'staff');
  // Unread patient messages, so the tab shows a badge before it is opened.
  const [patientUnread, setPatientUnread] = useState(0);
  const [isBroadcastingUpdate, setIsBroadcastingUpdate] = useState(false);
  const [updateBroadcastSent, setUpdateBroadcastSent] = useState(false);
  // Search + New Group live in the panel's own toolbar, so their state is owned here.
  const [conversationSearch, setConversationSearch] = useState('');
  const [patientSearch, setPatientSearch] = useState('');
  const [patientChatOpen, setPatientChatOpen] = useState(false);
  const [newGroupSignal, setNewGroupSignal] = useState(0);
  const canBroadcastUpdate = isAppOwner(currentUser);
  
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await loadPatientThreadMessages(currentUser);
      if (cancelled) return;
      setPatientUnread((rows || []).filter((m) => !m.read && isPatientSender(m.sender_id)).length);
    })();
    let unsub = null;
    try {
      unsub = base44.entities.Message.subscribe((event) => {
        const row = event?.data || event?.payload || event;
        if (!row?.patient_id || !isPatientSender(row.sender_id) || row.read) return;
        setPatientUnread((prev) => prev + 1);
      });
    } catch { /* realtime optional */ }
    return () => { cancelled = true; try { unsub?.(); } catch { /* noop */ } };
  }, [currentUser?.id]);

  const handleMessagesRead = useCallback((count) => {
    if (onUnreadCountChange) {
      onUnreadCountChange(prev => Math.max(0, prev - count));
    }
  }, [onUnreadCountChange]);

  const handleSelectConversation = useCallback((conversationId, otherUserId, otherUserName, group) => {
    setSelectedConversation({ conversationId, otherUserId, otherUserName, group });
    // Stop the blink the moment the dispatcher opens the blinking conversation
    if (onClearBlink && conversationId === pendingBlinkConversationId) {
      onClearBlink(null);
    }
  }, [onClearBlink, pendingBlinkConversationId]);

  const handleCloseMessaging = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleBack = useCallback(() => {
    setSelectedConversation(null);
  }, []);

  const handleBroadcastUpdate = useCallback(async () => {
    if (!currentUser?.id || isBroadcastingUpdate) return;

    const recipients = (users || []).filter((user) => user?.id);
    if (recipients.length === 0) return;

    setIsBroadcastingUpdate(true);
    setUpdateBroadcastSent(false);

    const results = await Promise.allSettled(
      recipients.map(async (user) => {
        if (user.id === SYSTEM_UPDATES_SENDER_ID) return { recipientId: user.id, message: null };
        const message = await base44.entities.Message.create({
          sender_id: SYSTEM_UPDATES_SENDER_ID,
          sender_name: SYSTEM_UPDATES_SENDER_NAME,
          receiver_id: user.id,
          receiver_name: user.user_name || user.full_name || 'User',
          conversation_id: [SYSTEM_UPDATES_SENDER_ID, user.id].sort().join('_'),
          content: APP_UPDATE_BROADCAST_MESSAGE,
          read: false,
        });

        // App Update is always pushed regardless of user push preference (force: true).
        // Include an "Update Now" action button so the user can trigger the
        // update straight from the notification, plus the broadcast message_id
        // so the "mark read" path works when the update is applied.
        await base44.functions.invoke('sendPushNotification', {
          user_id: user.id,
          title: 'App Update Available',
          body: 'There is an update available. App restart required.',
          url: '/',
          force: true,
          requireInteraction: true,
          actions: [{ action: 'update_now', title: 'Update Now' }],
          data: message?.id ? { message_id: message.id } : undefined,
        }).catch(() => {});

        return { recipientId: user.id, message };
      })
    );

    const selfBroadcast = results.find(
      (result) => result.status === 'fulfilled' && result.value.recipientId === currentUser.id
    );

    if (selfBroadcast?.status === 'fulfilled') {
      hideSystemBroadcastMessageForThisDevice(selfBroadcast.value.message?.id);
    }

    setIsBroadcastingUpdate(false);
    setUpdateBroadcastSent(true);
    window.setTimeout(() => setUpdateBroadcastSent(false), 4000);
  }, [currentUser?.id, isBroadcastingUpdate, users]);

  return (
    <div className="fixed inset-0 z-[9999] bg-black/50 dark:bg-black/70 flex items-center justify-center p-4 overflow-y-auto overflow-x-hidden">
      <div className="rounded-xl shadow-2xl dark:shadow-black/50 w-full max-w-4xl h-[80vh] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
        {/* Header — dark mode mirrors the patient portal panel (owner request
            Nov 3 2026): slate card, slate-100/800 icon buttons, no washed-out
            light-only surfaces. */}
        <div className="p-4 flex items-center justify-between gap-3 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Messages</h2>
          <div className="flex items-center gap-2">
            {canBroadcastUpdate && (
              <button
                type="button"
                onClick={handleBroadcastUpdate}
                disabled={isBroadcastingUpdate}
                className="h-8 px-3 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors disabled:opacity-60"
              >
                {isBroadcastingUpdate ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                {updateBroadcastSent ? 'Update Sent' : 'Broadcast Update'}
              </button>
            )}
            <button
              type="button"
              onClick={handleCloseMessaging}
              className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              aria-label="Close messages"
            >
              <X className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            </button>
          </div>
        </div>

        {/* Tabs + search + New Group: one row, controls pinned far right */}
        <div className="flex items-center gap-1 px-3 sm:px-4 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
          <button
            onClick={() => setTab('staff')}
            className={`h-8 px-3 rounded-lg text-sm font-medium ${tab === 'staff' ? 'bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70'}`}
          >
            Staff
          </button>
          <button
            onClick={() => setTab('patients')}
            className={`h-8 px-3 rounded-lg text-sm font-medium ${tab === 'patients' ? 'bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70'}`}
          >
            Patients
            {patientUnread > 0 && (
              <span className="ml-1.5 inline-flex min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold items-center justify-center align-middle">
                {patientUnread > 9 ? '9+' : patientUnread}
              </span>
            )}
          </button>

          {tab === 'patients' && (
            <div className={`ml-auto items-center gap-1.5 min-w-0 pl-2 ${patientChatOpen ? 'hidden lg:flex' : 'flex'}`}>
              <div className="relative min-w-0 flex-1 sm:flex-none">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                <input
                  value={patientSearch}
                  onChange={(e) => setPatientSearch(e.target.value)}
                  placeholder="Search patients..."
                  className="h-8 w-full sm:w-56 pl-8 pr-2 rounded-lg bg-slate-100 dark:bg-slate-800 border-0 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {tab === 'staff' && (
            <div className="ml-auto flex items-center gap-1.5 min-w-0 pl-2">
              <div className="relative min-w-0 flex-1 sm:flex-none">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                <input
                  value={conversationSearch}
                  onChange={(e) => setConversationSearch(e.target.value)}
                  placeholder="Search conversations..."
                  className="h-8 w-full sm:w-56 pl-8 pr-2 rounded-lg bg-slate-100 dark:bg-slate-800 border-0 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <button
                type="button"
                onClick={() => setNewGroupSignal((n) => n + 1)}
                title="New Group"
                className="h-8 px-2 sm:px-3 flex-shrink-0 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              >
                <Users className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">New Group</span>
              </button>
            </div>
          )}
        </div>

        {/* Content: patient portal threads or staff chat.
            BOTH STAY MOUNTED (owner report Nov 4 2026): swapping tabs used to
            unmount the inactive side, so every flip re-ran the patient-thread
            read and the conversation read — dozens of calls in a row, 429s and a
            blanked thread list. Now the inactive side is only hidden. */}
        <div className={tab === 'patients' ? 'flex-1 flex overflow-hidden' : 'hidden'}>
          <PatientThreadsPanel
              currentUser={currentUser}
              onUnreadCountChange={onUnreadCountChange}
              initialPatientId={initialPatientId}
              searchQuery={patientSearch}
              onSearchChange={setPatientSearch}
              onSelectionChange={setPatientChatOpen}
          />
        </div>
        <div className={tab === 'staff' ? 'flex-1 flex overflow-hidden' : 'hidden'}>
          {/* Conversations list - hidden on mobile when chat is open */}
          <div
            className={`w-full lg:w-80 flex-shrink-0 border-r border-slate-200 dark:border-slate-700 ${
              selectedConversation ? 'hidden lg:flex lg:flex-col' : 'flex flex-col'
            }`}
          >
            <ConversationsList
              currentUser={currentUser}
              users={users}
              onSelectConversation={handleSelectConversation}
              selectedConversationId={selectedConversation?.conversationId}
              onUnreadCountChange={onUnreadCountChange}
              pendingBlinkConversationId={pendingBlinkConversationId}
              searchQuery={conversationSearch}
              onSearchChange={setConversationSearch}
              hideSearchBar
              openNewGroupSignal={newGroupSignal}
            />
          </div>

          {/* Chat window */}
          <div className={`flex-1 ${
            selectedConversation ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'
          }`}>
            {selectedConversation ? (
              <ChatWindow
                currentUser={currentUser}
                conversationId={selectedConversation.conversationId}
                otherUserId={selectedConversation.otherUserId}
                otherUserName={selectedConversation.otherUserName}
                group={selectedConversation.group}
                users={users}
                onBack={handleBack}
                onMessagesRead={handleMessagesRead}
                canDelete={isAppOwner(currentUser)}
                autoFocus={!!(initialConversation && initialConversation.conversationId === selectedConversation.conversationId)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center bg-slate-50 dark:bg-slate-950/40 text-slate-500 dark:text-slate-400">
                <p className="text-sm">Select a conversation to start messaging</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const getMessagingUsersSignature = (users = []) =>
  (users || [])
    .map((user) => `${user?.id || ''}:${user?.user_name || user?.full_name || ''}:${user?.status || ''}`)
    .join('|');

const areMessagingPanelPropsEqual = (prevProps, nextProps) => {
  return (
    prevProps.currentUser?.id === nextProps.currentUser?.id &&
    (prevProps.currentUser?.user_name || prevProps.currentUser?.full_name) === (nextProps.currentUser?.user_name || nextProps.currentUser?.full_name) &&
    prevProps.currentUser?.role === nextProps.currentUser?.role &&
    prevProps.onClose === nextProps.onClose &&
    prevProps.onUnreadCountChange === nextProps.onUnreadCountChange &&
    prevProps.initialConversation?.conversationId === nextProps.initialConversation?.conversationId &&
    prevProps.initialConversation?.otherUserId === nextProps.initialConversation?.otherUserId &&
    prevProps.initialConversation?.otherUserName === nextProps.initialConversation?.otherUserName &&
    prevProps.pendingBlinkConversationId === nextProps.pendingBlinkConversationId &&
    prevProps.onClearBlink === nextProps.onClearBlink &&
    getMessagingUsersSignature(prevProps.users) === getMessagingUsersSignature(nextProps.users)
  );
};

export default memo(MessagingPanel, areMessagingPanelPropsEqual);