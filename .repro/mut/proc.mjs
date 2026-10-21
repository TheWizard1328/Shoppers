// .repro/mut/proc.jsx
import { offlineDB, __CALLS } from "./odb.mjs";
import { getOfflineStoreName, OFFLINE_SYNC_ENTITY_CLIENTS } from "./registry.mjs";
import { getSyncPaused } from "./misc.mjs";
import { isDeleted, isDeletedByContent } from "./misc.mjs";
import { base44 } from "./b44.mjs";
import { sanitizeAppUserMutationPayload, hasPendingDriverStatusMutation } from "./misc.mjs";
import { invalidateEntityCache } from "./misc.mjs";
import { recordTempPatientId, resolveTempPatientId } from "./misc.mjs";
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
var getMutationEntityClient = (entityName) => OFFLINE_SYNC_ENTITY_CLIENTS[entityName] || null;
var deferredReplayTimer = null;
var MAX_MUTATION_RETRIES = 3;
var _recordMutationFailure = async (mutation, isRateLimit = false) => {
  const attempt = (mutation?.retryCount || 0) + 1;
  if (attempt >= MAX_MUTATION_RETRIES) {
    console.warn(`\u26A0\uFE0F [OfflineSync] abandoning mutation ${mutation?.entity}:${mutation?.recordId} after ${attempt} attempts \u2014 user actions will re-apply any still-needed change`);
    await offlineDB.removePendingMutation(mutation.mutationId).catch(() => {
    });
    return "abandoned";
  }
  const delayMs = isRateLimit ? 60 * 1e3 : attempt === 1 ? 30 * 1e3 : 120 * 1e3;
  await offlineDB.updateMutationRetry(mutation.mutationId, attempt, Date.now() + delayMs).catch(() => {
  });
  return "retry";
};
var scheduleDeferredReplay = (mutations = []) => {
  if (!mutations.length || typeof window === "undefined") return;
  const now = Date.now();
  const hasDueMutation = mutations.some((mutation) => !mutation?.notBefore || Number(mutation.notBefore) <= now);
  const futureTimes = mutations.map((mutation) => Number(mutation?.notBefore || 0)).filter((time) => time > now);
  const delay = hasDueMutation ? 100 : Math.max(100, Math.min(...futureTimes) - now + 100);
  if (deferredReplayTimer) clearTimeout(deferredReplayTimer);
  deferredReplayTimer = setTimeout(() => {
    deferredReplayTimer = null;
    processPendingMutationsInternal().catch(() => {
    });
  }, delay);
};
var processPendingMutationsInternal = async () => {
  if (getSyncPaused()) return { success: true, skipped: true };
  const allMutations = await offlineDB.getPendingMutations();
  const now = Date.now();
  const mutations = allMutations.filter((mutation) => !mutation?.notBefore || Number(mutation.notBefore) <= now);
  if (mutations.length === 0) {
    scheduleDeferredReplay(allMutations);
    return { success: true, processed: 0, deferred: allMutations.length };
  }
  const BATCH_SIZE = 50;
  const batch = mutations.slice(0, BATCH_SIZE);
  console.log(`\u{1F504} [OfflineSync] Processing ${batch.length} of ${mutations.length} pending mutations...`);
  const creates = batch.filter((m) => m.operation === "create");
  const updates = batch.filter((m) => m.operation === "update");
  const deletes = batch.filter((m) => m.operation === "delete");
  let successCount = 0;
  let failCount = 0;
  const failedMutationIds = [];
  const _rateLimitedDeleteIds = /* @__PURE__ */ new Set();
  ;
  if (deletes.length > 0) {
    const deletePromises = deletes.map((mutation) => {
      if (mutation.recordId?.startsWith("temp_")) {
        return Promise.resolve({ success: true, skip: true });
      }
      const Entity = getMutationEntityClient(mutation.entity);
      if (!Entity) {
        return Promise.resolve({ success: true, skip: true, mutationId: mutation.mutationId });
      }
      return Entity.delete(mutation.recordId).then(() => ({ success: true, mutationId: mutation.mutationId })).catch((deleteError) => {
        if (deleteError.response?.status === 404 || deleteError.message?.includes("404") || deleteError.message?.includes("not found")) {
          return { success: true, mutationId: mutation.mutationId };
        }
        if (deleteError.response?.status === 429) {
          return { success: false, mutationId: mutation.mutationId, error: deleteError, retryCount: mutation.retryCount || 0, isRateLimit: true };
        }
        return { success: false, mutationId: mutation.mutationId, error: deleteError, retryCount: mutation.retryCount || 0 };
      });
    });
    const deleteResults = await Promise.all(deletePromises);
    const offlineDeletePromises = [];
    for (const result of deleteResults) {
      if (result.success && result.mutationId) {
        const mutation = deletes.find((m) => m.mutationId === result.mutationId);
        if (mutation) {
          offlineDeletePromises.push(offlineDB.removePendingMutation(result.mutationId));
          const storeName = getOfflineStoreName(offlineDB, mutation.entity);
          if (storeName && !mutation.recordId?.startsWith("temp_")) {
            offlineDeletePromises.push(offlineDB.deleteRecord(storeName, mutation.recordId));
          }
        }
        successCount++;
      } else if (result.success && result.skip) {
        const mutation = deletes.find((m) => m.mutationId === result.mutationId || !m.recordId?.startsWith("temp_"));
        if (mutation?.mutationId) {
          offlineDeletePromises.push(offlineDB.removePendingMutation(mutation.mutationId));
        }
        successCount++;
      } else {
        failCount++;
        failedMutationIds.push(result.mutationId);
        if (result.isRateLimit) _rateLimitedDeleteIds.add(result.mutationId);
      }
    }
    if (offlineDeletePromises.length > 0) {
      await Promise.all(offlineDeletePromises);
    }
    for (const failedMutationId of failedMutationIds) {
      const mutation = deletes.find((m) => m.mutationId === failedMutationId);
      if (mutation) {
        await _recordMutationFailure(mutation, _rateLimitedDeleteIds.has(failedMutationId));
      }
    }
  }
  for (const mutation of [...creates, ...updates]) {
    if (getSyncPaused()) break;
    try {
      const Entity = getMutationEntityClient(mutation.entity);
      if (!Entity) {
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
      }
      const deliveryPayload = mutation.entity === "Delivery" ? (() => {
        const source = mutation.payload?._isBatchSave && Array.isArray(mutation.payload?._stagedDeliveries) ? mutation.payload._stagedDeliveries[0] : mutation.payload;
        if (!source) return source;
        if (source.patient_id && String(source.patient_id).startsWith("temp_patient_")) {
          const resolvedPid = resolveTempPatientId(source.patient_id);
          if (resolvedPid !== source.patient_id) {
            source.patient_id = resolvedPid;
            console.log(`\u{1F517} [OfflineSync] Delivery payload: resolved temp patient id \u2192 ${resolvedPid}`);
          }
        }
        const {
          _isBatchSave,
          _stagedDeliveries,
          _originalDriverId,
          _driverWasChanged,
          _tempId,
          _userInitiated,
          isNew,
          latitude,
          longitude,
          store_name,
          store_abbreviation,
          distanceFromStore,
          delivery_address,
          patient_name,
          patient_phone,
          store_phone,
          cod_amount,
          cod_payment_type,
          ...cleaned
        } = source;
        return cleaned;
      })() : mutation.payload;
      if (mutation.entity === "Delivery" && mutation.operation === "create" && !deliveryPayload?.delivery_date) {
        console.warn(`\u26A0\uFE0F [OfflineSync] Removing invalid queued Delivery mutation ${mutation.mutationId} - missing delivery_date`);
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
      }
      if (mutation.entity === "Delivery" && mutation.operation === "update" && !deliveryPayload?.delivery_date) {
        console.warn(`\u26A0\uFE0F [OfflineSync] Flushing partial Delivery update mutation ${mutation.mutationId} (no delivery_date \u2014 valid partial diff) fields: ${Object.keys(deliveryPayload || {}).join(",")}`);
      }
      if (mutation.operation === "create") {
        if (mutation.entity === "Delivery") {
          if (mutation.recordId && isDeleted(mutation.recordId)) {
            console.log(`\u{1F6E1}\uFE0F [OfflineSync] Discarding create mutation for deleted delivery ${mutation.recordId}`);
            await offlineDB.removePendingMutation(mutation.mutationId);
            successCount++;
            continue;
          }
          if (isDeletedByContent(deliveryPayload)) {
            console.log(`\u{1F6E1}\uFE0F [OfflineSync] Discarding create mutation \u2014 content matches recently deleted delivery`);
            await offlineDB.removePendingMutation(mutation.mutationId);
            successCount++;
            continue;
          }
        }
        const createdRecord = await Entity.create(mutation.entity === "Delivery" ? deliveryPayload : mutation.payload);
        const storeName = getOfflineStoreName(offlineDB, mutation.entity);
        if (storeName) {
          if (mutation.recordId?.startsWith("temp_")) {
            await offlineDB.deleteRecord(storeName, mutation.recordId);
          }
          await offlineDB.bulkSave(storeName, [createdRecord]);
        }
        if (mutation.entity === "Patient" && mutation.recordId?.startsWith("temp_") && createdRecord?.id) {
          recordTempPatientId(mutation.recordId, createdRecord.id);
          try {
            const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
            const orphans = (allDeliveries || []).filter((d) => d && d.patient_id === mutation.recordId);
            for (const orphan of orphans) {
              const patched = { ...orphan, patient_id: createdRecord.id };
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [patched]);
              try {
                const entityClient = getMutationEntityClient("Delivery");
                if (entityClient?.update) await entityClient.update(orphan.id, { patient_id: createdRecord.id });
                else await base44.entities.Delivery.update(orphan.id, { patient_id: createdRecord.id });
              } catch (dbErr) {
                console.warn("\u26A0\uFE0F [OfflineSync] Patient remap: server delivery update failed for", orphan.id, dbErr?.message || dbErr);
              }
            }
            if (orphans.length > 0) {
              console.log(`\u{1F517} [OfflineSync] Remapped ${orphans.length} delivery/deliveries from temp patient ${mutation.recordId} \u2192 ${createdRecord.id}`);
              window.dispatchEvent(new CustomEvent("deliveriesUpdated", {
                detail: { triggeredBy: "patient_temp_id_remap", fullReplacement: false }
              }));
            }
          } catch (remapErr) {
            console.warn("\u26A0\uFE0F [OfflineSync] Patient temp-id delivery remap failed:", remapErr?.message || remapErr);
          }
        }
        if (typeof window !== "undefined" && mutation.recordId?.startsWith("temp_")) {
          window.dispatchEvent(new CustomEvent("offlineMutationRecordReplaced", {
            detail: {
              entity: mutation.entity,
              oldId: mutation.recordId,
              record: createdRecord
            }
          }));
        }
      } else if (mutation.operation === "update") {
        if (mutation.entity === "Delivery" && mutation.recordId && isDeleted(mutation.recordId)) {
          console.log(`\u{1F6E1}\uFE0F [OfflineSync] Discarding update mutation for deleted delivery ${mutation.recordId}`);
          await offlineDB.removePendingMutation(mutation.mutationId);
          successCount++;
          continue;
        }
        let finalPayload = mutation.entity === "Delivery" ? deliveryPayload : mutation.entity === "AppUser" ? sanitizeAppUserMutationPayload(mutation.payload) : mutation.payload;
        if (mutation.entity === "Delivery" && typeof finalPayload?.status === "string" && !TERMINAL_STATUSES.has(finalPayload.status) && !("actual_delivery_time" in finalPayload)) {
          let shouldStrip = false;
          try {
            const serverRec = await Entity.get(mutation.recordId);
            if (serverRec && TERMINAL_STATUSES.has(String(serverRec.status || ""))) shouldStrip = true;
          } catch (_) {
          }
          if (!shouldStrip) {
            try {
              const localRec = await offlineDB.getById(offlineDB.STORES.DELIVERIES, mutation.recordId);
              if (localRec && TERMINAL_STATUSES.has(String(localRec.status || "")) && localRec.actual_delivery_time) shouldStrip = true;
            } catch (_) {
            }
          }
          if (shouldStrip) {
            console.log(`\u{1F6E1}\uFE0F [OfflineSync] Stripping stale active-status replay for ${mutation.recordId} \u2014 stop is already finished (wanted '${finalPayload.status}')`);
            const { status: _s, actual_delivery_time: _t, arrival_time: _a, ...restPayload } = finalPayload;
            finalPayload = restPayload;
            if (Object.keys(finalPayload).length === 0) {
              await offlineDB.removePendingMutation(mutation.mutationId);
              successCount++;
              continue;
            }
          }
        }
        await Entity.update(mutation.recordId, finalPayload);
        if (mutation.entity === "AppUser" && mutation.driverStatusTransition) {
          await base44.functions.invoke("setDriverStatus", mutation.driverStatusTransition);
          invalidateEntityCache("AppUser");
        }
      }
      await offlineDB.removePendingMutation(mutation.mutationId);
      invalidateEntityCache(mutation.entity);
      if (mutation.entity === "AppUser" && mutation.driverStatusTransition && typeof window !== "undefined") {
        const hasPendingStatus = await hasPendingDriverStatusMutation(mutation.recordId);
        window.dispatchEvent(new CustomEvent("offlineDriverStatusSynced", {
          detail: {
            appUserId: mutation.recordId,
            userId: mutation.driverStatusTransition.targetUserId,
            status: mutation.driverStatusTransition.newStatus,
            hasPendingStatus
          }
        }));
      }
      successCount++;
      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      if (error.response?.status === 404 || error.message?.includes("404") || error.message?.includes("not found")) {
        console.log(`\u23ED\uFE0F [OfflineSync] Removing mutation for deleted record: ${mutation.recordId} (${mutation.entity})`);
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
      }
      const _outcome = await _recordMutationFailure(mutation, error.response?.status === 429);
      failCount++;
    }
  }
  const remainingMutations = await offlineDB.getPendingMutations();
  scheduleDeferredReplay(remainingMutations);
  return { success: failCount === 0, processed: successCount, failed: failCount, remaining: remainingMutations.length };
};
export {
  processPendingMutationsInternal
};
