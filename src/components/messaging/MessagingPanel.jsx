import React, { useState, useCallback, memo } from 'react';
import { base44 } from '@/api/base44Client';
import ConversationsList from './ConversationsList';
import ChatWindow from './ChatWindow';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isAppOwner } from '@/components/utils/userRoles';
import {
  APP_UPDATE_BROADCAST_MESSAGE,
  SYSTEM_UPDATES_SENDER_ID,
  SYSTEM_UPDATES_SENDER_NAME,
  hideSystemBroadcastMessageForThisDevice,
} from './updateBroadcastConfig';

function MessagingPanel({ currentUser, users, onClose, initialConversation, onUnreadCountChange }) {
  const [selectedConversation, setSelectedConversation] = useState(initialConversation || null);
  const [isBroadcastingUpdate, setIsBroadcastingUpdate] = useState(false);
  const [updateBroadcastSent, setUpdateBroadcastSent] = useState(false);
  const canBroadcastUpdate = isAppOwner(currentUser);
  
  const handleMessagesRead = useCallback((count) => {
    if (onUnreadCountChange) {
      onUnreadCountChange(prev => Math.max(0, prev - count));
    }
  }, [onUnreadCountChange]);

  const handleSelectConversation = useCallback((conversationId, otherUserId, otherUserName) => {
    setSelectedConversation({ conversationId, otherUserId, otherUserName });
  }, []);

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
    <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-4 overflow-y-auto overflow-x-hidden">
      <div className="rounded-xl shadow-2xl w-full max-w-4xl h-[80vh] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden" style={{ background: 'var(--bg-white)' }}>
        {/* Header */}
        <div className="p-4 flex items-center justify-between gap-3" style={{ background: 'var(--bg-slate-50)', borderBottom: '1px solid var(--border-slate-200)' }}>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-slate-900)' }}>Messages</h2>
          <div className="flex items-center gap-2">
            {canBroadcastUpdate && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleBroadcastUpdate}
                disabled={isBroadcastingUpdate}
                className="gap-2"
              >
                {isBroadcastingUpdate ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                {updateBroadcastSent ? 'Update Sent' : 'Broadcast Update'}
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={handleCloseMessaging}>
              <X className="w-5 h-5" style={{ color: 'var(--text-slate-700)' }} />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Conversations list - hidden on mobile when chat is open */}
          <div 
            className={`w-full lg:w-80 flex-shrink-0 ${
              selectedConversation ? 'hidden lg:flex lg:flex-col' : 'flex flex-col'
            }`}
            style={{ borderRight: '1px solid var(--border-slate-200)' }}
          >
            <ConversationsList
              currentUser={currentUser}
              users={users}
              onSelectConversation={handleSelectConversation}
              selectedConversationId={selectedConversation?.conversationId}
              onUnreadCountChange={onUnreadCountChange}
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
                onBack={handleBack}
                onMessagesRead={handleMessagesRead}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-slate-500)' }}>
                <p>Select a conversation to start messaging</p>
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
    getMessagingUsersSignature(prevProps.users) === getMessagingUsersSignature(nextProps.users)
  );
};

export default memo(MessagingPanel, areMessagingPanelPropsEqual);