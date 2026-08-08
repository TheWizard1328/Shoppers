/**
 * Message Rule Engine — IF / THEN evaluation for MessageRule entity
 *
 * Phase 1: New system sits alongside existing NotificationTemplate.
 * Rules are only evaluated when they exist for an event; otherwise the
 * old system handles it (fallback in the dispatch caller).
 */

import { base44 } from '@/api/base44Client';

// ── In-memory cache of enabled rules, keyed by event_name ──────────────────
let _ruleCache = null;
let _cacheLoadedAt = 0;
const CACHE_TTL = 30_000; // 30 seconds

// ── Cooldown tracking (in-memory, per rule + recipient) ────────────────────
const _lastFiredAt = new Map(); // key: `${ruleId}:${recipient}` → timestamp

function cooldownKey(ruleId, recipient) {
  return `${ruleId}:${recipient}`;
}

export function isInCooldown(rule, recipient, now = Date.now()) {
  if (!rule.cooldown_seconds || rule.cooldown_seconds <= 0) return false;
  const key = cooldownKey(rule.id, recipient);
  const last = _lastFiredAt.get(key) || 0;
  const elapsed = (now - last) / 1000;
  if (elapsed < rule.cooldown_seconds) return true;
  return false;
}

export function markFired(rule, recipient, now = Date.now()) {
  if (!rule.cooldown_seconds || rule.cooldown_seconds <= 0) return;
  const key = cooldownKey(rule.id, recipient);
  _lastFiredAt.set(key, now);
}

// ── Condition evaluation ───────────────────────────────────────────────────

const TRUTHY = ['true', '1', 'yes', 'on'];

function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return TRUTHY.includes(v.toLowerCase());
  return !!v;
}

function coerceNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

export function evaluateCondition(condition, context) {
  if (!condition || !condition.field) return true; // no field = always pass

  const fieldVal = context[condition.field];
  const condVal = condition.value;

  // "All" wildcard for user_role / delivery_status — condition always passes
  if ((condition.field === 'user_role' || condition.field === 'delivery_status') && String(condVal ?? '') === 'all') return true;

  switch (condition.operator) {
    case 'equals':
      return String(fieldVal ?? '') === String(condVal ?? '');
    case 'not_equals':
      return String(fieldVal ?? '') !== String(condVal ?? '');
    case 'greater_than':
      return coerceNum(fieldVal) > coerceNum(condVal);
    case 'less_than':
      return coerceNum(fieldVal) < coerceNum(condVal);
    case 'is_true':
      return coerceBool(fieldVal);
    case 'is_false':
      return !coerceBool(fieldVal);
    case 'in_list': {
      const ids = (condVal || '').split(',').map((v) => v.trim()).filter(Boolean);
      const fv = String(fieldVal ?? '');
      return ids.includes(fv);
    }
    case 'not_in_list': {
      const ids = (condVal || '').split(',').map((v) => v.trim()).filter(Boolean);
      const fv = String(fieldVal ?? '');
      return !ids.includes(fv);
    }
    default:
      return true;
  }
}

export function evaluateAllConditions(conditions, context) {
  if (!conditions || conditions.length === 0) return true; // no conditions = always pass
  return conditions.every((c) => evaluateCondition(c, context));
}

// ── Rule loading ───────────────────────────────────────────────────────────

export async function loadEnabledRules(force = false) {
  const now = Date.now();
  if (_ruleCache && (now - _cacheLoadedAt) < CACHE_TTL && !force) {
    return _ruleCache;
  }
  try {
    const all = await base44.entities.MessageRule.filter({ enabled: true });
    const byEvent = {};
    (all || []).forEach((r) => {
      if (!r.event_name) return;
      if (!byEvent[r.event_name]) byEvent[r.event_name] = [];
      byEvent[r.event_name].push(r);
    });
    // Sort each event's rules by priority (ascending)
    Object.values(byEvent).forEach((arr) => arr.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999)));
    _ruleCache = byEvent;
    _cacheLoadedAt = now;
    return byEvent;
  } catch (e) {
    console.error('[MessageRuleEngine] Failed to load rules:', e);
    return _ruleCache || {};
  }
}

export function clearRuleCache() {
  _ruleCache = null;
  _cacheLoadedAt = 0;
}

// ── Template variable substitution ─────────────────────────────────────────

export function renderTemplate(template, context) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = context[key];
    if (val === undefined || val === null) return '';
    return String(val);
  });
}

// ── Recipient resolution ───────────────────────────────────────────────────

/**
 * Resolve recipient strings to user IDs.
 * Supports formats:
 *   "role:admin"       → all users with admin role
 *   "role:dispatcher"  → all dispatchers
 *   "role:driver"      → all drivers
 *   "relation:driver"  → the driver assigned to the delivery (from context.driver_id)
 *   "relation:dispatchers" → dispatchers for the delivery's store
 *   "relation:appowner" → the app owner
 *   "user:USER_ID"     → specific user
 */
export async function resolveRecipients(recipientStrings, context, appUsers = null) {
  const userIds = new Set();

  // Try to get app users if not provided. Hard-defensive: ensure `users` is
  // ALWAYS an array — if AppUser.list returns null without throwing, the
  // subsequent `users.forEach(...)` calls would crash the engine, propagate
  // out of `dispatchMessageRules`, and signal `handled=false` to the caller,
  // silently defaulting to the legacy notification system.
  let users = Array.isArray(appUsers) ? appUsers : null;
  if (!users) {
    try {
      const list = await base44.entities.AppUser.list('sort_order', 200, null,
        'id,user_id,user_name,app_roles,status,store_ids,role');
      users = Array.isArray(list) ? list : [];
    } catch { users = []; }
  }

  for (const r of recipientStrings || []) {
    if (!r) continue;

    if (r.startsWith('role:')) {
      const role = r.slice(5);
      users.forEach((u) => {
        if (u.status === 'inactive') return;
        const roles = u.app_roles || (u.role ? [u.role] : []);
        if (Array.isArray(roles) && roles.includes(role)) {
          userIds.add(u.user_id || u.id);
        }
      });
    } else if (r.startsWith('relation:')) {
      const rel = r.slice(9);
      if (rel === 'driver' && context.driver_id) {
        userIds.add(context.driver_id);
      } else if (rel === 'appowner') {
        // App owner is typically the first admin or has a specific flag
        const owner = users.find((u) => u.app_roles?.includes('admin'));
        if (owner) userIds.add(owner.user_id || owner.id);
      } else if (rel === 'dispatchers' && context.store_id) {
        users.forEach((u) => {
          if (u.status === 'inactive') return;
          const roles = u.app_roles || [];
          if (roles.includes('dispatcher') || roles.includes('admin')) {
            const storeIds = u.store_ids || [];
            if (storeIds.includes(context.store_id)) {
              userIds.add(u.user_id || u.id);
            }
          }
        });
      }
    } else if (r.startsWith('user:')) {
      userIds.add(r.slice(5));
    } else {
      // Bare string — treat as user ID
      userIds.add(r);
    }
  }

  return [...userIds];
}

// ── Main dispatch ──────────────────────────────────────────────────────────

/**
 * Evaluate MessageRules for a given event.
 * Returns { handled: boolean, matchedRules: array, results: array }.
 *
 * handled = true means at least one rule matched and was dispatched.
 * The caller should check `handled` — if false, fall back to old system.
 *
 * @param {string} eventName - The event key (e.g. 'driver_completed')
 * @param {object} context - The event context (driverName, patientName, store_id, etc.)
 * @param {function} sendInApp - Callback(userId, message, eventName) for in-app
 * @param {function} sendPush - Callback(userId, message, eventName) for push
 * @returns {Promise<{handled, matchedRules, results}>}
 */
export async function dispatchMessageRules(eventName, context = {}, sendInApp = null, sendPush = null) {
  const rulesByEvent = await loadEnabledRules();
  const rules = rulesByEvent[eventName];

  if (!rules || rules.length === 0) {
    return { handled: false, matchedRules: [], results: [] };
  }

  const results = [];
  const matchedRules = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const conditionsMatch = evaluateAllConditions(rule.conditions, context);
    if (!conditionsMatch) continue;

    matchedRules.push(rule);

    // Resolve recipients
    const recipientIds = await resolveRecipients(rule.recipients, context);

    // Render message
    const message = renderTemplate(rule.message_template, context);

    // Send to each recipient via specified channels
    for (const userId of recipientIds) {
      // Cooldown check
      if (isInCooldown(rule, userId)) {
        results.push({ ruleId: rule.id, userId, skipped: 'cooldown' });
        continue;
      }
      markFired(rule, userId);

      const isShadow = rule.shadow_mode;
      const channels = rule.channels || ['in_app'];

      if (!isShadow) {
        if (channels.includes('in_app') && sendInApp) {
          try { await sendInApp(userId, message, eventName, rule); }
          catch (e) { console.error('[MessageRuleEngine] in_app send failed:', e); }
        }
        if (channels.includes('push') && sendPush) {
          try { await sendPush(userId, message, eventName, rule); }
          catch (e) { console.error('[MessageRuleEngine] push send failed:', e); }
        }
      } else {
        console.log(`[MessageRuleEngine] SHADOW MODE — would send to ${userId}: "${message}" via ${channels.join(', ')}`);
      }

      results.push({ ruleId: rule.id, userId, channels, message, shadow: isShadow });
    }

    // If stop_on_match, stop evaluating further rules for this event
    if (rule.stop_on_match) break;
  }

  return {
    handled: matchedRules.length > 0,
    matchedRules,
    results,
  };
}

// ── Subscribe to rule changes (live cache invalidation) ───────────────────

let _subscribed = false;
export function subscribeToRuleChanges() {
  if (_subscribed) return;
  try {
    const unsub = base44.entities.MessageRule.subscribe((event) => {
      // Invalidate cache on any change
      clearRuleCache();
    });
    _subscribed = true;
    // Return unsubscribe for cleanup
    return () => { try { unsub(); _subscribed = false; } catch {} };
  } catch { return () => {}; }
}