import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { X, Send, Loader2, MessageSquare, ArrowLeft, Store, Car, RefreshCw, Search } from 'lucide-react';
import { format } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';
import DriverDutyBadge, { normalizeDriverDuty } from '@/components/messaging/DriverDutyBadge';
import {
  loadDriverDirectory,
  patientConversationId,
  driverThreadConversationId,
  sendPatientMessageToDriver,
  markDriverThreadRead,
  searchPatientDirectory,
  sendPatientMessageToStore,
  markStoreThreadRead,
} from '@/components/messaging/patientThreads';

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

export default function PatientMessaging({ patient, open, onClose, onUnreadChange, stores = [] }) {
  const patientId = patient?.id;
  // SEARCH (owner request Nov 3 2026): ONE field filters the whole list — it
  // matches drivers by name or duty word ("on duty") and the pharmacy by store
  // name or abbreviation, so the patient types once and both sections narrow.
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]);
  const [drivers, setDrivers] = useState([]);
  // FULL DIRECTORY (owner request Nov 3 2026): every active driver and store from
  // AppUser/Store, not just the ones this patient already had a delivery with.
  const [directoryDrivers, setDirectoryDrivers] = useState([]);
  const [directoryStores, setDirectoryStores] = useState([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(null); // { kind: 'store', store } | { kind: 'driver', driver }
  // ANCHOR (owner request Nov 3 2026): the panel is a drop-down that hangs off the
  // header's message button and stays locked to that top corner, instead of a
  // centred modal / bottom sheet that appeared somewhere else on the screen.
  const [anchor, setAnchor] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const el = document.querySelector('[data-patient-msg-btn]');
      if (!el) { setAnchor(null); return; }
      const rect = el.getBoundingClientRect();
      setAnchor({
        top: Math.max(8, Math.round(rect.bottom + 8)),
        // Panel's right edge sits on the button's right edge (clamped to 8px so a
        // narrow phone never pushes it off screen).
        right: Math.round(Math.max(8, window.innerWidth - rect.right)),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    const header = document.querySelector('[data-patient-header]');
    header?.addEventListener('scroll', measure, { passive: true });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      header?.removeEventListener('scroll', measure);
    };
  }, [open]);

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
      const [directory, full] = await Promise.all([
        loadDriverDirectory(patientId),
        searchPatientDirectory({ patientId, query: '' }),
      ]);
      setDrivers(directory.drivers || []);
      setDirectoryDrivers(full.drivers || []);
      setDirectoryStores(full.stores || []);
    }, 60000);
    return () => clearInterval(timer);
  }, [open, patientId]);

  // Debounced directory search: the field filters the full AppUser driver list
  // and the store list, so typing reaches someone who never delivered here.
  useEffect(() => {
    if (!open || !patientId) return undefined;
    setSearching(true);
    const timer = setTimeout(async () => {
      const full = await searchPatientDirectory({ patientId, query });
      setDirectoryDrivers(full.drivers || []);
      setDirectoryStores(full.stores || []);
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [open, patientId, query]);

  // Store threads are told apart by Message.store_id, so each pharmacy keeps its
  // own conversation (matches the backend sendStore/markStoreRead scoping).
  const storeKeyOf = (storeId) => `store:${storeId || ''}`;
  const threadKey = (m) => (m.driver_id ? `driver:${m.driver_id}` : storeKeyOf(m.store_id));
  const activeKey = active
    ? (active.kind === 'driver' ? `driver:${active.driver.driver_id}` : storeKeyOf(active.store?.store_id))
    : null;

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

  const markRead = useCallback(async (driverId, storeId) => {
    if (driverId) {
      await markDriverThreadRead({ patientId, driverId }).catch(() => {});
    } else if (storeId) {
      await markStoreThreadRead({ patientId, storeId }).catch(() => {});
    } else {
      await base44.functions.invoke('patientPush', {
        action: 'patientMarkRead',
        patient_id: patientId,
      }).catch(() => {});
    }
    setMessages((prev) => prev.map((m) => {
      const key = threadKey(m);
      const target = driverId ? `driver:${driverId}` : storeKeyOf(storeId);
      return key === target && !m.read && m.sender_id !== patientSender(patientId) ? { ...m, read: true } : m;
    }));
  }, [patientId]);

  const openStoreThread = (store) => {
    setActive({ kind: 'store', store });
    markRead(null, store?.store_id);
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
      const targetStoreId = active?.kind === 'store' ? active.store?.store_id : '';
      let created = null;
      if (targetDriverId) {
        created = await sendPatientMessageToDriver({ patientId, driverId: targetDriverId, content: text });
      } else if (targetStoreId) {
        // Only the chosen pharmacy's staff is alerted.
        created = await sendPatientMessageToStore({ patientId, storeId: targetStoreId, content: text });
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
    } catch (err) {
      // Show the real reason (driver unavailable, store missing) — a blanket
      // "try again" hid a permission failure and looked like a network blip.
      const raw = String(err?.message || '');
      const friendly = /not available to message/i.test(raw)
        ? 'That driver cannot be messaged right now.'
        : (/send_failed|Failed to fetch|network/i.test(raw) || !raw
          ? 'Message not sent. Please try again.'
          : raw);
      setError(friendly);
    } finally {
      setSending(false);
    }
  };

  // ── LIST BUILD (owner request Nov 3 2026) ────────────────────────────────
  // Stores come from the full Store list (home pharmacy first). Drivers are the
  // full AppUser driver list from the search, PLUS any driver who delivered to
  // this patient before (so an off-duty driver never disappears from the list).
  const needle = query.trim().toLowerCase();
  const patientStore = (stores || []).find((st) => String(st?.id) === String(patient?.store_id));
  const homeStoreRow = {
    store_id: patient?.store_id || patientStore?.id || '',
    name: patientStore?.name || patientStore?.store_name || 'My pharmacy',
    abbreviation: String(patientStore?.abbreviation || patientStore?.store_abbreviation || '').toUpperCase(),
    is_home: true,
  };

  // The inbox lists the home pharmacy plus any pharmacy this patient has had a
  // delivery from. Every other store only appears while searching for it.
  const homeRow = useMemo(() => ({
    store_id: homeStoreRow.store_id,
    name: homeStoreRow.name,
    abbreviation: homeStoreRow.abbreviation,
    is_home: true,
    is_prior: false,
  }), [homeStoreRow.store_id, homeStoreRow.name, homeStoreRow.abbreviation]);

  const visibleStores = useMemo(() => {
    if (!needle) {
      // Home row, then each past pharmacy (from the server's is_prior flag).
      return [homeRow, ...(directoryStores || []).filter((st) => !st.is_home)]
        .filter((row, index, arr) => row?.store_id
          && arr.findIndex((other) => String(other.store_id) === String(row.store_id)) === index);
    }
    const rows = [homeRow, ...(directoryStores || [])];
    const seen = new Set();
    return rows.filter((row) => {
      if (!row?.store_id) return false;
      const key = String(row.store_id);
      if (seen.has(key)) return false;
      seen.add(key);
      return `${row.name || ''} ${row.abbreviation || ''} pharmacy`.toLowerCase().includes(needle);
    });
  }, [needle, homeRow, directoryStores]);

  const driverRows = useMemo(() => {
    const byId = new Map();
    for (const d of directoryDrivers || []) {
      if (d?.driver_id) byId.set(String(d.driver_id), { ...d });
    }
    for (const d of drivers || []) {
      if (!d?.driver_id) continue;
      const key = String(d.driver_id);
      if (byId.has(key)) {
        byId.set(key, { ...d, ...byId.get(key), is_prior: true });
      } else {
        byId.set(key, { ...d, is_prior: true });
      }
    }
    return Array.from(byId.values());
  }, [directoryDrivers, drivers]);

  const visibleDrivers = (needle
    ? driverRows.filter((d) => {
        const hay = `${d.driver_name || ''} ${d.duty_status || ''}`.toLowerCase();
        return hay.includes(needle) || hay.replace(/_/g, ' ').includes(needle);
      })
    // No search: an inbox entry only exists for a driver this patient has had.
    : driverRows.filter((d) => d.is_prior || d.is_current)
  ).sort((a, b) => {
    const rank = (d) => (d?.is_current ? 0 : (d?.duty_status === 'on_duty' ? 1 : (d?.duty_status === 'on_break' ? 2 : (d?.is_prior ? 3 : 4))));
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return String(a.driver_name || '').localeCompare(String(b.driver_name || ''));
  });

  const hasNoMatches = visibleDrivers.length === 0 && visibleStores.length === 0;

  // Closed sheet: bail AFTER every hook has run (conditional hooks would break
  // the component the first time the sheet is reopened).
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
    <div className="fixed inset-0 z-[1200]" onClick={onClose}>
      {/* No dark backdrop: the map stays readable behind the drop-down. */}
      <div
        className="fixed w-[min(380px,calc(100vw-1rem))] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden origin-top-right animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-150"
        style={{
          top: anchor?.top ?? 64,
          right: anchor?.right ?? 8,
          height: `min(70vh, 560px)`,
          maxHeight: `calc(100vh - ${(anchor?.top ?? 64) + 12}px)`,
        }}
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
                ? (active.kind === 'driver' ? (active.driver.driver_name || 'Your driver') : (active.store?.name || 'Pharmacy'))
                : 'Messages'}
            </p>
            {active ? (
              active.kind === 'driver' ? (
                <div className="mt-0.5">
                  <DriverDutyBadge status={active.driver.duty_status} size="xs" />
                </div>
              ) : (
                <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                  {active.store?.abbreviation ? `${active.store.abbreviation} · ` : ''}Every dispatcher at this pharmacy sees this
                </p>
              )
            ) : (
              <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                {searching ? 'Searching all drivers and stores…' : 'Message a pharmacy or an active driver'}
              </p>
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
            {/* SEARCH FIELD (owner request Nov 3 2026): a single field filters
                drivers and the pharmacy together. */}
            <div className="px-3 pt-3 pb-2 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 sticky top-0 z-10">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search drivers or pharmacy"
                  className="w-full h-9 pl-8 pr-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 outline-none focus:border-blue-500"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"
                    aria-label="Clear search"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
            {loading ? (
              <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
            ) : (
              <>
                {hasNoMatches && (
                  <p className="px-4 py-4 text-xs text-slate-400 dark:text-slate-500">
                    Nothing matches "{query.trim()}". Try a driver's name, or the pharmacy name or short code.
                  </p>
                )}
                {/* Pharmacy threads — one row per store, home pharmacy first */}
                {visibleStores.map((store) => {
                  const key = `store:${store.store_id}`;
                  const s2 = stats.get(key);
                  return (
                    <button
                      key={store.store_id}
                      onClick={() => openStoreThread(store)}
                      className="w-full text-left px-3 py-3 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <div className="w-9 h-9 rounded-full bg-slate-900 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                        <Store className="w-4 h-4 text-white" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                            {store.name || 'Pharmacy'}
                          </p>
                          {store.abbreviation && (
                            <span className="text-[10px] font-bold px-1.5 h-4 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 flex items-center">
                              {store.abbreviation}
                            </span>
                          )}
                          {store.is_home ? (
                            <span className="text-[10px] font-medium px-1.5 h-4 rounded-full bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300 flex items-center">
                              My pharmacy
                            </span>
                          ) : store.is_prior ? (
                            <span className="text-[10px] font-medium px-1.5 h-4 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 flex items-center">
                              Past pharmacy
                            </span>
                          ) : null}
                        </div>
                        <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                          {s2?.lastText || (store.is_home || store.is_prior ? 'All dispatchers at this pharmacy' : 'Search result')}
                        </p>
                      </div>
                      {(s2?.unread || 0) > 0 && (
                        <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                          {s2.unread > 9 ? '9+' : s2.unread}
                        </span>
                      )}
                    </button>
                  );
                })}

                {/* Driver threads */}
                {visibleDrivers.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-slate-400 dark:text-slate-500">
                    {query.trim() ? 'No drivers match that search.' : 'No drivers are on duty right now.'}
                  </p>
                ) : (
                  visibleDrivers.map((driver) => {
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
                            {s?.lastText || (driver.is_current
                              ? 'Your driver today'
                              : (driver.is_prior ? 'Delivered to you before' : 'On duty now'))}
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
