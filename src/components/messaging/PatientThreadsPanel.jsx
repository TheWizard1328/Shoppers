import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Send, Search, ArrowLeft, User, MessageSquare } from 'lucide-react';
import { format } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';
import {
  loadPatientThreadMessages,
  loadMessagablePatients,
  sendStaffMessageToPatient,
  patientConversationId,
  patientSenderId,
  isPatientSender,
  staffStoreIds,
} from './patientThreads';

/**
 * PatientThreadsPanel — staff side of the patient portal chat (owner build
 * Nov 2 2026). Lists patients of the staff member's store(s) with an unread
 * count, opens the thread, and pushes the reply to the patient's devices.
 */
export default function PatientThreadsPanel({ currentUser, stores = [], onUnreadCountChange }) {
  const [patients, setPatients] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [thread, setThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [storeRows, setStoreRows] = useState(stores || []);
  const unreadContributedRef = useRef(0);
  const endRef = useRef(null);

  // Store name for the push title — fetched once when the parent has no list.
  useEffect(() => {
    if ((stores || []).length > 0) { setStoreRows(stores); return; }
    let cancelled = false;
    base44.entities.Store.filter({}).then((rows) => {
      if (!cancelled) setStoreRows(rows || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [stores]);

  const storeName = useMemo(() => {
    const ids = staffStoreIds(currentUser);
    const match = (storeRows || []).find((s) => ids.includes(s.id));
    return match?.name || 'Your pharmacy';
  }, [currentUser, storeRows]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [patientRows, messageRows] = await Promise.all([
      loadMessagablePatients(currentUser),
      loadPatientThreadMessages(currentUser),
    ]);
    setPatients(patientRows || []);
    setMessages(messageRows || []);
    setLoading(false);
  }, [currentUser]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Live updates: a new patient message bumps the unread badge immediately.
  useEffect(() => {
    let unsub = null;
    try {
      unsub = base44.entities.Message.subscribe((event) => {
        const row = event?.data || event?.payload || event;
        if (!row?.patient_id) return;
        setMessages((prev) => {
          if (event?.type === 'delete') return prev.filter((m) => m.id !== row.id);
          if (prev.some((m) => m.id === row.id)) return prev;
          return [row, ...prev];
        });
      });
    } catch { /* realtime optional */ }
    return () => { try { unsub?.(); } catch { /* noop */ } };
  }, []);

  // Unread per patient, derived from the loaded patient-thread messages.
  const threadStats = useMemo(() => {
    const stats = new Map();
    for (const m of messages) {
      const pid = m.patient_id;
      if (!pid) continue;
      const entry = stats.get(pid) || { lastAt: 0, lastText: '', unread: 0 };
      const ts = new Date(parseEntityTimestamp?.(m.created_date) || m.created_date || 0).getTime() || 0;
      if (ts >= entry.lastAt) {
        entry.lastAt = ts;
        entry.lastText = m.content || '';
      }
      if (!m.read && isPatientSender(m.sender_id)) entry.unread += 1;
      stats.set(pid, entry);
    }
    return stats;
  }, [messages]);

  // Feed the panel's unread badge as a DELTA — the parent tracks a combined
  // staff + patient count through a setState-style callback.
  useEffect(() => {
    const total = Array.from(threadStats.values()).reduce((sum, s) => sum + (s.unread || 0), 0);
    const delta = total - unreadContributedRef.current;
    unreadContributedRef.current = total;
    if (delta !== 0) onUnreadCountChange?.((prev) => Math.max(0, (prev || 0) + delta));
  }, [threadStats, onUnreadCountChange]);

  const openThread = useCallback(async (patient) => {
    setSelected(patient);
    setThreadLoading(true);
    try {
      const rows = await base44.entities.Message.filter(
        { patient_id: patient.id },
        '-created_date',
        200
      );
      setThread((rows || []).slice().reverse());
      // Opening the thread clears the unread badge for that patient.
      const unread = (rows || []).filter((m) => !m.read && isPatientSender(m.sender_id));
      await Promise.all(unread.map((m) => base44.entities.Message.update(m.id, { read: true }).catch(() => {})));
      if (unread.length) {
        setMessages((prev) => prev.map((m) => (unread.some((u) => u.id === m.id) ? { ...m, read: true } : m)));
      }
    } catch {
      setThread([]);
    } finally {
      setThreadLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [selected, thread.length]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || !selected) return;
    setSending(true);
    try {
      const created = await sendStaffMessageToPatient({
        user: currentUser,
        patient: selected,
        content: text,
        storeName,
      });
      setInput('');
      if (created?.id) setThread((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
    } catch { /* the thread still shows the error state via input retention */ } finally {
      setSending(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (patients || []).filter((p) => {
      if (!q) return true;
      return (p.full_name || '').toLowerCase().includes(q) || (p.phone || '').includes(q);
    });
    // Patients with unread messages float to the top, then by recent activity.
    return list.sort((a, b) => {
      const ua = threadStats.get(a.id)?.unread || 0;
      const ub = threadStats.get(b.id)?.unread || 0;
      if (ua !== ub) return ub - ua;
      const ta = threadStats.get(a.id)?.lastAt || 0;
      const tb = threadStats.get(b.id)?.lastAt || 0;
      return tb - ta;
    });
  }, [patients, search, threadStats]);

  if (selected) {
    return (
      <div className="flex flex-col h-full w-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border-slate-200)' }}>
          <button onClick={() => { setSelected(null); setInput(''); }} className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-800" aria-label="Back">
            <ArrowLeft className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate text-slate-900 dark:text-slate-100">{selected.full_name}</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{selected.phone || 'Patient portal'}</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-slate-50 dark:bg-slate-950/40">
          {threadLoading ? (
            <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : thread.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-1 px-6">
              <MessageSquare className="w-7 h-7 text-slate-300 dark:text-slate-600" />
              <p className="text-sm text-slate-500 dark:text-slate-400">No messages yet</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">Send the first message — it is pushed to the patient's devices.</p>
            </div>
          ) : (
            thread.map((m) => {
              const fromPatient = isPatientSender(m.sender_id);
              const ts = parseEntityTimestamp?.(m.created_date) || m.created_date;
              return (
                <div key={m.id} className={`flex ${fromPatient ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                    fromPatient
                      ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 rounded-bl-sm'
                      : 'bg-blue-600 text-white rounded-br-sm'
                  }`}>
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                    <p className={`mt-1 text-[10px] ${fromPatient ? 'text-slate-400 dark:text-slate-500' : 'text-blue-100'}`}>
                      {ts ? format(new Date(ts), 'MMM d, h:mm a') : ''}
                    </p>
                  </div>
                </div>
              );
            })
          )}
          <div ref={endRef} />
        </div>

        <div className="flex items-center gap-2 px-3 py-2 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
            placeholder={`Message ${selected.full_name || 'patient'}...`}
            className="flex-1 h-10 px-3 rounded-lg border bg-white dark:bg-slate-800 text-sm outline-none focus:border-blue-500"
            style={{ borderColor: 'var(--border-slate-200)' }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="h-10 w-10 rounded-lg bg-blue-600 text-white flex items-center justify-center disabled:opacity-50"
            aria-label="Send message"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div className="p-2 border-b" style={{ borderColor: 'var(--border-slate-200)' }}>
        <div className="flex items-center gap-2 px-2 h-9 rounded-lg bg-slate-100 dark:bg-slate-800">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patients"
            className="flex-1 bg-transparent text-sm outline-none text-slate-700 dark:text-slate-200"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-1 px-6">
            <User className="w-7 h-7 text-slate-300 dark:text-slate-600" />
            <p className="text-sm text-slate-500 dark:text-slate-400">No patients found</p>
          </div>
        ) : (
          filtered.map((p) => {
            const stats = threadStats.get(p.id);
            const unread = stats?.unread || 0;
            return (
              <button
                key={p.id}
                onClick={() => openThread(p)}
                className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-800 border-b last:border-b-0"
                style={{ borderColor: 'var(--border-slate-200)' }}
              >
                <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                  <User className="w-4 h-4 text-slate-500 dark:text-slate-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate text-slate-900 dark:text-slate-100">{p.full_name || 'Patient'}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                    {stats?.lastText || (p.portal_login_count > 0 ? 'Uses the patient portal' : p.phone || '')}
                  </p>
                </div>
                {unread > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
