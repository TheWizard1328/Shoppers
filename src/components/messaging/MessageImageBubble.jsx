import React, { useState, memo } from 'react';
import ImageViewer from '@/components/common/ImageViewer';
import { format } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';

/**
 * Renders a single image message bubble (thumbnail + optional caption + timestamp),
 * with a tap-to-expand lightbox via the shared ImageViewer.
 * Used for both 1:1 and group messages.
 */
function MessageImageBubble({ message, isOwnMessage, showSenderName }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const caption = message?.content || '';
  const senderName = message?.sender_name || '';
  const createdDate = message?.created_date;

  const bubbleStyle = {
    background: isOwnMessage ? '#10b981' : 'var(--bg-white)',
    color: isOwnMessage ? '#ffffff' : 'var(--text-slate-900)',
  };

  return (
    <>
      <div
        className="rounded-2xl px-2 py-2 rounded-bl-sm max-w-[80%] shadow-sm"
        style={bubbleStyle}
      >
        {showSenderName && !isOwnMessage && (
          <p className="text-xs font-semibold mb-1 px-1" style={{ color: 'var(--text-slate-500)' }}>
            {senderName}
          </p>
        )}
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          className="block rounded-xl overflow-hidden focus:outline-none focus:ring-2 focus:ring-emerald-400"
          style={{ lineHeight: 0 }}
        >
          <img
            src={message.attachment_url}
            alt={caption || 'Shared image'}
            className="block object-cover"
            style={{ maxWidth: '240px', maxHeight: '240px', width: 'auto', height: 'auto' }}
            loading="lazy"
          />
        </button>
        {caption && (
          <p className="whitespace-pre-wrap break-words px-1 pt-1 text-sm">{caption}</p>
        )}
        <p
          className="text-xs mt-1 px-1"
          style={{ color: isOwnMessage ? 'rgba(255,255,255,0.7)' : 'var(--text-slate-400)' }}
        >
          {createdDate && format(parseEntityTimestamp(createdDate), 'h:mm a')}
        </p>
      </div>
      {viewerOpen && (
        <ImageViewer
          imageUrl={message.attachment_url}
          title={caption || 'Shared image'}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

export default memo(MessageImageBubble);