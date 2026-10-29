import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { enterBatchSilentMode, exitBatchSilentMode } from './entityMutations';

const queueState = {
  completionJobs: new Map(),
  appUserUpdates: new Map()
};

const COMPLETION_DEBOUNCE_MS = 1500;

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const mergeAppUserPayload = (current = {}, incoming = {}) => ({ ...current, ...incoming });

const flushAppUserUpdate = async (entry) => {
  const { appUserId, payload } = entry;
  entry.timer = null;
  if (!appUserId || !/^[a-f0-9]{24}$/i.test(String(appUserId))) return null;
  entry.inFlight = base44.entities.AppUser.update(appUserId, payload);
  try {
    const result = await entry.inFlight;
    entry.lastPayloadKey = stableStringify(payload);
    return result;
  } finally {
    entry.inFlight = null;
    if (entry.pendingPayload) {
      entry.payload = mergeAppUserPayload({}, entry.pendingPayload);
      entry.pendingPayload = null;
      entry.promise = scheduleAppUserUpdate(appUserId, entry.payload);
    } else {
      queueState.appUserUpdates.delete(appUserId);
    }
  }
};

const TERMINAL_STATUS_SET = new Set(['completed', 'failed', 'cancelled']);

export const scheduleAppUserUpdate = (appUserId, payload, delay = COMPLETION_DEBOUNCE_MS) => {
  if (!appUserId || !payload) return Promise.resolve(null);
  const payloadKey = stableStringify(payload);
  let entry = queueState.appUserUpdates.get(appUserId);

  if (!entry) {
    entry = {
      appUserId,
      payload: {},
      pendingPayload: null,
      timer: null,
      inFlight: null,
      promise: null,
      resolve: null,
      reject: null,
      lastPayloadKey: null
    };
    queueState.appUserUpdates.set(appUserId, entry);
  }

  if (entry.lastPayloadKey === payloadKey && !entry.timer && !entry.inFlight) {
    return Promise.resolve(null);
  }

  if (entry.inFlight) {
    entry.pendingPayload = mergeAppUserPayload(entry.pendingPayload || entry.payload || {}, payload);
    return entry.promise || entry.inFlight;
  }

  entry.payload = mergeAppUserPayload(entry.payload, payload);
  if (entry.timer) clearTimeout(entry.timer);

  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });

  entry.timer = setTimeout(async () => {
    try {
      const result = await flushAppUserUpdate(entry);
      entry.resolve?.(result);
    } catch (error) {
      entry.reject?.(error);
      queueState.appUserUpdates.delete(appUserId);
    }
  }, delay);

  return entry.promise;
};

const flushCompletionJob = async (entry) => {
  entry.timer = null;
  const { setOffDuty, driverId, deliveryDate, nextDeliveryId, lastCompletedDeliveryId, affectedFullRecords, completedOutOfOrder, finalBroadcastGate, finalBroadcastChangedIds } = entry.payload;

  // NOTE: purgeAndRegeneratePolylines (HERE API) is intentionally never called here.
  // Stop orders do not change on complete/fail/cancel, so existing polylines remain valid.
  // Route optimization only runs on explicit user actions (Accept All, Start, FAB re-optimize)
  // or when stops are added/removed from the route (retry, return, restart).

  // ── STEP 1: Pre-seed IDB with all affected records BEFORE backend writes ──
  // This ensures that when backend writes trigger WS broadcasts, the device's
  // own IDB is already authoritative — incoming WS events won't overwrite
  // optimistic local state with stale data.
  if (Array.isArray(affectedFullRecords) && affectedFullRecords.length > 0) {
    const validRecords = affectedFullRecords.filter((r) => r?.id);
    if (validRecords.length > 0) {
      // ETA-RACE GUARD (Oct 5 2026): this queue runs concurrently with the
      // terminal action's ETA cascade (stopCardStartActions step 6), which
      // writes FRESH delivery_time_eta values to IDB/server. affectedFullRecords
      // was built from the PRE-cascade stop objects, so its delivery_time_eta
      // values are stale. This pre-seed can land AFTER the cascade's IDB write
      // (both fire-and-forget), which clobbered the fresh ETAs back to the
      // old values — the UI then bounced fresh→stale→fresh→stale on every
      // smartRefresh poll until a refresh cycle rewrote the server. The queue's
      // optimistic contract is status/isNextDelivery/stop_order only; the ETA
      // cascade owns delivery_time_eta. Preserve the existing IDB ETA.
      const mergedSeed = await Promise.all(validRecords.map(async (rec) => {
        try {
          const existing = await offlineDB.getById(offlineDB.STORES.DELIVERIES, rec.id).catch(() => null);
          if (existing?.delivery_time_eta != null && existing.delivery_time_eta !== rec.delivery_time_eta) {
            return { ...rec, delivery_time_eta: existing.delivery_time_eta };
          }
        } catch (_) {}
        return rec;
      }));
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, mergedSeed).catch(() => null);
    }
  }

  // ── STEP 2: Register ALL affected delivery IDs in smartRefreshManager ──────
  // This suppresses per-record UI re-renders when our own server writes trigger
  // WebSocket broadcasts back to this device. The local IDB state (pre-seeded
  // above) is already authoritative, so WS echoes should be silently merged
  // without triggering a UI re-render cascade.
  if (Array.isArray(affectedFullRecords) && driverId && deliveryDate) {
    try {
      const { smartRefreshManager } = await import('./smartRefreshManager');
      for (const rec of affectedFullRecords) {
        if (rec?.id) smartRefreshManager.registerPendingUpdate(rec.id, driverId, deliveryDate);
      }
    } catch (_) {}
  }

  // ── STEP 3: Write to server in batch silent mode ───────────────────────────
  // enterBatchSilentMode suppresses per-record notifyMutation + broadcastMutation
  // from entityMutations, so each server write does NOT trigger a separate UI
  // update or outgoing WS broadcast. The server's own WS broadcasts are suppressed
  // by the smartRefreshManager registration above.
  enterBatchSilentMode();

  // 3a. Persist ONLY changed fields to server — NOT full records.
  // Writing full in-memory records can null out server-side encoded_polyline
  // and other large fields that may be absent from the in-memory representation.
  // Extract a minimal update payload per record: only the fields that are
  // meaningful for a completion event.
  const statusWritePromises = [];
  const _statusSilentUpdates = [];
  if (Array.isArray(affectedFullRecords) && affectedFullRecords.length > 0) {
    // STALE-REVERT GUARD (Robert, Sep 4 2026): status + actual_delivery_time may
    // only be pushed for the record the user DIRECTLY acted on
    // (lastCompletedDeliveryId). Other affected records (next stop, resequenced
    // stops) get ordering fields only — their status in our IDB may be stale
    // relative to a completion made on ANOTHER device, and pushing it would
    // revert that completion server-side.
    statusWritePromises.push(
      Promise.allSettled(
        affectedFullRecords.map((rec) => {
          if (!rec?.id) return Promise.resolve(null);
          const _isActedRecord = rec.id === lastCompletedDeliveryId;
          // Build minimal update — only fields relevant to a status change
          const update = {};
          if (_isActedRecord && typeof rec.status === 'string') update.status = rec.status;
          if (_isActedRecord && rec.actual_delivery_time != null) update.actual_delivery_time = rec.actual_delivery_time;
          if (rec.arrival_time != null) update.arrival_time = rec.arrival_time;
          if (rec.isNextDelivery !== undefined) update.isNextDelivery = rec.isNextDelivery;
          if (rec.stop_order != null) update.stop_order = rec.stop_order;
          if ('finished_leg_encoded_polyline' in rec) update.finished_leg_encoded_polyline = rec.finished_leg_encoded_polyline;
          if ('finished_leg_transport_mode' in rec) update.finished_leg_transport_mode = rec.finished_leg_transport_mode;
          if ('PolylineUpdated' in rec) update.PolylineUpdated = rec.PolylineUpdated;
          if (rec.cod_payments != null) update.cod_payments = rec.cod_payments;
          if (rec.signature_image_url != null) update.signature_image_url = rec.signature_image_url;
          if (rec.delivery_route_breadcrumbs != null) update.delivery_route_breadcrumbs = rec.delivery_route_breadcrumbs;
          if (typeof rec.travel_dist === 'number') update.travel_dist = rec.travel_dist;
          // ETA-RACE GUARD (Oct 5 2026): DO NOT push delivery_time_eta here.
          // affectedFullRecords carries PRE-cascade ETAs; this write raced the
          // ETA cascade's fresh server writes (both fire-and-forget from the
          // same terminal action), and when this one landed last the server
          // held STALE ETAs while IDB/state held fresh ones — every
          // smartRefresh poll then reverted the stop cards (owner report Oct
          // 2026: ETAs update → revert → bounce → revert → stay stale until a
          // refresh cycle). The ETA cascade persists ETAs to the server itself;
          // this queue owns status/order/flags only.
          // If no meaningful fields to update, skip the server write entirely
          if (Object.keys(update).length === 0) return Promise.resolve(null);
          // OWNER DIRECTIVE (Oct 16 2026): NO per-record user-scoped writes.
          // Each Delivery.update broadcast the full server record — which still
          // held STALE pre-cascade ETAs at that moment — so remote (and own)
          // devices applied stale ETAs over the cascade's fresh ones (the
          // 'reverted then resettled' ETA bounce). All status writes now go
          // through ONE silent bulk; the SINGLE end-of-action marker broadcast
          // (STEP 4, after the ETA cascade settles) is the only WS event.
          _statusSilentUpdates.push({ id: rec.id, data: update });
          return Promise.resolve(null);
        })
      )
    );
    if (_statusSilentUpdates.length > 0) {
      statusWritePromises.push(
        (async () => {
          try {
            const { commitDeliveryUpdatesSilently } = await import('./routeCommitMarker');
            const _c = await commitDeliveryUpdatesSilently(_statusSilentUpdates);
            console.log(`[CompleteQueue] silent status commit: ${_c}/${_statusSilentUpdates.length} updates (zero WS events)`);
          } catch (e) {
            console.warn('[CompleteQueue] silent status commit failed:', e?.message || e);
          }
        })()
      );
    }
  }

  // 3c. Set driver off-duty if last stop completed — via setDriverStatus backend
  // (handles DriverDailyActivity segment recording with 5-min rounding, location
  // sharing, isNextDelivery clearing, and WebSocket broadcast).
  // Runs in parallel with delivery status writes — segment recording reads
  // previousStatus from the AppUser record which hasn't been touched yet at this point.
  if (setOffDuty && driverId && deliveryDate) {
    statusWritePromises.push(
      base44.functions.invoke('setDriverStatus', {
        newStatus: 'off_duty',
        targetUserId: driverId,
        selectedDate: deliveryDate,
      }).catch((e) => console.warn('⚠️ [CompleteQueue] setDriverStatus off_duty failed:', e?.message))
    );
  }

  // CRITICAL: Wait for ALL status writes to commit BEFORE computing next delivery state.
  // The client-side computation needs the updated delivery statuses to be reflected
  // in the in-memory records (already updated locally via IDB pre-seeding).
  entry.inFlight = Promise.allSettled(statusWritePromises);
  try {
    await entry.inFlight;

    // 3b. Client-side next delivery computation — replaces backend setNextDeliveryFlag.
    // Computes stop_order repairs and isNextDelivery flags locally, then writes
    // the results to the server in a single batch. No backend function call needed.
    if (driverId && deliveryDate && Array.isArray(affectedFullRecords) && affectedFullRecords.length > 0) {
      try {
        const { computeNextDeliveryState } = await import('./clientNextDelivery');
        const { offlineDB } = await import('./offlineDatabase');

        // Load all driver+date deliveries from IDB (local baseline)
        const allDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, deliveryDate);
        let driverDeliveries = (allDeliveries || []).filter(d => d?.driver_id === driverId);

        // ── FRESH SERVER PULL (Robert, Sep 4 2026) ──────────────────────────
        // Before computing stop_order/isNextDelivery, re-pull the driver+date
        // route from the server. This runs AFTER the status writes above have
        // committed (awaited), so the server response includes our own
        // completion — and any completions/stops made on OTHER devices that a
        // suppression window may have filtered out of our IDB. Computing from
        // a fresh base prevents this device from pushing stale statuses/flags
        // back to the server (the multi-device revert bug).
        // Server records win on overlapping fields; local-only fields are
        // preserved via the merge. On fetch failure we fall back to IDB as before.
        try {
          const freshServer = await base44.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate });
          if (Array.isArray(freshServer) && freshServer.length > 0) {
            const _localMap = new Map(driverDeliveries.map(d => [d.id, d]));
            const merged = freshServer
              .filter(Boolean)
              .map((srv) => {
                const loc = _localMap.get(srv.id) || {};
                // ── LOCAL-TERMINAL AUTHORITY (owner directive Oct 15 2026) ──────
                // This device's own finished stops are the source of truth.
                // If this stop's completion upload hit a 429 and the bulk flush
                // hasn't landed yet, the server copy still shows an active
                // status — the old server-wins merge reopened the finished stop
                // right here, bulkSaving the revert back into IDB (owner report:
                // stops reverting ~1 min after completion or after a restart).
                // A locally-terminal record NEVER loses to a server copy that
                // claims an active status; the dirty-flag flush will converge
                // the server when it succeeds.
                const _locTerminal = loc && TERMINAL_STATUS_SET.has(String(loc.status || '')) && loc.actual_delivery_time;
                const _srvActive = typeof srv?.status === 'string' && !TERMINAL_STATUS_SET.has(String(srv.status));
                if (_locTerminal && _srvActive) return loc;
                const out = { ...loc, ...srv };
                // Preserve client-side polyline/leg fields when the server copy
                // is null/absent but local has them (mid-optimization legs not
                // yet committed) — same rule as the WS receiving-side merge.
                if (loc.encoded_polyline && !srv.encoded_polyline) out.encoded_polyline = loc.encoded_polyline;
                if (loc.finished_leg_encoded_polyline && !srv.finished_leg_encoded_polyline) out.finished_leg_encoded_polyline = loc.finished_leg_encoded_polyline;
                // ETA-RACE GUARD (Oct 5 2026): mid-terminal-action, the local
                // IDB copy carries the ETA cascade's FRESH values while the
                // server still holds the pre-cascade ones (the cascade's own
                // server writes may still be in flight). Server-wins here
                // bulkSaved STALE ETAs into IDB, re-seeding the revert loop
                // for the poll, the WS broadcast, and the post-cascade re-read.
                if (loc.delivery_time_eta != null && srv.delivery_time_eta !== loc.delivery_time_eta) {
                  out.delivery_time_eta = loc.delivery_time_eta;
                }
                return out;
              })
              .filter(Boolean);
            if (merged.length > 0) {
              driverDeliveries = merged;
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, merged).catch(() => null);
              console.log(`[CompleteQueue] Fresh server pull merged into compute base (${merged.length} records)`);
            }
          }
        } catch (pullErr) {
          console.warn('⚠️ [CompleteQueue] Fresh server pull failed — computing from IDB:', pullErr?.message);
        }

        // Determine driver status from AppUser
        let driverStatus = 'on_duty';
        try {
          const { getEffectiveUser } = await import('./auth');
          const effectiveUser = getEffectiveUser?.() || {};
          if (effectiveUser.id === driverId) {
            driverStatus = effectiveUser.driver_status || 'on_duty';
          }
        } catch (_) {}

        const result = computeNextDeliveryState({
          deliveries: driverDeliveries,
          driverStatus,
          targetDeliveryId: nextDeliveryId || null,
          lastCompletedDeliveryId: lastCompletedDeliveryId || null,
          completedOutOfOrder: completedOutOfOrder === true,
        });

        // Write computed stop_order and isNextDelivery to server + IDB
        if (result.changedDeliveries.length > 0) {
          // ── Pin the flag swap (owner report Oct 29 2026) ──────────────────
          // The flag landed correctly and then vanished on the drive to the
          // next stop: a stale pull / replay / echo re-wrote the old value.
          // Lock each computed value for 2 minutes so nothing — IDB write,
          // silent bulk commit or WS merge — can undo the swap. A later duty
          // transition re-locks its own value, so a genuine change still wins.
          try {
            const { lockDeliveryFields } = await import('./completionLockout');
            for (const rec of result.changedDeliveries) {
              if (rec?.id && rec.isNextDelivery !== undefined) {
                lockDeliveryFields(rec.id, ['isNextDelivery'], 120000, { isNextDelivery: rec.isNextDelivery === true });
              }
            }
          } catch (_) { /* locking is best-effort */ }

          // Update IDB first (local-first)
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, result.changedDeliveries).catch(() => null);

          // Then write to server (batch silent mode still active)
          // CRITICAL: Include `status` and `actual_delivery_time` in EVERY server
          // write, even if computeNextDeliveryState didn't change them. The WS
          // broadcast only carries CHANGED fields — if `status` is absent from
          // the write, the WS event won't include it, and a remote device that
          // hasn't processed the completion WS event yet will see a partial
          // payload (only stop_order + isNextDelivery) and preserve the stale
          // `status: 'in_transit'` from IDB. Including `status` ensures the WS
          // broadcast carries it, so the remote device sees the correct status
          // even if this WS event arrives before the completion status event.
          const _computeServerUpdates = [];
          for (const d of result.changedDeliveries) {
            const update = {};
            // OWNER DIRECTIVE (Oct 14 2026): send ONLY genuinely changed fields.
            // Previously stop_order was copied into EVERY write (identical value or
            // spurious "repair"), so one completion fired per-stop PUTs carrying
            // stop_order for many stops that never changed — dozens of rate-limit
            // errors on retro completions (owner report). changedFields is the
            // authoritative change list from computeNextDeliveryState.
            const _cf = new Set(d.__changedFields || []);
            if (_cf.has('stop_order') && d.stop_order != null) update.stop_order = d.stop_order;
            if (_cf.has('isNextDelivery') && d.isNextDelivery !== undefined) update.isNextDelivery = d.isNextDelivery;
            if (_cf.has('first_leg_origin_lat') && d.first_leg_origin_lat != null) update.first_leg_origin_lat = d.first_leg_origin_lat;
            if (_cf.has('first_leg_origin_lng') && d.first_leg_origin_lng != null) update.first_leg_origin_lng = d.first_leg_origin_lng;
            // STALE-REVERT GUARD: status/actual_delivery_time only for the
            // directly-acted record. Ordering/flag writes never carry status
            // for other stops — a stale IDB copy of another device's completed
            // stop must never be pushed back as in_transit.
            if (d.id === lastCompletedDeliveryId) {
              if (d.status) update.status = d.status;
              if (d.actual_delivery_time != null) update.actual_delivery_time = d.actual_delivery_time;
            }
            if (Object.keys(update).length > 0) {
              _computeServerUpdates.push({ id: d.id, data: update });
            }
          }
          // OWNER DIRECTIVE (Oct 15 2026): ONE silent bulk commit, not per-stop
          // user-scoped updates. The out-of-order resequencing can legitimately
          // change stop_order on many later stops — writing those one-by-one
          // (each one a separate API call + WS broadcast to every device)
          // produced the delayed flood of stop_order rate limits about a minute
          // after a retro completion (owner report Oct 15). Silent bulk = one
          // API call, zero WS events; cross-device sync already happens in
          // STEP 4 below via the route_commit marker (remotes pull).
          if (_computeServerUpdates.length > 0) {
            try {
              const { commitDeliveryUpdatesSilently } = await import('./routeCommitMarker');
              const _committed = await commitDeliveryUpdatesSilently(_computeServerUpdates);
              if (_committed !== _computeServerUpdates.length) {
                // SUCCESS CHATTER FIX (Oct 22 2026, audit item 3): this was the
                // only happy-path console.warn in the completion chain — every
                // successful stop completion shipped one RemoteLogEntry write
                // (console.warn lines are captured by remoteLogger). Downgraded
                // to console.log, which production Terser strips: zero remote
                // log writes on successful completions. The failure warn below
                // still ships.
                console.log(`[CompleteQueue] silent compute commit: ${_committed}/${_computeServerUpdates.length} updates committed`);
              }
            } catch (e) {
              console.warn('[CompleteQueue] silent compute commit failed:', e?.message || e);
            }
          }

          // Merge computed changes into affectedFullRecords so they get broadcast
          const changedMap = new Map(result.changedDeliveries.map(d => [d.id, d]));
          for (const rec of affectedFullRecords) {
            const changed = changedMap.get(rec?.id);
            if (changed) {
              if (changed.stop_order != null) rec.stop_order = changed.stop_order;
              if (changed.isNextDelivery !== undefined) rec.isNextDelivery = changed.isNextDelivery;
              if (changed.first_leg_origin_lat != null) rec.first_leg_origin_lat = changed.first_leg_origin_lat;
              if (changed.first_leg_origin_lng != null) rec.first_leg_origin_lng = changed.first_leg_origin_lng;
            }
          }
        }
      } catch (computeErr) {
        console.warn('⚠️ [CompleteQueue] Client-side nextDelivery computation failed:', computeErr?.message || computeErr);
      }
    }

    exitBatchSilentMode();

    // ── Re-read affected records from IDB to capture post-cascade state ─────
    // affectedFullRecords was snapshotted BEFORE the ETA cascade and
    // computeNextDeliveryState ran (both fire-and-forget). Re-reading from IDB
    // now gives us the post-cascade status, delivery_time_eta, isNextDelivery,
    // and stop_order so the broadcast + UI event carry fresh values instead of
    // the stale pre-cascade snapshot (which caused a ~3s status/ETA flicker on
    // the new isNextDelivery stop).
    let freshRecords = affectedFullRecords;
    if (Array.isArray(affectedFullRecords) && affectedFullRecords.length > 0) {
      try {
        const ids = affectedFullRecords.map((r) => r?.id).filter(Boolean);
        const refreshed = await Promise.all(
          ids.map((id) => offlineDB.getById(offlineDB.STORES.DELIVERIES, id).catch(() => null))
        );
        const valid = refreshed.filter(Boolean);
        if (valid.length > 0) freshRecords = valid;
      } catch (_) {}
    }

    // ── STEP 4: Broadcast to OTHER devices (not this one) ───────────────────
    // IDB is already pre-seeded above + smartRefreshManager registered, so
    // this device ignores incoming WS echoes. Other devices receive fresh
    // Other devices pull authoritative data themselves via the marker.
    //
    // CRITICAL: Only broadcast if we did NOT already write via entityMutations
    // (which does its own broadcast). Since we're in batch silent mode above,
    // the entity writes above don't broadcast. So we broadcast once here.
    if (driverId && deliveryDate) {
      // Owner architecture (Oct 15 2026, single-broadcast directive Oct 16):
      // changed records were already flushed to the server in ONE silent bulk
      // (STEP 3 commit); other devices receive ONLY the lightweight route_commit
      // marker (an ID signal, not record payloads) and pull the route themselves
      // — the proven Start-button pattern.
      //
      // ORDERING (owner directive Oct 16 2026 — the ETA revert bounce): the
      // caller (executeTerminalAction) may hand us finalBroadcastGate — a
      // promise resolving once the ETA cascade's silent commit has landed. We
      // AWAIT it before broadcasting, so this ONE marker is the final data
      // state: fresh ETAs + isNextDelivery + stop_order all settled. The marker
      // also carries every changed stop ID (route_commit_ids).
      try {
        if (finalBroadcastGate) {
          await finalBroadcastGate.catch(() => null);
        }
        const { fireRouteCommitMarker } = await import('./routeCommitMarker');
        const _markerTarget = nextDeliveryId || lastCompletedDeliveryId;
        if (_markerTarget) {
          const _changedIds = [
            lastCompletedDeliveryId,
            ...(Array.isArray(affectedFullRecords) ? affectedFullRecords.map((r) => r?.id) : []),
            ...(Array.isArray(finalBroadcastChangedIds) ? finalBroadcastChangedIds : []),
          ].filter(Boolean);
          await fireRouteCommitMarker(_markerTarget, freshRecords?.length || _changedIds.length, [...new Set(_changedIds)]).catch(() => null);
        }
      } catch (_) {}
    }

    // ── STEP 5: Single deliveriesUpdated event for UI refresh ───────────────
    // One event with all fresh data → one UI re-render, not N.
    if (Array.isArray(freshRecords) && freshRecords.length > 0) {
      try {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            driverId,
            deliveryDate,
            triggeredBy: 'completionSideEffects',
            freshDeliveries: freshRecords,
            preserveLocalState: true
          }
        }));
      } catch (_) {}
    }

    return;
  } catch (err) {
    exitBatchSilentMode();
    throw err;
  } finally {
    entry.inFlight = null;
    if (entry.pendingPayload) {
      entry.payload = { ...entry.payload, ...entry.pendingPayload };
      entry.pendingPayload = null;
      entry.promise = scheduleCompletionSideEffects(entry.payload);
    } else {
      queueState.completionJobs.delete(entry.key);
    }
  }
};

/**
 * scheduleCompletionSideEffects
 *
 * Called after a stop is completed/failed/cancelled.
 * Runs non-blocking background tasks:
 *  1. Pre-seed IDB with affected records
 *  2. Register all affected IDs in smartRefreshManager (suppress WS echo)
 *  3. Write to server in batch silent mode (suppress per-record UI updates)
 *  4. Broadcast to other devices
 *  5. Single deliveriesUpdated event for UI refresh
 *
 * @param {object} payload
 *   - driverId: string
 *   - deliveryDate: string
 *   - nextDeliveryId: string|null
 *   - lastCompletedDeliveryId: string|null
 *   - setOffDuty: boolean
 *   - appUserId: string|null
 *   - affectedFullRecords: Delivery[] — full record objects for all stops changed in this action
 *   - skipRouteOptimization: boolean (legacy, unused)
 *   - skipNextLegPolylineRefresh: boolean (legacy, unused)
 */
export const scheduleCompletionSideEffects = (payload, delay = COMPLETION_DEBOUNCE_MS) => {
  const key = `${payload?.driverId || 'unknown'}:${payload?.deliveryDate || 'unknown'}`;
  let entry = queueState.completionJobs.get(key);

  if (!entry) {
    entry = {
      key,
      payload: {},
      pendingPayload: null,
      timer: null,
      inFlight: null,
      promise: null,
      resolve: null,
      reject: null
    };
    queueState.completionJobs.set(key, entry);
  }

  if (entry.inFlight) {
    entry.pendingPayload = { ...(entry.pendingPayload || entry.payload), ...payload };
    return entry.promise || entry.inFlight;
  }

  entry.payload = { ...entry.payload, ...payload };
  if (entry.timer) clearTimeout(entry.timer);

  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });

  entry.timer = setTimeout(async () => {
    try {
      const result = await flushCompletionJob(entry);
      entry.resolve?.(result);
    } catch (error) {
      entry.reject?.(error);
      queueState.completionJobs.delete(key);
    }
  }, delay);

  return entry.promise;
};