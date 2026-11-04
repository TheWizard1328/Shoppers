import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { X, Send, Loader2, MessageSquare, ArrowLeft, Store, Car, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';
import DriverDutyBadge, { normalizeDriverDuty } from '@/components/messaging/DriverDutyBadge';
import { loadDriverDirectory, patientConversationId, driverThreadConversationId, sendPatientMessageToDriver, markDriverThreadRead } from '@/components/messaging/patientThreads';

/**
 * Patient portal messaging (owner build Nov 2 2026).
 *
 * TWO PATHS, patient chooses:
 *   Pharmacy team  — one thread per patient that EVERY dispatcher of that store
 *                    shares (conversation_id `patient:<id>`, driver_id empty).
 *   A driver       — a private 1:1 thread with a driver who has delivered to
 *                    them, today's driver first, each showing live duty status
 *                    (conversation_id `driver:<driverId>:patient:<id>`).
 *
 * Writes go through the patientPush function because the portal is a public
 * page with no Base44 user session.
 */

const patientSender = (patientId) => `patient:${patientId}`;

export async function loadPatientUnreadCount(patientId) {
  if (!patientId) return 0;
  try {
    const rows = await base44.entities.Message.filter({ patient_id: patientId, read: false }, '-created_date', 50);
    return (rows || []).filter((m) => m.sender_id !== patientSender(patientId)).length;
  } catch {
    return 0;
  }
}

export default function PatientMessaging({ patient, open, onClose, onUnreadChange }) {
  const patientId = patient?.id;
  const [messages, setMessages] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [active, setActive] = useState(null); // { kind: 'store' } | { kind: 'driver', driver }
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  const loadThread = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    try {
      const [rows, directory] = await Promise.all([
        base44.entities.Message.filter({ patient_id: patientId }, '-created_date', 200).catch(() => []),
        loadDriverDirectory(patientId),
      ]);
      setMessages((rows || []).slice().reverse());
      setDrivers(directory.drivers || []);
    } catch {
      setError('Could not load your messages.');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    if (!open) return;
    loadThread();
  }, [open, loadThread]);

  // Realtime: pharmacy and driver replies land without a refresh.
  useEffect(() => {
    if (!patientId) return undefined;
    let unsub = null;
    try {
      unsub = base44.entities.Message.subscribe((event) => {
        const row = event?.data || event?.payload || event;
        if (!row || row.patient_id !== patientId) return;
        setMessages((prev) => {
          if (event?.type === 'delete') return prev.filter((m) => m.id !== row.id);
          if (prev.some((m) => m.id === row.id)) return prev;
          return [...prev, row];
        });
      });
    } catch { /* realtime optional */ }
    return () => { try { unsub?.(); } catch { /* noop */ } };
  }, [patientId]);

  // Refresh duty status while the sheet is open so a driver going off duty
  // shows up without reopening the portal.
  useEffect(() => {
    if (!open || !patientId) return undefined;
    const timer = setInterval(async () => {
      const directory = await loadDriverDirectory(patientId);
      setDrivers(directory.drivers || []);
    }, 60000);
    return () => clearInterval(timer);
  }, [open, patientId]);

  const threadKey = (m) => (m.driver_id ? `driver:${m.driver_id}` : 'store');
  const activeKey = active ? (active.kind === 'driver' ? `driver:${active.driver.driver_id}` : 'store') : null;

  const threadMessages = useMemo(
    () => (activeKey ? messages.filter((m) => threadKey(m) === activeKey) : []),
    [messages, activeKey]
  );

  const stats = useMemo(() => {
    const map = new Map();
    for (const m of messages) {
      const key = threadKey(m);
      const entry = map.get(key) || { unread: 0, lastText: '', lastAt: 0 };
      const ts = new Date(parseEntityTimestamp?.(m.created_date) || m.created_date || 0).getTime() || 0;
      if (ts >= entry.lastAt) { entry.lastAt = ts; entry.lastText = m.content || ''; }
      if (!m.read && m.sender_id !== patientSender(patientId)) entry.unread += 1;
      map.set(key, entry);
    }
    return map;
  }, [messages, patientId]);

  const totalUnread = useMemo(
    () => Array.from(stats.values()).reduce((sum, s) => sum + (s.unread || 0), 0),
    [stats]
  );
  useEffect(() => { if (open) onUnreadChange?.(totalUnread); }, [totalUnread, open, onUnreadChange]);

  const markRead = useCallback(async (driverId) => {
    if (driverId) {
      await markDriverThreadRead({ patientId, driverId }).catch(() => {});
    } else {
      await base44.functions.invoke('patientPush', {
        action: 'patientMarkRead',
        patient_id: patientId,
      }).catch(() => {});
    }
    setMessages((prev) => prev.map((m) => {
      const key = threadKey(m);
      const target = driverId ? `driver:${driverId}` : 'store';
      return key === target && !m.read && m.sender_id !== patientSender(patientId) ? { ...m, read: true } : m;
    }));
  }, [patientId]);

  const openStoreThread = () => {
    setActive({ kind: 'store' });
    markRead(null);
  };

  const openDriverThread = (driver) => {
    setActive({ kind: 'driver', driver });
    markRead(driver.driver_id);
    // Fresh duty status for the chat header (the list may be a minute old).
    loadDriverDirectory(patientId).then((directory) => {
      const fresh = (directory.drivers || []).find((d) => d.driver_id === driver.driver_id);
      if (fresh) setActive({ kind: 'driver', driver: fresh });
    }).catch(() => {});
  };

  useEffect(() => {
    if (active) endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [active, threadMessages.length]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || !patientId) return;
    setSending(true);
    setError('');
    try {
      // Driver threads write through patientThreadMsg (patientPush resolves the
      // driver by the wrong id and drops the message into the pharmacy thread).
      const targetDriverId = active?.kind === 'driver' ? active.driver.driver_id : '';
      let created = null;
      if (targetDriverId) {
        created = await sendPatientMessageToDriver({ patientId, driverId: targetDriverId, content: text });
      } else {
        const res = await base44.functions.invoke('patientPush', {
          action: 'patientSend',
          patient_id: patientId,
          content: text,
        });
        created = res?.data?.message || res?.message || null;
        if (!created?.id) throw new Error(res?.data?.error || 'send_failed');
      }
      if (!created?.id) throw new Error('send_failed');
      setInput('');
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
    } catch {
      setError('Message not sent. Please try again.');
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  const renderBubble = (m) => {
    const mine = m.sender_id === patientSender(patientId);
    const ts = parseEntityTimestamp?.(m.created_date) || m.created_date;
    return (
      <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
        <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
          mine
            ? 'bg-green-600 text-white rounded-br-sm'
            : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-bl-sm'
        }`}>
          <p className="whitespace-pre-wrap break-words">{m.content}</p>
          <p className={`mt-1 text-[10px] ${mine ? 'text-green-100' : 'text-slate-400 dark:text-slate-500'}`}>
            {ts ? format(new Date(ts), 'MMM d, h:mm a') : ''}
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg h-[82vh] sm:h-[70vh] bg-white dark:bg-slate-900 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          {active ? (
            <button
              onClick={() => { setActive(null); setInput(''); setError(''); }}
              className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center"
              aria-label="Back to messages"
            >
              <ArrowLeft className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            </button>
          ) : (
            <MessageSquare className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
              {active
                ? (active.kind === 'driver' ? (active.driver.driver_name || 'Your driver') : 'Pharmacy team')
                : 'Messages'}
            </p>
            {active ? (
              active.kind === 'driver' ? (
                <div className="mt-0.5">
                  <DriverDutyBadge status={active.driver.duty_status} size="xs" />
                </div>
              ) : (
                <p className="text-xs text-slate-400 dark:text-slate-500 truncate">Every dispatcher at your pharmacy sees this</p>
              )
            ) : (
              <p className="text-xs text-slate-400 dark:text-slate-500 truncate">Message your pharmacy or your driver</p>
            )}
          </div>
          <button
            onClick={() => { loadThread(); }}
            className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 text-slate-500 dark:text-slate-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center"
            aria-label="Close messages"
          >
            <X className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Body */}
        {!active ? (
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
            ) : (
              <>
                {/* Pharmacy team thread — shared by all dispatchers of the store */}
                <button
                  onClick={openStoreThread}
                  className="w-full text-left px-3 py-3 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <div className="w-9 h-9 rounded-full bg-slate-900 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                    <Store className="w-4 h-4 text-white" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Pharmacy team</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                      {stats.get('store')?.lastText || 'All dispatchers at your store'}
                    </p>
                  </div>
                  {(stats.get('store')?.unread || 0) > 0 && (
                    <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                      {stats.get('store').unread > 9 ? '9+' : stats.get('store').unread}
                    </span>
                  )}
                </button>

                {/* Driver threads */}
                {drivers.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-slate-400 dark:text-slate-500">
                    Drivers appear here once you have a delivery with them.
                  </p>
                ) : (
                  drivers.map((driver) => {
                    const key = `driver:${driver.driver_id}`;
                    const s = stats.get(key);
                    return (
                      <button
                        key={driver.driver_id}
                        onClick={() => openDriverThread(driver)}
                        className="w-full text-left px-3 py-3 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-950 flex items-center justify-center flex-shrink-0">
                          <Car className="w-4 h-4 text-blue-600 dark:text-blue-300" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                              {driver.driver_name || 'Driver'}
                            </p>
                            {driver.is_current && (
                              <span className="text-[10px] font-medium px-1.5 h-4 rounded-full bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300 flex items-center">
                                Today
                              </span>
                            )}
                            <DriverDutyBadge status={driver.duty_status} size="xs" />
                          </div>
                          <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                            {s?.lastText || (driver.is_current ? 'Your driver today' : 'Delivered to you before')}
                          </p>
                        </div>
                        {(s?.unread || 0) > 0 && (
                          <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                            {s.unread > 9 ? '9+' : s.unread}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-slate-50 dark:bg-slate-950/40">
              {loading ? (
                <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
              ) : threadMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-6 gap-1">
                  <MessageSquare className="w-7 h-7 text-slate-300 dark:text-slate-600" />
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No messages yet</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    {active.kind === 'driver'
                      ? `This thread is just between you and ${active.driver.driver_name || 'your driver'}.`
                      : 'Send a message and your pharmacy team will reply here.'}
                  </p>
                </div>
              ) : (
                threadMessages.map(renderBubble)
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
          </>
        )}
      </div>
    </div>
  );
}
