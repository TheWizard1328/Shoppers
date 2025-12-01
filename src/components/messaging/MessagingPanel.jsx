import React, { useState } from 'react';
import ConversationsList from './ConversationsList';
import ChatWindow from './ChatWindow';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function MessagingPanel({ currentUser, users, onClose }) {
  const [selectedConversation, setSelectedConversation] = useState(null);

  const handleSelectConversation = (conversationId, otherUserId, otherUserName) => {
    setSelectedConversation({ conversationId, otherUserId, otherUserName });
  };

  const handleBack = () => {
    setSelectedConversation(null);
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between bg-slate-50">
          <h2 className="text-lg font-semibold text-slate-900">Messages</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Conversations list - hidden on mobile when chat is open */}
          <div className={`w-full lg:w-80 border-r flex-shrink-0 ${
            selectedConversation ? 'hidden lg:flex lg:flex-col' : 'flex flex-col'
          }`}>
            <ConversationsList
              currentUser={currentUser}
              users={users}
              onSelectConversation={handleSelectConversation}
              selectedConversationId={selectedConversation?.conversationId}
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
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-500">
                <p>Select a conversation to start messaging</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}