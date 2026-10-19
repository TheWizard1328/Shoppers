// API ISSUE BUS (owner spec Oct 14 2026): one choke point that describes every
// rate-limit / error the SDK hits on THIS device (kind, entity/function, method,
// short reason) and publishes it as a 'apiIssueDetected' window event. The
// owner-only IssueBalloon (below the heartbeat dot) renders it. Pure metadata —
// no network, no storage, zero API cost.

const ENTITY_RX = /\/entities\/([A-Za-z0-9_]+)/;
const FN_RX = /\/functions\/([A-Za-z0-9_]+)/;

export const describeTarget = (url, method) => {
  const u = String(url || '');
  const m = String(method || 'get').toUpperCase();
  const fn = u.match(FN_RX);
  if (fn) return { type: 'function', name: fn[1], method: m };
  const en = u.match(ENTITY_RX);
  if (en) return { type: 'entity', name: en[1], method: m };
  if (/\/auth|\/users\/me/.test(u)) return { type: 'auth', name: 'auth', method: m };
  return { type: 'other', name: u.split('?')[0].split('/').slice(-2).join('/') || 'unknown', method: m };
};

const briefReason = (error) => {
  const data = error?.response?.data;
  const raw = data?.detail || data?.message || data?.error || error?.message || 'Unknown error';
  return String(typeof raw === 'string' ? raw : JSON.stringify(raw)).replace(/\s+/g, ' ').slice(0, 90);
};

// Dedup the same target+kind within 4s so a 20-call burst shows as one balloon line
const lastSeen = new Map();

export const publishApiIssue = (error) => {
  try {
    if (typeof window === 'undefined') return;
    const cfg = error?.config || {};
    const status = Number(error?.response?.status || error?.status || 0);
    const msg = String(error?.message || '').toLowerCase();
    // 'config not initialized' (squareBalancesCompute 409) is the function's
    // own internal reads failing on a hot pool — the storm in disguise, not a
    // real config problem (owner report Oct 19 2026). Group it with the rate
    // limits instead of popping a misleading yellow ERROR badge.
    const isRate = status === 429 || msg.includes('rate limit') || msg.includes('config not initialized');
    if (!isRate && status > 0 && status < 400) return;
    // Auth refresh noise & aborted requests are not actionable
    if (error?.code === 'ERR_CANCELED') return;
    const target = describeTarget(cfg.url, cfg.method);
    const kind = isRate ? 'rate_limit' : 'error';
    const key = `${kind}:${target.type}:${target.name}:${target.method}`;
    const now = Date.now();
    if (now - (lastSeen.get(key) || 0) < 4000) return;
    lastSeen.set(key, now);
    if (lastSeen.size > 200) lastSeen.clear();
    window.dispatchEvent(new CustomEvent('apiIssueDetected', {
      detail: {
        at: now, kind, status: status || null, target,
        reason: isRate ? 'Rate limit exceeded' : briefReason(error),
        source: 'local'
      }
    }));
  } catch (_) { /* never break a request path */ }
};
