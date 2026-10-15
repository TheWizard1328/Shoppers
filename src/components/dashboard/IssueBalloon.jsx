/**
 * Issue Balloon (App Owner only) — owner spec Oct 14 2026.
 * Pops a small balloon under the heartbeat dot whenever a rate limit or error
 * occurs. Shows: RATE LIMIT vs ERROR, which entity/function (+ method), a very
 * brief reason, and user + device.
 *
 * SOURCES
 *  1. LOCAL  — 'apiIssueDetected' events from the axios choke point (this device,
 *              instant, knows entity/function from the request URL).
 *  2. REMOTE — RemoteLogEntry WS subscription (other users/devices). These rows are
 *              console text, so the target is parsed from the message when it names
 *              one ("429 on "City list"", "[Component] ..."), otherwise the source
 *              tag in brackets. Zero polling: reuses the existing WS broadcast.
 * Grouped: same kind+target+user within the window collapses into "x3".
 * Auto-hides ~8s after the last issue; tap to dismiss.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { base44 } from '@/api/base44Client';
import { isAppOwner } from '@/components/utils/userRoles';
import { getDeviceIdentifier } from '@/components/utils/deviceManager';

const MAX_LINES = 4;
const HIDE_AFTER_MS = 8000;
const REMOTE_DEDUP_MS = 6000;

const parseRemote = (rec) => {
  const msg = String(rec?.message || '');
  const level = rec?.level;
  const isRate = /429|rate.?limit/i.test(msg);
  if (!isRate && level !== 'error') return null;
  // Skip the SDK's follow-up "Error data: {...}" row and fallback chatter
  if (/^Error data:/i.test(msg)) return null;
  if (/server compute unavailable, using local compute/i.test(msg) && !isRate) return null;
  let name = null;
  const q = msg.match(/429 on "([^"]{1,60})"/);
  if (q) name = q[1];
  if (!name) { const br = msg.match(/^\W*\[([A-Za-z0-9_ .-]{2,40})\]/); if (br) name = /^Base44 SDK Error$/i.test(br[1]) ? 'API call (target not logged)' : br[1]; }
  if (!name) { const fn = msg.match(/\/(?:functions|entities)\/([A-Za-z0-9_]+)/); if (fn) name = fn[1]; }
  const reason = isRate ? 'Rate limit exceeded'
    : msg.replace(/^\W*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, 80);
  return {
    kind: isRate ? 'rate_limit' : 'error',
    target: { type: name ? 'source' : 'other', name: name || 'unknown source', method: '' },
    reason,
    user: rec?.user_name || null,
    device: rec?.metadata?.device_name || null,
    deviceId: rec?.device_identifier || null,
    at: Date.now(),
    source: 'remote'
  };
};

export default function IssueBalloon({ currentUser }) {
  const owner = isAppOwner(currentUser);
  const [items, setItems] = useState([]);
  const [anchor, setAnchor] = useState(null);
  const hideTimer = useRef(null);
  const wrapRef = useRef(null);
  const localDeviceRef = useRef({ name: null, id: null });
  const remoteSeen = useRef(new Map());

  const push = useCallback((issue) => {
    setItems((prev) => {
      const key = `${issue.kind}|${issue.target.type}|${issue.target.name}|${issue.target.method}|${issue.user || ''}|${issue.device || ''}`;
      const idx = prev.findIndex((p) => p.key === key);
      let next;
      if (idx >= 0) {
        next = prev.slice();
        next[idx] = { ...prev[idx], count: prev[idx].count + 1, at: issue.at };
        const [moved] = next.splice(idx, 1);
        next.unshift(moved);
      } else {
        next = [{ ...issue, key, count: 1 }, ...prev];
      }
      return next.slice(0, MAX_LINES);
    });
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setItems([]), HIDE_AFTER_MS);
  }, []);

  useEffect(() => {
    if (!owner) return undefined;
    try { localDeviceRef.current.id = getDeviceIdentifier(); } catch (_) {}
    (async () => {
      try {
        const { getCurrentDevice } = await import('@/components/utils/deviceManager');
        const rec = await getCurrentDevice(currentUser?.id);
        localDeviceRef.current.name = rec?.device_name || null;
      } catch (_) {}
    })();

    const onLocal = (e) => {
      const d = e.detail; if (!d) return;
      push({ ...d, user: currentUser?.full_name || 'You', device: localDeviceRef.current.name || 'This device' });
    };
    window.addEventListener('apiIssueDetected', onLocal);

    // Remote feed — WS only, no polling. Own-device rows are skipped (the local
    // path already showed them with better detail).
    let unsub = null;
    try {
      unsub = base44.entities.RemoteLogEntry.subscribe((event) => {
        const rec = event?.data;
        if (!rec || event?.type !== 'create') return;
        if (rec.device_identifier && rec.device_identifier === localDeviceRef.current.id) return;
        const issue = parseRemote(rec);
        if (!issue) return;
        const k = `${issue.kind}|${issue.target.name}|${issue.deviceId}`;
        const now = Date.now();
        if (now - (remoteSeen.current.get(k) || 0) < REMOTE_DEDUP_MS) return;
        remoteSeen.current.set(k, now);
        if (remoteSeen.current.size > 300) remoteSeen.current.clear();
        push(issue);
      });
    } catch (_) {}

    return () => {
      window.removeEventListener('apiIssueDetected', onLocal);
      try { unsub?.(); } catch (_) {}
      clearTimeout(hideTimer.current);
    };
  }, [owner, currentUser?.id, currentUser?.full_name, push]);

  // Anchor under the heartbeat dot (ConnectionIndicator's pulsing dot)
  useEffect(() => {
    if (!items.length) return;
    const dot = wrapRef.current?.parentElement?.querySelector('.animate-pulse.rounded-full') || wrapRef.current;
    const r = dot?.getBoundingClientRect?.();
    if (r) setAnchor({ left: r.left + r.width / 2, top: r.bottom });
  }, [items]);

  if (!owner) return null;
  return (
    <span ref={wrapRef} style={{ display: 'contents' }}>
      {items.length > 0 && anchor && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => setItems([])}
          style={{
            position: 'fixed', top: anchor.top + 8,
            left: Math.max(8, Math.min(anchor.left - 24, window.innerWidth - 300)),
            width: 290, zIndex: 10001,
          }}
          className="rounded-xl border border-slate-600 bg-slate-900/95 shadow-xl text-xs text-slate-100 p-2 space-y-1.5"
        >
          <div
            style={{ position: 'absolute', top: -6, left: 18, width: 12, height: 12, transform: 'rotate(45deg)' }}
            className="bg-slate-900/95 border-l border-t border-slate-600"
          />
          {items.map((it) => (
            <div key={it.key} className="leading-tight">
              <div className="flex items-center gap-1.5 max-w-[75px]">
                <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] ${it.kind === 'rate_limit' ? 'bg-red-600 text-white' : 'bg-amber-500 text-black'}`}>
                  {it.kind === 'rate_limit' ? 'RATE LIMIT' : 'ERROR'}
                </span>
                <span className="font-semibold truncate">
                  {it.target.type === 'function' ? 'fn ' : it.target.type === 'entity' ? '' : ''}
                  {it.target.name}{it.target.method ? ` · ${it.target.method}` : ''}
                </span>
                {it.count > 1 && <span className="ml-auto text-slate-400">x{it.count}</span>}
              </div>
              {it.kind === 'error' && <div className="text-slate-300 truncate">{it.reason}</div>}
              <div className="text-slate-400 truncate">{[it.user, it.device].filter(Boolean).join(' · ') || 'unknown user/device'}</div>
            </div>
          ))}
        </div>,
        document.body
      )}
    </span>
  );
}
