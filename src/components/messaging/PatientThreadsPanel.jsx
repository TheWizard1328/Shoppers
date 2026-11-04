import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Send, Search, ArrowLeft, User, MessageSquare, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';
import {
  loadPatientThreadMessages,
  sendStaffMessageToPatient,
  loadDriverPatientThreads,
  sendDriverMessageToPatient,
  sendStaffMessageToDriverThread,
  loadDriverDirectory,
  isPatientSender,
  staffStoreIds,
  staffSeesAllStores,
} from './patientThreads';
import { searchPatientsIdb } from './patientSearchIdb';
import DriverDutyBadge from './DriverDutyBadge';
import { userHasRole, isAppOwner } from '@/components/utils/userRoles';

/**
 * PatientThreadsPanel — staff side of the patient portal chat (owner build
 * Nov 2 2026). Lists patients of the staff member's store(s) with an unread
 * count, opens the thread, and pushes the reply to the patient's devices.
 */
export default function PatientThreadsPanel({ currentUser, stores = [], onUnreadCountChange, initialPatientId = null }) {
  const [messages, setMessages] = useState([]);
  // SEARCH RESULTS (owner request Nov 3 2026): resolved from IndexedDB, scoped
  // by role — store sees its own patients, a driver only the patients on the
  // active route, an admin anyone.
  const [searchResults, setSearchResults] = useState([]);
  const [searchNote, setSearchNote] = useState('');
  const [selected, setSelected] = useState(null);
  // Tell the panel when a chat is open so the tabs-row search can step aside.
  useEffect(() => { onSelectionChange?.(!!selected); }, [selected, onSelectionChange]);
  const [localSearch, setLocalSearch] = useState('');
  const search = controlledSearch !== undefined ? controlledSearch : localSearch;
  const setSearch = onSearchChange || setLocalSearch;
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [thread, setThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  // THREAD PICKER (owner report Nov 3 2026): a patient thread and each
  // patient↔driver thread are separate conversations. They used to be merged
  // into one list, so a message sent to a driver looked like it went to the
  // pharmacy team, and every staff reply was forced into the store thread.
  const [threadSel, setThreadSel] = useState('store'); // 'store' | driverId
  const [driverDir, setDriverDir] = useState([]);
  const [storeRows, setStoreRows] = useState(stores || []);
  const unreadContributedRef = useRef(0);
  const endRef = useRef(null);
  const selectedRef = useRef(null);
  // Helper keeps the deep-link effect dependency-free of the selected state.
  const patientIdHandled = (id) => selected?.id === id;

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

  // DRIVERS (owner request Nov 2 2026): a driver only ever sees the patient
  // threads they are part of, and may message the patients on their own
  // deliveries. Dispatchers/admins keep the store-wide view.
  const isDriverMode = useMemo(
    () => userHasRole(currentUser, 'driver')
      && !userHasRole(currentUser, 'dispatcher')
      && !userHasRole(currentUser, 'admin'),
    [currentUser]
  );

  // A staff member sees a patient ONLY once a thread exists with them: the list
  // is built from thread messages, so the whole patient roster is never loaded
  // (that lookup per store was hammering the online patient table).
  const patients = useMemo(() => {
    const byId = new Map();
    for (const m of messages || []) {
      const pid = m?.patient_id;
      if (!pid) continue;
      const nameFromRow = isPatientSender(m.sender_id) ? m.sender_name : m.receiver_name;
      const entry = byId.get(pid) || { id: pid, full_name: '', phone: '', store_id: m.store_id || '' };
      if (!entry.full_name && nameFromRow) entry.full_name = nameFromRow;
      if (!entry.store_id && m.store_id) entry.store_id = m.store_id;
      byId.set(pid, entry);
    }
    return Array.from(byId.values());
  }, [messages]);

  // Delivery.driver_id = AUTH user id, which is AppUser.user_id.
  const driverId = currentUser?.user_id || currentUser?.id;
  const searchMode = isDriverMode ? 'driver' : (staffSeesAllStores(currentUser) ? 'admin' : 'store');

  const loadAll = useCallback(async () => {
    setLoading(true);
    const messageRows = isDriverMode
      ? await loadDriverPatientThreads(currentUser)
      : await loadPatientThreadMessages(currentUser);
    setMessages(messageRows || []);
    setLoading(false);
  }, [currentUser, isDriverMode]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // LOCAL SEARCH ONLY — IndexedDB, zero network calls, so typing never spends
  // the API rate budget.
  useEffect(() => {
    const q = String(search || '').trim();
    if (q.length < 2) { setSearchResults([]); setSearchNote(''); return undefined; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await searchPatientsIdb({ user: currentUser, query: q, mode: searchMode, driverId });
      if (cancelled) return;
      setSearchResults(res?.patients || []);
      setSearchNote(res?.routeActive === false ? (res?.reason || '') : '');
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, currentUser, searchMode, driverId]);

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
    if (!patient?.id) return;
    setSelected(patient);
    setThreadSel('store');
    setThreadLoading(true);
    if (!isDriverMode) {
      loadDriverDirectory(patient.id)
        .then((dir) => setDriverDir(dir.drivers || []))
        .catch(() => setDriverDir([]));
    }
    try {
      const query = isDriverMode
        ? { patient_id: patient.id, driver_id: driverId }
        : { patient_id: patient.id };
      const rows = await base44.entities.Message.filter(query, '-created_date', 200);
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
  }, [isDriverMode, driverId]);

  useEffect(() => {
    if (selected) endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [selected, thread.length]);

  // Deep link (push notification / balloon): open the requested thread once the
  // patient list is available.
  const deepLinkRef = useRef('');
  useEffect(() => {
    if (!initialPatientId || patientIdHandled(initialPatientId) || loading) return;
    if (deepLinkRef.current === initialPatientId) return;
    const existing = (patients || []).find((p) => p.id === initialPatientId);
    if (existing) {
      deepLinkRef.current = initialPatientId;
      openThread(existing);
      return;
    }
    // Patient may not be in the loaded list (driver mode) — fetch directly.
    deepLinkRef.current = initialPatientId;
    base44.entities.Patient.get(initialPatientId)
      .then((row) => { if (row?.id) openThread(row); })
      .catch(() => {});
  }, [initialPatientId, loading, patients, openThread]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || !selected) return;
    setSending(true);
    try {
      const pickedDriver = threadSel !== 'store' ? threadSel : null;
      const created = isDriverMode
        ? await sendDriverMessageToPatient({ user: currentUser, patient: selected, content: text, storeName })
        : pickedDriver
          ? await sendStaffMessageToDriverThread({
              user: currentUser,
              patient: selected,
              driverId: pickedDriver,
              driverName: (driverDir || []).find((d) => String(d.driver_id) === String(pickedDriver))?.driver_name,
              content: text,
              storeName,
            })
          : await sendStaffMessageToPatient({ user: currentUser, patient: selected, content: text, storeName });
      setInput('');
      if (created?.id) setThread((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
    } catch { /* the thread still shows the error state via input retention */ } finally {
      setSending(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const seen = new Set();
    const merged = [...(patients || []), ...(searchResults || [])].filter((p) => {
      if (!p?.id || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    const list = merged.filter((p) => {
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
  }, [patients, searchResults, search, threadStats]);

  // Staff thread picker: the pharmacy thread plus one entry per driver thread.
  const staffThreads = useMemo(() => {
    if (isDriverMode || !selected) return [];
    const ids = new Set();
    (thread || []).forEach((m) => { if (m?.driver_id) ids.add(String(m.driver_id)); });
    (driverDir || []).forEach((d) => { if (d?.is_current && d?.driver_id) ids.add(String(d.driver_id)); });
    return Array.from(ids).map((id) => {
      const dir = (driverDir || []).find((d) => String(d.driver_id) === id);
      const last = (thread || []).find((m) => String(m.driver_id) === id);
      return {
        id,
        name: dir?.driver_name || last?.receiver_name || 'Driver',
        duty: dir?.duty_status || 'off_duty',
      };
    });
  }, [isDriverMode, selected, thread, driverDir]);

  const visibleThread = useMemo(() => {
    if (isDriverMode) return thread || [];
    if (threadSel === 'store') return (thread || []).filter((m) => !m.driver_id);
    return (thread || []).filter((m) => String(m.driver_id) === String(threadSel));
  }, [thread, threadSel, isDriverMode]);

  const activeThreadName = threadSel === 'store'
    ? 'Pharmacy team'
    : (staffThreads.find((t) => t.id === String(threadSel))?.name || 'Driver');

  // DELETE (owner request Nov 4 2026): ONLY the AppOwner may remove a patient
  // message or a whole patient thread from the pharmacy side.
  const canDelete = isAppOwner(currentUser);
  const deleteMessage = async (m) => {
    if (!canDelete || !m?.id) return;
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await base44.entities.Message.delete(m.id);
      setMessages((prev) => prev.filter((x) => x.id !== m.id));
    } catch { window.alert('Could not delete that message.'); }
  };
  const deleteVisibleThread = async () => {
    if (!canDelete || !selected || visibleThread.length === 0) return;
    if (!window.confirm('Delete this entire thread for everyone? This cannot be undone.')) return;
    try {
      let deleted = 0;
      for (const m of visibleThread) {
        try { await base44.entities.Message.delete(m.id); deleted += 1; } catch { /* keep going */ }
      }
      setMessages((prev) => prev.filter((x) => !visibleThread.some((v) => v.id === x.id)));
      if (deleted > 0) setThreadSel('store');
    } catch { window.alert('Could not delete that thread.'); }
  };

  if (selected) {
    return (
      <div className="flex flex-col h-full w-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <button onClick={() => { setSelected(null); setInput(''); }} className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-800" aria-label="Back">
            <ArrowLeft className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate text-slate-900 dark:text-slate-100">{selected.full_name}</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{activeThreadName}</p>
          </div>
          {!isDriverMode && threadSel !== 'store' && (
            <DriverDutyBadge
              status={staffThreads.find((t) => t.id === String(threadSel))?.duty || 'off_duty'}
              size="xs"
            />
          )}
          {canDelete && (
            <button
              onClick={deleteVisibleThread}
              className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-800 hover:bg-red-50 dark:hover:bg-red-950/40"
              aria-label="Delete this thread"
              title="Delete this whole thread"
            >
              <Trash2 className="w-4 h-4 text-red-500" />
            </button>
          )}
        </div>

        {/* THREAD PICKER — pharmacy thread and each driver thread are separate */}
        {!isDriverMode && (
          <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
            <button
              onClick={() => setThreadSel('store')}
              className={`h-7 px-2.5 rounded-full text-xs font-medium whitespace-nowrap border ${threadSel === 'store'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'}`}
            >
              Pharmacy team
            </button>
            {staffThreads.map((t) => (
              <button
                key={t.id}
                onClick={() => setThreadSel(t.id)}
                className={`h-7 px-2.5 rounded-full text-xs font-medium whitespace-nowrap border flex items-center gap-1.5 ${String(threadSel) === t.id
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'}`}
              >
                {t.name}
                <DriverDutyBadge status={t.duty} size="xs" />
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-slate-50 dark:bg-slate-950/40">
          {threadLoading ? (
            <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : visibleThread.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-1 px-6">
              <MessageSquare className="w-7 h-7 text-slate-300 dark:text-slate-600" />
              <p className="text-sm text-slate-500 dark:text-slate-400">No messages yet</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">Send the first message — it is pushed to the patient's devices.</p>
            </div>
          ) : (
            visibleThread.map((m) => {
              const fromPatient = isPatientSender(m.sender_id);
              const ts = parseEntityTimestamp?.(m.created_date) || m.created_date;
              return (
                <div key={m.id} className={`flex items-center gap-1 ${fromPatient ? 'justify-start' : 'justify-end'}`}>
                  {canDelete && fromPatient && (
                    <button
                      onClick={() => deleteMessage(m)}
                      className="w-6 h-6 flex-shrink-0 rounded-full flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                      aria-label="Delete message"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
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
                  {canDelete && !fromPatient && (
                    <button
                      onClick={() => deleteMessage(m)}
                      className="w-6 h-6 flex-shrink-0 rounded-full flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                      aria-label="Delete message"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })
          )}
          <div ref={endRef} />
        </div>

        <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
            placeholder={`Message ${selected.full_name || 'patient'}...`}
            className="flex-1 h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:border-blue-500"
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
      <div className={controlledSearch !== undefined ? 'hidden' : 'p-2 border-b border-slate-200 dark:border-slate-700'}>
        <div className="flex items-center gap-2 px-2 h-9 rounded-lg bg-slate-100 dark:bg-slate-800">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isDriverMode ? 'Search your route patients' : 'Search your patients'}
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
            <p className="text-xs text-slate-400 dark:text-slate-500 text-center">
              {searchNote || (search.trim().length >= 2
                ? 'Search runs on this device only.'
                : 'Threads appear once you have messaged a patient.')}
            </p>
          </div>
        ) : (
          filtered.map((p) => {
            const stats = threadStats.get(p.id);
            const unread = stats?.unread || 0;
            return (
              <button
                key={p.id}
                onClick={() => openThread(p)}
                className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-slate-200 dark:border-slate-700 last:border-b-0"
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
