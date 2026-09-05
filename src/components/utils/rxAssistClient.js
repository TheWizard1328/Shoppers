import { base44 } from '@/api/base44Client';

/**
 * RxAssist — LLM-backed assistant client (feature spec v1.0).
 *
 * Frontend contract:
 *   askRxAssist({ question, page, patientId?, patientName?, deliveryId?, storeId? })
 *     → { reply, escalation, usage }  (never throws for AI-unavailable — it
 *       returns { unavailable: true, message } so the caller can fall back to
 *       scripted mode gracefully).
 *
 * The proxy (backend function rxAssistChat) enforces auth, scope validation,
 * per-user conversations, the daily cap, and [ESCALATE] ticket routing.
 * This module only relays + times out at 30s with a graceful offline fallback.
 */

const RXASSIST_TIMEOUT_MS = 30000;

let _availability = { unavailable: false, checkedAt: 0 };

function invokeWithTimeout(payload) {
  return Promise.race([
    base44.functions.invoke('rxAssistChat', payload),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('rxassist_timeout')), RXASSIST_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Ask RxAssist a free-text question with optional entity context hints.
 * The hints are IDs matched locally (scoped) — the backend re-validates them
 * against the user's own permissions before fetching anything.
 */
export async function askRxAssist({ question, page, patientId, patientName, deliveryId, storeId } = {}) {
  const trimmed = String(question || '').trim();
  if (!trimmed) return { unavailable: true, message: 'Empty question' };

  const payload = {
    question: trimmed,
    page: page || 'App',
  };
  if (patientId) payload.patientId = patientId;
  if (patientName) payload.patientName = patientName; // context label only — backend resolves by id
  if (deliveryId) payload.deliveryId = deliveryId;
  if (storeId) payload.storeId = storeId;

  try {
    const res = await invokeWithTimeout(payload);
    const data = res?.data ?? res;

    if (data?.reply) {
      _availability = { unavailable: false, checkedAt: Date.now() };
      return {
        reply: data.reply,
        escalation: data.escalation || null,
        usage: data.usage || null,
      };
    }

    // Structured non-reply responses (cap reached, not configured, etc.)
    if (data?.error === 'daily_cap_reached') {
      return {
        unavailable: true,
        capped: true,
        usage: data.usage || null,
        message: data.message || "You've reached today's RxAssist message limit.",
      };
    }
    return {
      unavailable: true,
      message: data?.message || data?.error || 'RxAssist could not answer that.',
    };
  } catch (err) {
    const msg = String(err?.message || err);
    const timedOut = msg.includes('timeout');
    return {
      unavailable: true,
      message: timedOut
        ? 'RxAssist is taking a moment and did not respond in time.'
        : 'RxAssist is unavailable right now.',
    };
  }
}

/** Coarse availability flag — if the last call failed, skip straight to scripted mode for a while. */
export function isRxAssistLikelyUnavailable(cooldownMs = 120000) {
  return _availability.unavailable && (Date.now() - _availability.checkedAt) < cooldownMs;
}

/**
 * Fire the owner/admin push notification for an escalation ticket created by
 * the proxy. Push is invoked client-side (authenticated) — the backend cannot
 * call other backend functions without a 403 (known platform limitation).
 */
export async function notifyOwnerOfEscalation(escalation, currentUser) {
  if (!escalation?.id) return;
  try {
    // Resolve admin/app-owner AppUsers to ping — they see the ticket in triage.
    const admins = (typeof window !== 'undefined' && Array.isArray(window.__appUsers))
      ? window.__appUsers.filter((u) => u && ((Array.isArray(u.app_roles) && u.app_roles.includes('admin')) || u.role === 'admin'))
      : [];
    const title = `RxAssist escalation (${escalation.priority})`;
    const bodyText = `${String(escalation.category || 'issue').replace(/_/g, ' ')}: ${escalation.summary || 'New support ticket'} — from ${currentUser?.user_name || 'a user'}`;
    await Promise.all(
      admins
        .map((a) => a.user_id || a.id)
        .filter(Boolean)
        .map((uid) =>
          base44.functions.invoke('sendPushNotification', {
            user_id: uid,
            title,
            body: bodyText,
            url: '/AdminUtilities',
            force: true,
            tag: `rxassist-escalation-${escalation.id}`,
            data: { ticket_id: escalation.id },
          }).catch(() => {})
        )
    );
  } catch { /* fire-and-forget — never block the chat */ }
}
