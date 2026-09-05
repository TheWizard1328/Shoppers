import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ─────────────────────────────────────────────────────────────────────────────
// rxAssistChat — LLM-backed assistant proxy (RxAssist Superagent relay)
//
// Architecture (FEATURE SPEC v1.0):
//   RxDeliver frontend → this proxy → RxAssist Superagent API → reply.
//   The agent API key lives ONLY in server env (RXASSIST_API_KEY) — never in
//   the client bundle. PLATFORM CONSTRAINT (verified by probing): the agent
//   API keys to ONE shared conversation — POST /conversations is get-current,
//   not create-per-user. Isolation is therefore enforced at the prompt level:
//   every relayed message is marked STANDALONE (ignore conversation history)
//   and carries only the requesting user's own scoped context. RxAssist's
//   Custom Instructions must repeat the "answer only from the context block"
//   rule (see rollout notes).
//
// CONTEXT PROVIDER PATTERN (key design decision):
//   The LLM never gets raw database access. This function runs as the
//   requesting user and builds a compact context payload from ONLY the records
//   the client referenced (patientId / deliveryId / storeId) after validating
//   them against the user's own scope (admin / dispatcher store_ids / driver).
//   The LLM sees exactly what the requesting user is allowed to see — never
//   more.
//
// ESCALATION:
//   Replies may carry an [ESCALATE] block (see spec). This function strips it
//   from the user-visible reply, creates a SupportTicket (no PHI), and returns
//   the escalation metadata so the client can fire the owner push notification.
//
// COST GUARDRAIL:
//   Daily per-user message cap (RXASSIST_DAILY_CAP, default 30) enforced
//   server-side in RxAssistSession (usage_date + message_count, Edmonton tz).
// ─────────────────────────────────────────────────────────────────────────────

const RXASSIST_BASE = Deno.env.get('RXASSIST_BASE_URL') ||
  'https://app.base44.com/api/agents/6a9b985ac88c01ac82209999';
const DAILY_CAP = parseInt(Deno.env.get('RXASSIST_DAILY_CAP') || '30', 10);
const AGENT_TIMEOUT_MS = 27000; // client times out at 30s — stay under it
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// ── Helpers ─────────────────────────────────────────────────────────────────

function edmontonTodayStr() {
  // App business timezone is America/Edmonton (MDT/MST).
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function getPrimaryRole(appUser: any, isOwner: boolean): string {
  if (isOwner) return 'admin';
  const roles = Array.isArray(appUser?.app_roles) ? appUser.app_roles : [];
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('store_owner')) return 'store_owner';
  if (roles.includes('dispatcher')) return 'dispatcher';
  if (roles.includes('driver')) return 'driver';
  return '';
}

function compactStr(v: any, max = 120): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Defensive PHI scrub for escalation tickets — tickets must carry the ISSUE,
// never patient data. RxAssist's prompt already forbids PHI in the block; this
// is defense-in-depth (long digit runs = phones/HINs).
function scrubPhi(text: string): string {
  return String(text || '')
    .replace(/\b\d{7,}\b/g, '[redacted]')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[redacted]');
}

// ── RxAssist (Superagent) API client — response-shape tolerant ──────────────

async function agentFetch(path: string, init: any, apiKey: string): Promise<any> {
  // Key travels as header first; on auth failure retry once as query param
  // (the agent API accepts either).
  const urlWithKey = `${RXASSIST_BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`;
  let res = await fetch(`${RXASSIST_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'api_key': apiKey, ...(init?.headers || {}) },
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  }).catch((err: any) => { throw new Error(`agent_fetch_failed: ${err?.message || err}`); });

  if (res.status === 401 || res.status === 403) {
    res = await fetch(urlWithKey, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    }).catch((err: any) => { throw new Error(`agent_fetch_failed: ${err?.message || err}`); });
  }
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`agent_api_${res.status}: ${raw.slice(0, 300)}`);
  }
  try { return JSON.parse(raw); } catch { return raw; }
}

function extractConversationId(data: any): string | null {
  if (!data) return null;
  return data._id || data.id || data.conversation_id || data.conversationId ||
    data?.data?._id || data?.data?.id || data?.conversation?._id || data?.conversation?.id || null;
}

async function ensureConversation(base44: any, session: any, userLabel: string, apiKey: string): Promise<string> {
  if (session?.conversation_id) return session.conversation_id;
  const created = await agentFetch('/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: `RxDeliver — ${userLabel}` })
  }, apiKey);
  const convId = extractConversationId(created);
  if (!convId) throw new Error('agent_conversation_create_failed: no id in response');
  return convId;
}

function extractReply(data: any): string | null {
  if (!data) return null;
  if (typeof data === 'string') return data;
  const last = (arr: any[]) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
  const candidates = [
    data?.message?.content ?? data?.message?.text,
    data?.reply ?? data?.response ?? data?.content ?? data?.text,
    last(data?.messages)?.content ?? last(data?.messages)?.text,
    last(data?.data)?.content,
    data?.data?.message?.content ?? data?.data?.content,
    data?.assistant_message?.content,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return null;
}

// ── [ESCALATE] block parsing ────────────────────────────────────────────────

interface Escalation { category: string; priority: string; summary: string; details?: string }

function parseEscalation(reply: string): { reply: string; escalation: Escalation | null } {
  const match = reply.match(/\[ESCALATE\][\s\S]*?(?:\n\s*\n|\n(?=\S)|$)/i);
  if (!match) return { reply, escalation: null };
  const block = match[0];
  const grab = (key: string) => {
    const m = block.match(new RegExp(`${key}\\s*:\\s*(.+)`, 'i'));
    return m ? m[1].trim() : undefined;
  };
  const categoryRaw = (grab('category') || 'question').toLowerCase();
  const priorityRaw = (grab('priority') || 'medium').toLowerCase();
  let summary = grab('summary') || '';
  let details = grab('details') || undefined;
  // LLMs sometimes run summary + details onto one line — split them back apart.
  if (/\s*details\s*:/i.test(summary)) {
    const parts = summary.split(/\s*details\s*:/i);
    summary = parts[0].trim();
    if (!details) details = parts.slice(1).join(' ').trim() || undefined;
  }
  const valid = (v: string, list: string[], dflt: string) => list.includes(v) ? v : dflt;
  if (!summary) return { reply: reply.replace(block, '').trim(), escalation: null };
  const escalation: Escalation = {
    category: valid(categoryRaw, ['bug', 'feature_request', 'account', 'question'], 'question'),
    priority: valid(priorityRaw, ['low', 'medium', 'high', 'urgent'], 'medium'),
    summary: scrubPhi(summary.slice(0, 300)),
    details: details ? scrubPhi(details.slice(0, 1500)) : undefined,
  };
  return { reply: reply.replace(block, '').trim(), escalation };
}

// ── Context builder (user-scoped) ────────────────────────────────────────────

async function buildContext(base44: any, body: any, platformUser: any, appUser: any, role: string): Promise<string> {
  const isOwner = platformUser?.role === 'admin';
  const ctx: any = {
    user: {
      name: appUser?.user_name || platformUser?.full_name || platformUser?.email || 'RxDeliver user',
      role,
      city_id: appUser?.city_id || undefined,
      store_ids: role === 'dispatcher' ? (appUser?.store_ids || []) : undefined,
    },
    page: body?.page || undefined,
  };

  // ── Referenced delivery (scope-validated) ──
  let delivery: any = null;
  if (body?.deliveryId) {
    const d = await base44.entities.Delivery.get(body.deliveryId).catch(() => null);
    if (d?.id) {
      const allowed =
        role === 'admin' || isOwner ||
        (role === 'dispatcher' && (appUser?.store_ids || []).includes(d.store_id)) ||
        (role === 'driver' && d.driver_id === appUser?.id);
      if (allowed) delivery = d;
    }
  } else if (role === 'driver' && appUser?.id) {
    // Driver without a specific delivery — resolve their current active stop for today.
    const todays = await base44.entities.Delivery.filter({
      driver_id: appUser.id, delivery_date: edmontonTodayStr()
    }).catch(() => []);
    const active = (todays || []).find((d: any) => d?.status === 'in_transit') || null;
    if (active) delivery = active;
  }

  if (delivery) {
    ctx.delivery = {
      id: delivery.id,
      date: delivery.delivery_date,
      status: delivery.status,
      stop_order: delivery.stop_order,
      time_window: [delivery.delivery_time_start, delivery.delivery_time_end].filter(Boolean).join('–') || undefined,
      notes: compactStr(delivery.delivery_notes, 200),
      cod_total: delivery.cod_total_amount_required || undefined,
      store_id: delivery.store_id,
      patient_id: delivery.patient_id || undefined,
    };
    if (body?.patientId && delivery.patient_id && body.patientId !== delivery.patient_id) {
      // Client hint disagrees with the delivery — prefer the delivery's patient.
      body.patientId = delivery.patient_id;
    }
  }

  // ── Referenced patient (scope-validated) ──
  const patientId = body?.patientId || delivery?.patient_id || null;
  if (patientId) {
    const p = await base44.entities.Patient.get(patientId).catch(() => null);
    if (p?.id) {
      const storeIds = role === 'dispatcher' ? (appUser?.store_ids || []) : null;
      let allowed = role === 'admin' || isOwner || role === 'store_owner';
      if (!allowed && role === 'dispatcher' && storeIds) allowed = storeIds.includes(p.store_id);
      if (!allowed && role === 'driver' && appUser?.id && p.store_id) {
        // Drivers may see patients of stores they have (or had) deliveries for.
        const drvDeliveries = await base44.entities.Delivery.filter({
          driver_id: appUser.id, store_id: p.store_id
        }).catch(() => []);
        allowed = (drvDeliveries || []).length > 0;
      }
      if (allowed) {
        ctx.patient = {
          full_name: p.full_name,
          address: p.address,
          unit: p.unit_number || undefined,
          phone: p.phone || undefined,
          status: p.status,
          // Delivery preferences the driver needs at the door:
          ring_bell: p.ring_bell, dont_ring_bell: p.dont_ring_bell,
          call_upon_arrival: p.call_upon_arrival, back_door: p.back_door,
          mailbox_ok: p.mailbox_ok,
          notes: compactStr(p.notes, 200),
          last_delivery_date: p.last_delivery_date || undefined,
        };
        // Patient delivery history — last 10, most recent first.
        const history = await base44.entities.Delivery.filter({ patient_id: p.id }).catch(() => []);
        ctx.patient_history = (history || [])
          .filter(Boolean)
          .sort((a: any, b: any) => String(b.delivery_date || '').localeCompare(String(a.delivery_date || '')))
          .slice(0, 10)
          .map((d: any) => ({
            date: d.delivery_date,
            status: d.status,
            driver: d.driver_name || undefined,
            notes: FINISHED_STATUSES.has(d.status) ? compactStr(d.delivery_notes, 80) : undefined,
          }));
      }
    }
  }

  // ── Referenced store (or the delivery's store) ──
  const storeId = body?.storeId || delivery?.store_id || null;
  if (storeId) {
    const s = await base44.entities.Store.get(storeId).catch(() => null);
    if (s?.id) {
      ctx.store = {
        name: s.name,
        address: compactStr(s.address, 120),
        phone: s.phone || undefined,
        pickup_window: [s.weekday_am_start, s.weekday_pm_end].filter(Boolean).join('–') || undefined,
      };
    }
  }

  // ── Driver's remaining route (compact) — helps "what's next" questions ──
  if (role === 'driver' && appUser?.id) {
    const todays = await base44.entities.Delivery.filter({
      driver_id: appUser.id, delivery_date: edmontonTodayStr()
    }).catch(() => []);
    const unfinished = (todays || [])
      .filter((d: any) => d && !FINISHED_STATUSES.has(d.status))
      .sort((a: any, b: any) => (a.stop_order ?? 999) - (b.stop_order ?? 999))
      .slice(0, 30)
      .map((d: any) => ({ stop: d.stop_order, status: d.status, store_id: d.store_id, time: d.delivery_time_start || undefined }));
    if (unfinished.length) ctx.remaining_route = unfinished;
  }

  // ── Driver schedule (dispatcher/admin/store_owner) — "who is my driver /
  // who is scheduled today / who is scheduled for store X" questions ──
  // Sources, in authority order:
  //   1. DriverScheduleOverride for the date + slot (explicit change or booked-off)
  //   2. Store default slot drivers (weekday_am/… / saturday_… / sunday_…)
  //   3. Drivers that actually have stops assigned for the date
  if (role === 'dispatcher' || role === 'admin' || role === 'store_owner' || isOwner) {
    const schedDate = (typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : edmontonTodayStr();
    const dow = new Date(`${schedDate}T12:00:00Z`).getUTCDay();
    const slotAm = dow === 6 ? 'saturday_am' : dow === 0 ? 'sunday_am' : 'weekday_am';
    const slotPm = dow === 6 ? 'saturday_pm' : dow === 0 ? 'sunday_pm' : 'weekday_pm';
    const myStoreIds = role === 'dispatcher' ? (appUser?.store_ids || []) : null;

    // Name map — schedule driver ids may be either AppUser.id or AppUser.user_id
    const nameById = new Map();
    const allUsers = await base44.entities.AppUser.list().catch(() => []);
    for (const u of (allUsers || [])) {
      const nm = u?.user_name || u?.full_name;
      if (!nm) continue;
      if (u?.id) nameById.set(u.id, nm);
      if (u?.user_id) nameById.set(u.user_id, nm);
    }
    const nameOf = (id: any, fb?: any) => (id && nameById.get(id)) || fb || null;

    // Drivers with assigned stops on the date (scoped to dispatcher's stores)
    const stops = await base44.entities.Delivery.filter({ delivery_date: schedDate }).catch(() => []);
    const byDriver = new Map();
    for (const d of ((stops || []).filter(Boolean))) {
      if (!d?.driver_id && !d?.driver_name) continue;
      if (d.status === 'cancelled') continue;
      if (myStoreIds && !myStoreIds.includes(d.store_id)) continue;
      const key = d.driver_id || d.driver_name;
      const e: any = byDriver.get(key) || { driver: d.driver_name || nameOf(d.driver_id), stops: 0, unfinished: 0 };
      e.stops++;
      if (!FINISHED_STATUSES.has(d.status)) e.unfinished++;
      byDriver.set(key, e);
    }
    const onRoute: any[] = [...byDriver.values()];
    if (onRoute.length) ctx.drivers_on_route = { date: schedDate, drivers: onRoute };

    // Per-store schedule for the date: override → store default slot driver
    let stores: any[] = await base44.entities.Store.list().catch(() => []);
    stores = (stores || []).filter(Boolean);
    if (myStoreIds) stores = stores.filter((s: any) => myStoreIds.includes(s?.id));
    if (stores.length) {
      const overrides = await base44.entities.DriverScheduleOverride.filter({ date: schedDate }).catch(() => []);
      const ovs = (overrides || []).filter(Boolean);
      const slot = (store: any, key: string, dfltId: any, dfltName: any) => {
        const ov = ovs.find((x: any) => x?.store_id === store?.id && x?.slot_key === key);
        if (ov?.driver_id && ov.driver_id !== '__booked_off__') {
          return { driver: ov.driver_name || nameOf(ov.driver_id), source: 'override' };
        }
        if (ov?.driver_id === '__booked_off__') {
          return { driver: null, booked_off: true, was: nameOf(ov.booked_off_driver_id) || ov.driver_name || undefined };
        }
        const dflt = nameOf(dfltId, dfltName);
        return dflt ? { driver: dflt, source: 'store_default' } : { driver: null };
      };
      ctx.store_schedules = {
        date: schedDate,
        slots: [slotAm, slotPm],
        stores: stores.map((s: any) => ({
          store: s.name,
          am: slot(s, slotAm, s[`${slotAm}_driver_id`], s[`${slotAm}_driver`]),
          pm: slot(s, slotPm, s[`${slotPm}_driver_id`], s[`${slotPm}_driver`]),
        })),
      };
    }
  }

  return JSON.stringify(ctx);
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const platformUser = await base44.auth.me().catch(() => null);
    if (!platformUser) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiKey = Deno.env.get('RXASSIST_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'ai_not_configured', message: 'RXASSIST_API_KEY secret is not set' }, { status: 503 });
    }

    let body: any = {};
    try { body = await req.json(); } catch (_) {}
    const question = String(body?.question || '').trim().slice(0, 2000);
    if (!question) {
      return Response.json({ error: 'bad_request', message: 'question is required' }, { status: 400 });
    }

    // ── Resolve AppUser (role + scoping) ──
    const appUsers = await base44.entities.AppUser.filter({ user_id: platformUser.id }).catch(() => []);
    const appUser = Array.isArray(appUsers) ? appUsers.find((u: any) => u?.user_id === platformUser.id) || appUsers[0] : null;
    const role = getPrimaryRole(appUser, platformUser.role === 'admin');
    if (!role) {
      return Response.json({ error: 'forbidden', message: 'No app role assigned' }, { status: 403 });
    }

    // ── Session: per-user conversation + daily cap ──
    const today = edmontonTodayStr();
    const sessions = await base44.entities.RxAssistSession.filter({ user_id: platformUser.id }).catch(() => []);
    let session = Array.isArray(sessions) ? sessions.find((s: any) => s?.user_id === platformUser.id) || null : null;
    if (session && session.usage_date !== today) {
      session = await base44.entities.RxAssistSession.update(session.id, { usage_date: today, message_count: 0 }).catch(() => session);
    }
    const countSoFar = (session?.usage_date === today ? Number(session.message_count || 0) : 0);
    if (countSoFar >= DAILY_CAP) {
      return Response.json({
        error: 'daily_cap_reached',
        usage: { count: countSoFar, cap: DAILY_CAP },
        message: `You've reached today's RxAssist limit (${DAILY_CAP} messages). The scripted guide answers below still work.`
      }, { status: 429 });
    }

    // ── Build user-scoped context (never raw DB access for the LLM) ──
    const contextJson = await buildContext(base44, body, platformUser, appUser, role);

    // ── Ensure per-user conversation ──
    const userLabel = appUser?.user_name || platformUser?.full_name || platformUser?.email || 'User';
    let conversationId: string;
    try {
      conversationId = await ensureConversation(base44, session, userLabel, apiKey);
    } catch (err: any) {
      return Response.json({ error: 'ai_unavailable', message: err?.message || 'conversation setup failed' }, { status: 502 });
    }

    // ── Send message (context block + question) and wait for the reply ──
    // STANDALONE prefix: the underlying conversation is shared across
    // RxDeliver users, so each relayed message must be treated as a fresh
    // self-contained session — never reference prior conversation history.
    const messageBody =
      `STANDALONE REQUEST — ignore all previous messages in this conversation; treat this message as a brand-new session and answer ONLY from the context block below.\n\n[RXDELIVER CONTEXT — user-scoped, use only this]\n${contextJson}\n[/RXDELIVER CONTEXT]\n\nUser question: ${question}`;

    let replyRaw: string | null = null;
    try {
      const sent = await agentFetch(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: messageBody })
      }, apiKey);
      replyRaw = extractReply(sent);
    } catch (err: any) {
      // Conversation may have been deleted in the agent workspace — recreate once.
      if (String(err?.message || '').includes('agent_api_40')) {
        try {
          const recreated = await agentFetch('/conversations', {
            method: 'POST',
            body: JSON.stringify({ title: `RxDeliver — ${userLabel}` })
          }, apiKey);
          const newId = extractConversationId(recreated);
          if (newId) {
            conversationId = newId;
            if (session?.id) await base44.entities.RxAssistSession.update(session.id, { conversation_id: newId }).catch(() => {});
            const retried = await agentFetch(`/conversations/${encodeURIComponent(newId)}/messages`, {
              method: 'POST',
              body: JSON.stringify({ content: messageBody })
            }, apiKey);
            replyRaw = extractReply(retried);
          }
        } catch (_) { /* fall through to unavailable */ }
      }
      if (!replyRaw) {
        if (session?.id) await base44.entities.RxAssistSession.update(session.id, { last_error: String(err?.message || err).slice(0, 300) }).catch(() => {});
        return Response.json({ error: 'ai_unavailable', message: err?.message || 'agent request failed' }, { status: 502 });
      }
    }

    if (!replyRaw || !replyRaw.trim()) {
      return Response.json({ error: 'ai_unavailable', message: 'agent returned empty reply' }, { status: 502 });
    }

    // ── Parse + route escalation ──
    const { reply, escalation } = parseEscalation(replyRaw);
    let escalationOut: any = null;
    if (escalation) {
      try {
        const ticket = await base44.entities.SupportTicket.create({
          category: escalation.category,
          priority: escalation.priority,
          summary: escalation.summary,
          details: escalation.details || `Role: ${role}. Page: ${body?.page || 'unknown'}.`,
          status: 'open',
          requester_id: appUser?.id || platformUser.id,
          requester_name: userLabel,
          requester_role: role,
          page: body?.page || undefined,
          escalated_at: new Date().toISOString(),
        });
        escalationOut = { id: ticket?.id, category: escalation.category, priority: escalation.priority, summary: escalation.summary };
      } catch (err: any) {
        console.warn('[rxAssistChat] SupportTicket create failed:', err?.message || err);
      }
    }

    // ── Persist session (upsert) + usage increment ──
    const sessionFields = {
      user_id: platformUser.id,
      user_name: userLabel,
      conversation_id: conversationId,
      conversation_title: `RxDeliver — ${userLabel}`,
      usage_date: today,
      message_count: countSoFar + 1,
      last_message_at: new Date().toISOString(),
      last_error: undefined,
    };
    if (session?.id) {
      await base44.entities.RxAssistSession.update(session.id, sessionFields).catch(() => {});
    } else {
      await base44.entities.RxAssistSession.create(sessionFields).catch(() => {});
    }

    return Response.json({
      reply,
      escalation: escalationOut,
      usage: { count: countSoFar + 1, cap: DAILY_CAP },
    });
  } catch (error) {
    console.error('[rxAssistChat] fatal:', error?.message || error);
    return Response.json({ error: 'ai_unavailable', message: error?.message || 'unexpected error' }, { status: 500 });
  }
});
