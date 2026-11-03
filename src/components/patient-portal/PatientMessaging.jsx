import React, { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { X, Send, Loader2, MessageSquare } from 'lucide-react';
import { format } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';

/**
 * Patient portal messaging (owner build Nov 2 2026).
 *
 * One thread per patient, stored in the Message entity with the reserved
 * patient shape documented in components/messaging/patientThreads.jsx:
 *   conversation_id = `patient:<id>`, patient_id = <id>,
 *   patient's own messages use sender_id `patient:<id>`.
 */

const conversationIdFor = (patientId) => `patient:${patientId}`;
const patientSender = (patientId) => `patient:${patientId}`;

export async function loadPatientUnreadCount(patientId) {
  if (!patientId) return 0;
  try {
    const rows = await base44.entities.Message.filter(
      { patient_id: patientId, read: false },
      '-created_date',
      50
    );
    return (rows || []).filter((m) => m.sender_id !== patientSender(patientId)).length;
  } catch {
    return 0;
  }
}

export default function PatientMessaging({ patient, open, onClose, onUnreadChange }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);
  const patientId = patient?.id;

  // Read receipts go through the patientPush function: the portal is a public
  // page with no Base44 user, so service-role writes are the reliable path.
  const markStaffMessagesRead = useCallback(async (rows) => {
    const unread = (rows || []).filter((m) => !m.read && m.sender_id !== patientSender(patientId));
    if (unread.length === 0) return;
    await base44.functions.invoke('patientPush', {
      action: 'patientMarkRead',
      patient_id: patientId,
    }).catch(() => {});
    setMessages((prev) => prev.map((m) => (
      unread.some((u) => u.id === m.id) ? { ...m, read: true } : m
    )));
    onUnreadChange?.(0);
  }, [patientId, onUnreadChange]);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    try {
      const rows = await base44.entities.Message.filter(
        { patient_id: patientId },
        '-created_date',
        200
      );
      const ordered = (rows || []).slice().reverse();
      setMessages(ordered);
      if (open) markStaffMessagesRead(ordered);
    } catch {
      setError('Could not load your messages.');
    } finally {
      setLoading(false);
    }
  }, [patientId, open, markStaffMessagesRead]);

  useEffect(() => { load(); }, [load]);

  // Realtime: the pharmacy's reply lands here without a refresh.
  useEffect(() => {
    if (!patientId) return undefined;
    let unsub = null;
    try {
      unsub = base44.entities.Message.subscribe((event) => {
        const row = event?.data || event?.payload || event;
        if (!row || row.patient_id !== patientId) return;
        if (event?.type === 'delete') {
          setMessages((prev) => prev.filter((m) => m.id !== row.id));
          return;
        }
        setMessages((prev) => {
          if (prev.some((m) => m.id === row.id)) return prev;
          return [...prev, row];
        });
        if (open && row.sender_id !== patientSender(patientId) && !row.read) {
          base44.functions.invoke('patientPush', {
            action: 'patientMarkRead',
            patient_id: patientId,
          }).catch(() => {});
        }
      });
    } catch { /* realtime is optional */ }
    return () => { try { unsub?.(); } catch { /* noop */ } };
  }, [patientId, open]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [open, messages.length]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || !patientId) return;
    setSending(true);
    setError('');
    try {
      // ONE call: writes the message service-role and alerts the store's staff
      // devices, so a patient reply never depends on entity RLS or on someone
      // having the Messaging panel open.
      const res = await base44.functions.invoke('patientPush', {
        action: 'patientSend',
        patient_id: patientId,
        content: text,
      });
      const created = res?.data?.message || res?.message || null;
      if (!created?.id) throw new Error(res?.data?.error || 'send_failed');
      setInput('');
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
    } catch {
      setError('Message not sent. Please try again.');
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1200] flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg h-[80vh] sm:h-[70vh] bg-white dark:bg-slate-900 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <MessageSquare className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-900 dark:text-slate-100">Message your pharmacy</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
              Questions about your delivery, payment or prescription
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center"
            aria-label="Close messages"
          >
            <X className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-slate-50 dark:bg-slate-950/40">
          {loading ? (
            <div className="flex items-center justify-center h-full text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 gap-1">
              <MessageSquare className="w-7 h-7 text-slate-300 dark:text-slate-600" />
              <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No messages yet</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Send a message and your pharmacy will reply here. You will also get a notification once it arrives.
              </p>
            </div>
          ) : (
            messages.map((m) => {
              const mine = m.sender_id === patientSender(patientId);
              const ts = parseEntityTimestamp?.(m.created_date) || m.created_date;
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                      mine
                        ? 'bg-green-600 text-white rounded-br-sm'
                        : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-bl-sm'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                    <p className={`mt-1 text-[10px] ${mine ? 'text-green-100' : 'text-slate-400 dark:text-slate-500'}`}>
                      {ts ? format(new Date(ts), 'MMM d, h:mm a') : ''}
                      {!mine && m.read ? ' · read' : ''}
                    </p>
                  </div>
                </div>
              );
            })
          )}
          <div ref={endRef} />
        </div>

        {error && <p className="px-4 pb-1 text-xs text-red-500">{error}</p>}

        <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
            placeholder="Type a message..."
            className="flex-1 h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 outline-none focus:border-green-500"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="h-10 w-10 rounded-lg bg-green-600 text-white flex items-center justify-center disabled:opacity-50"
            aria-label="Send message"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
