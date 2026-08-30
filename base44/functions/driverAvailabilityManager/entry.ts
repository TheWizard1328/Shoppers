import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * driverAvailabilityManager
 * ----------------------------------------------------------------------------
 * Backend function for the Driver Availability Request feature.
 *
 * Actions:
 *   create_request  — Dispatcher creates a request. Looks up assigned drivers
 *                     from Store schedule fields, sends targeted push to them.
 *                     If no assigned drivers, goes straight to broadcast.
 *   escalate_now    — Dispatcher manually escalates before timeout.
 *   driver_response — Driver taps Yes/No on push notification.
 *                     "yes" → creates Message to dispatcher, marks request completed.
 *                     "no"  → if during assigned phase, triggers escalation.
 *   check_guard     — Returns whether any driver has isNextDelivery=true for the store.
 *   get_active      — Returns the dispatcher's active request (if any).
 */

const TWO_MIN_MS = 2 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

function getAssignedDriverIdsForStore(store, dateStr) {
  if (!store || !dateStr) return [];
  const dayIdx = new Date(dateStr + 'T00:00:00').getDay();
  const ids = [];
  if (dayIdx === 6) {
    if (store.saturday_am_driver_id) ids.push(store.saturday_am_driver_id);
    if (store.saturday_pm_driver_id) ids.push(store.saturday_pm_driver_id);
  } else if (dayIdx === 0) {
    if (store.sunday_am_driver_id) ids.push(store.sunday_am_driver_id);
    if (store.sunday_pm_driver_id) ids.push(store.sunday_pm_driver_id);
  } else {
    if (store.weekday_am_driver_id) ids.push(store.weekday_am_driver_id);
    if (store.weekday_pm_driver_id) ids.push(store.weekday_pm_driver_id);
  }
  return Array.from(new Set(ids.filter(Boolean)));
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { action } = body;

    // ── check_guard: Is any driver heading to this store? ────────────────
    if (action === 'check_guard') {
      const { store_id } = body;
      if (!store_id) return Response.json({ error: 'store_id required' }, { status: 400 });

      // Check for deliveries with isNextDelivery=true pointing to this store
      // We need to check all deliveries for today with this store_id
      const today = new Date().toISOString().split('T')[0];
      const storeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        store_id,
        isNextDelivery: true
      });

      // Filter to active (non-terminal) deliveries with isNextDelivery
      const TERMINAL = ['completed', 'failed', 'cancelled'];
      const active = (storeDeliveries || []).filter(d =>
        d?.isNextDelivery === true && !TERMINAL.includes(d?.status)
      );

      return Response.json({
        guard_passed: active.length === 0,
        blocking_count: active.length,
        blocking_drivers: Array.from(new Set(active.map(d => d.driver_id).filter(Boolean)))
      });
    }

    // ── get_active: Get dispatcher's active request ──────────────────────
    if (action === 'get_active') {
      const { dispatcher_id } = body;
      const did = dispatcher_id || user.id;
      const active = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({
        dispatcher_id: did,
        status: 'waiting'
      });
      const escalated = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({
        dispatcher_id: did,
        status: 'escalated'
      });
      // Also surface a request that JUST completed (driver said yes) — without
      // this, a page reload/re-mount during the response window (e.g. dispatcher
      // switching tabs right as a driver responds) would show nothing at all,
      // since 'completed' wasn't checked here before.
      const completed = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({
        dispatcher_id: did,
        status: 'completed'
      });
      const recentCompleted = (completed || []).filter(r => {
        const respondedAt = r.assigned_driver_responses?.length
          ? r.assigned_driver_responses[r.assigned_driver_responses.length - 1]?.timestamp
          : null;
        if (!respondedAt) return false;
        return Date.now() - new Date(respondedAt).getTime() < 2 * 60 * 1000; // last 2 min
      });
      const all = [...(active || []), ...(escalated || []), ...recentCompleted];
      // Return the most recent active one
      all.sort((a, b) => new Date(b.created_date || b.created_at || 0).getTime() - new Date(a.created_date || a.created_at || 0).getTime());
      return Response.json({ active_request: all[0] || null });
    }

    // ── create_request: Start the flow ───────────────────────────────────
    if (action === 'create_request') {
      const { store_id, store_name, city_id, city_name, company_id, extra_info, specific_driver_id } = body;
      if (!store_id) return Response.json({ error: 'store_id required' }, { status: 400 });

      const now = Date.now();

      // Auto-cleanup: delete terminal requests older than 24 hours to prevent
      // unbounded growth. Only runs when this dispatcher creates a new request
      // (no separate cron needed).
      const oldRequests = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({
        dispatcher_id: user.id,
        store_id
      });
      const terminalStatuses = ['completed', 'expired', 'cancelled'];
      for (const r of (oldRequests || [])) {
        if (terminalStatuses.includes(r.status)) {
          const created = new Date(r.created_date || r.created_at || 0).getTime();
          if (created < now - 24 * 60 * 60 * 1000) {
            base44.asServiceRole.entities.DriverAvailabilityRequest.delete(r.id).catch(() => {});
          }
        }
      }

      // Check for existing active/cooldown request
      const existing = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({
        dispatcher_id: user.id,
        store_id
      });
      // Auto-expire any stale requests before checking for active blockers.
      // A 'waiting' request is stale if its 2-min timeout has passed.
      // An 'escalated' request is stale if its 5-min cooldown has passed.
      // Both cases happen when the dispatcher closed the page / killed the app
      // without clicking Cancel — the request sits forever and blocks all
      // future requests with a 409.
      const staleIds = [];
      for (const r of (existing || [])) {
        if (r.status === 'waiting') {
          const timeoutMs = r.timeout_expires_at ? new Date(r.timeout_expires_at).getTime() : 0;
          if (timeoutMs > 0 && timeoutMs <= now) staleIds.push(r.id);
        } else if (r.status === 'escalated') {
          const cooldownMs = r.cooldown_expires_at ? new Date(r.cooldown_expires_at).getTime() : 0;
          if (cooldownMs > 0 && cooldownMs <= now) staleIds.push(r.id);
          // Also expire escalated requests with no cooldown set (safety net)
          else if (!r.cooldown_expires_at) {
            const ageMs = now - new Date(r.created_date || r.created_at || now).getTime();
            if (ageMs > 10 * 60 * 1000) staleIds.push(r.id); // >10 min old
          }
        }
      }
      // Fire-and-forget expiry of stale requests
      for (const sid of staleIds) {
        base44.asServiceRole.entities.DriverAvailabilityRequest.update(sid, { status: 'expired' }).catch(() => {});
      }

      const activeExisting = (existing || []).find(r => {
        if (staleIds.includes(r.id)) return false;
        if (r.status === 'waiting') return true;
        if (r.status === 'escalated') {
          // Only blocks if cooldown hasn't expired
          const cooldownMs = r.cooldown_expires_at ? new Date(r.cooldown_expires_at).getTime() : 0;
          return cooldownMs > 0 && cooldownMs > now;
        }
        if (r.cooldown_expires_at && new Date(r.cooldown_expires_at).getTime() > now) return true;
        return false;
      });
      if (activeExisting) {
        return Response.json({ error: 'A request is already active or in cooldown', request: activeExisting }, { status: 409 });
      }

      // Get dispatcher's AppUser for name
      const dispatcherAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      const dispatcherName = dispatcherAppUsers?.[0]?.user_name || user.full_name || 'Dispatcher';

      // Get store for assigned driver lookup
      const today = new Date().toISOString().split('T')[0];
      const stores = await base44.asServiceRole.entities.Store.filter({ id: store_id });
      const store = stores?.[0];
      const assignedDriverIds = store ? getAssignedDriverIdsForStore(store, today) : [];

      // Get AppUser records for assigned drivers (for names + push)
      let assignedDrivers = [];
      if (assignedDriverIds.length > 0) {
        const allAppUsers = await base44.asServiceRole.entities.AppUser.list(500);
        assignedDrivers = (allAppUsers || []).filter(au =>
          assignedDriverIds.includes(au.user_id) && au.status === 'active'
        );
      }

      // If specific_driver_id was provided (dispatcher chose a specific driver in the dialog)
      let targetDriverIds = assignedDriverIds;
      if (specific_driver_id && specific_driver_id !== 'all') {
        targetDriverIds = [specific_driver_id];
        assignedDrivers = [];
        const allAppUsers = await base44.asServiceRole.entities.AppUser.list(500);
        const specific = (allAppUsers || []).find(au => au.user_id === specific_driver_id);
        if (specific) assignedDrivers = [specific];
      }

      const hasAssignedDrivers = assignedDrivers.length > 0;
      const nowISO = new Date().toISOString();
      const timeoutExpires = new Date(now + TWO_MIN_MS).toISOString();

      // Create the request entity
      const requestData = {
        dispatcher_id: user.id,
        dispatcher_name: dispatcherName,
        store_id,
        store_name: store_name || store?.name || 'Store',
        city_id: city_id || store?.city_id || '',
        city_name: city_name || '',
        company_id: company_id || store?.company_id || '',
        extra_info: extra_info || '',
        status: hasAssignedDrivers ? 'waiting' : 'escalated',
        assigned_driver_ids: hasAssignedDrivers ? assignedDriverIds : [],
        assigned_driver_responses: [],
        excluded_driver_ids: [],
        timeout_expires_at: hasAssignedDrivers ? timeoutExpires : undefined,
      };

      const created = await base44.asServiceRole.entities.DriverAvailabilityRequest.create(requestData);

      // Send push notifications
      if (hasAssignedDrivers) {
        // Send to assigned drivers only
        const pushTitle = `Pickup Request — ${store_name || store?.name || 'Store'}`;
        const pushBody = extra_info ||
          `${dispatcherName} at ${store_name || store?.name || 'Store'} is requesting a driver for pickup`;

        for (const driver of assignedDrivers) {
          const driverName = driver.user_name || 'Driver';
          await base44.asServiceRole.functions.invoke('sendPushNotification', {
            user_id: driver.user_id,
            title: pushTitle,
            body: pushBody,
            url: '/?availability_request=' + created.id,
            tag: 'availability_' + created.id,
            requireInteraction: true,
            actions: [
              { action: 'availability_yes', title: "Yes, I'm available" },
              { action: 'availability_no', title: 'No' }
            ],
            data: {
              request_id: created.id,
              dispatcher_id: user.id,
              dispatcher_name: dispatcherName,
              store_name: store_name || store?.name || 'Store'
            }
          });
        }

        return Response.json({
          ok: true,
          request: created,
          phase: 'waiting',
          assigned_drivers: assignedDrivers.map(d => ({ id: d.user_id, name: d.user_name }))
        });
      } else {
        // No assigned drivers — broadcast immediately
        return await doBroadcast(base44, created, user.id, dispatcherName, store, extra_info, []);
      }
    }

    // ── escalate_now: Dispatcher clicks Escalate Now ─────────────────────
    if (action === 'escalate_now') {
      const { request_id } = body;
      if (!request_id) return Response.json({ error: 'request_id required' }, { status: 400 });

      const requests = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({ id: request_id });
      const request = requests?.[0];
      if (!request) return Response.json({ error: 'Request not found' }, { status: 404 });
      if (request.status !== 'waiting') return Response.json({ error: 'Request is not in waiting state' }, { status: 409 });

      // Collect driver IDs that said No (exclude from broadcast)
      const excluded = (request.assigned_driver_responses || [])
        .filter(r => r.response === 'no')
        .map(r => r.driver_id);

      // Get store info
      const stores = await base44.asServiceRole.entities.Store.filter({ id: request.store_id });
      const store = stores?.[0];

      return await doBroadcast(base44, request, request.dispatcher_id, request.dispatcher_name, store, request.extra_info, excluded);
    }

    // ── driver_response: Driver taps Yes/No ─────────────────────────────
    if (action === 'driver_response') {
      const { request_id, response } = body;
      if (!request_id || !['yes', 'no'].includes(response)) {
        return Response.json({ error: 'request_id and response (yes/no) required' }, { status: 400 });
      }

      const requests = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({ id: request_id });
      const request = requests?.[0];
      if (!request) return Response.json({ error: 'Request not found' }, { status: 404 });
      if (request.status === 'completed' || request.status === 'expired' || request.status === 'cancelled') {
        return Response.json({ ok: true, skipped: 'request_already_finalized' });
      }

      // Get driver's AppUser
      const driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      const driverName = driverAppUsers?.[0]?.user_name || user.full_name || 'Driver';

      if (response === 'yes') {
        // Mark request as completed
        await base44.asServiceRole.entities.DriverAvailabilityRequest.update(request_id, {
          status: 'completed',
          responded_driver_id: user.id,
          responded_driver_name: driverName,
          assigned_driver_responses: [
            ...(request.assigned_driver_responses || []),
            { driver_id: user.id, driver_name: driverName, response: 'yes', timestamp: new Date().toISOString() }
          ]
        });

        // Create Message to dispatcher
        const conversationId = [user.id, request.dispatcher_id].sort().join('_');
        await base44.asServiceRole.entities.Message.create({
          sender_id: user.id,
          sender_name: driverName,
          receiver_id: request.dispatcher_id,
          receiver_name: request.dispatcher_name || 'Dispatcher',
          conversation_id: conversationId,
          content: `I am available. — See you shortly`,
          read: false,
        });

        // Send push notification back to dispatcher
        await base44.asServiceRole.functions.invoke('sendPushNotification', {
          user_id: request.dispatcher_id,
          title: `${driverName} is available`,
          body: `${driverName} accepted your pickup request for ${request.store_name || 'your store'}.`,
          url: '/?openChat=' + encodeURIComponent(user.id) + '&openChatName=' + encodeURIComponent(driverName),
          tag: 'availability_response_' + request_id,
          actions: [{ action: 'reply', title: 'Reply' }],
          data: {
            reply_to: user.id,
            reply_to_name: driverName
          }
        });

        return Response.json({ ok: true, response: 'yes', completed: true });
      } else {
        // Driver said No
        const updatedResponses = [
          ...(request.assigned_driver_responses || []),
          { driver_id: user.id, driver_name: driverName, response: 'no', timestamp: new Date().toISOString() }
        ];

        // Add to excluded list
        const updatedExcluded = Array.from(new Set([...(request.excluded_driver_ids || []), user.id]));

        if (request.status === 'waiting') {
          // Check if ALL assigned drivers have responded No
          const assignedIds = request.assigned_driver_ids || [];
          const noResponses = updatedResponses.filter(r => r.response === 'no');
          const allSaidNo = assignedIds.length > 0 && assignedIds.every(id =>
            noResponses.some(r => r.driver_id === id)
          );

          if (allSaidNo) {
            // All assigned drivers said No — escalate immediately
            const stores = await base44.asServiceRole.entities.Store.filter({ id: request.store_id });
            const store = stores?.[0];
            await base44.asServiceRole.entities.DriverAvailabilityRequest.update(request_id, {
              assigned_driver_responses: updatedResponses,
              excluded_driver_ids: updatedExcluded
            });
            const updatedReq = { ...request, assigned_driver_responses: updatedResponses, excluded_driver_ids: updatedExcluded };
            return await doBroadcast(base44, updatedReq, request.dispatcher_id, request.dispatcher_name, store, request.extra_info, updatedExcluded);
          } else {
            // Just record the No, wait for others
            await base44.asServiceRole.entities.DriverAvailabilityRequest.update(request_id, {
              assigned_driver_responses: updatedResponses,
              excluded_driver_ids: updatedExcluded
            });
            return Response.json({ ok: true, response: 'no', waiting_for_others: true });
          }
        } else if (request.status === 'escalated') {
          // During broadcast phase — silently dismiss
          await base44.asServiceRole.entities.DriverAvailabilityRequest.update(request_id, {
            assigned_driver_responses: updatedResponses,
            excluded_driver_ids: updatedExcluded
          });
          return Response.json({ ok: true, response: 'no', phase: 'broadcast' });
        }
      }
    }

    // ── get_request: Fetch the fresh full record by id (used for polling
    // the broadcast/cooldown phase, where check_timeout's minimal response
    // isn't enough — the dispatcher UI needs assigned_driver_responses,
    // responded_driver_name, cooldown_expires_at, etc.) ───────────────────
    if (action === 'get_request') {
      const { request_id } = body;
      if (!request_id) return Response.json({ error: 'request_id required' }, { status: 400 });
      const requests = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({ id: request_id });
      const request = requests?.[0];
      if (!request) return Response.json({ error: 'Request not found' }, { status: 404 });
      return Response.json({ ok: true, request });
    }

    // ── check_timeout: Check if waiting request has timed out ────────────
    if (action === 'check_timeout') {
      const { request_id } = body;
      if (!request_id) return Response.json({ error: 'request_id required' }, { status: 400 });

      const requests = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({ id: request_id });
      const request = requests?.[0];
      if (!request) return Response.json({ error: 'Request not found' }, { status: 404 });
      if (request.status !== 'waiting') return Response.json({ ok: true, status: request.status });

      const now = Date.now();
      const timeout = request.timeout_expires_at ? new Date(request.timeout_expires_at).getTime() : 0;

      if (now >= timeout) {
        // Timed out — escalate
        const excluded = (request.assigned_driver_responses || [])
          .filter(r => r.response === 'no')
          .map(r => r.driver_id);

        const stores = await base44.asServiceRole.entities.Store.filter({ id: request.store_id });
        const store = stores?.[0];

        return await doBroadcast(base44, request, request.dispatcher_id, request.dispatcher_name, store, request.extra_info, excluded);
      }

      return Response.json({ ok: true, status: 'waiting', time_remaining_ms: timeout - now });
    }

    // ── cancel: Dispatcher cancels an active request ─────────────────────
    if (action === 'cancel') {
      const { request_id } = body;
      if (!request_id) return Response.json({ error: 'request_id required' }, { status: 400 });

      const requests = await base44.asServiceRole.entities.DriverAvailabilityRequest.filter({ id: request_id });
      const request = requests?.[0];
      if (!request) return Response.json({ error: 'Request not found' }, { status: 404 });

      await base44.asServiceRole.entities.DriverAvailabilityRequest.update(request_id, { status: 'cancelled' });
      return Response.json({ ok: true, cancelled: true });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('[driverAvailabilityManager] Error:', error);
    return Response.json({ error: (error as Error).message || 'Unknown error' }, { status: 500 });
  }
}

// ── Helper: Broadcast to all city+company drivers ─────────────────────────
async function doBroadcast(base44, request, dispatcherId, dispatcherName, store, extraInfo, excludedDriverIds) {
  // Find all active drivers in the same city + company
  const allAppUsers = await base44.asServiceRole.entities.AppUser.list(500);
  const cityId = request.city_id || store?.city_id;
  const companyId = request.company_id || store?.company_id;

  const broadcastDrivers = (allAppUsers || []).filter(au =>
    au.status === 'active' &&
    Array.isArray(au.app_roles) &&
    au.app_roles.includes('driver') &&
    !excludedDriverIds.includes(au.user_id) &&
    au.user_id !== dispatcherId &&
    (cityId ? au.city_ids?.includes(cityId) || au.city_id === cityId : true)
  );

  const nowISO = new Date().toISOString();
  const cooldownExpires = new Date(Date.now() + FIVE_MIN_MS).toISOString();

  // Update request to escalated + set cooldown
  await base44.asServiceRole.entities.DriverAvailabilityRequest.update(request.id, {
    status: 'escalated',
    request_escalated_at: nowISO,
    broadcast_sent_at: nowISO,
    broadcast_driver_ids: broadcastDrivers.map(d => d.user_id),
    excluded_driver_ids: excludedDriverIds,
    cooldown_expires_at: cooldownExpires
  });

  // Send push to all broadcast drivers
  const pushTitle = `Pickup Request — ${request.store_name || store?.name || 'Store'}`;
  const pushBody = extraInfo ||
    `${dispatcherName} at ${request.store_name || store?.name || 'Store'} is requesting a driver for pickup`;

  for (const driver of broadcastDrivers) {
    await base44.asServiceRole.functions.invoke('sendPushNotification', {
      user_id: driver.user_id,
      title: pushTitle,
      body: pushBody,
      url: '/?availability_request=' + request.id,
      tag: 'availability_' + request.id,
      requireInteraction: true,
      actions: [
        { action: 'availability_yes', title: "Yes, I'm available" },
        { action: 'availability_no', title: 'No' }
      ],
      data: {
        request_id: request.id,
        dispatcher_id: dispatcherId,
        dispatcher_name: dispatcherName,
        store_name: request.store_name || store?.name || 'Store'
      }
    });
  }

  return Response.json({
    ok: true,
    request: { ...request, status: 'escalated', broadcast_sent_at: nowISO, cooldown_expires_at: cooldownExpires },
    phase: 'broadcast',
    broadcast_count: broadcastDrivers.length
  });
}
