import { useCallback, useEffect, useRef, useState } from "react";
import { getLocalDeliveryPredictions } from "./getLocalDeliveryPredictions";

const MIN_REFRESH_INDICATOR_MS = 900;

const filterPredictionsAgainstStaged = ({ predictions, stagedDeliveries, allDeliveries, selectedDate }) => {
  const stagedPatientIds = new Set((stagedDeliveries || []).map((item) => item?.patient_id).filter(Boolean));

  return (predictions || []).filter((prediction) => {
    if (!prediction?.patient_id) return false;
    if (stagedPatientIds.has(prediction.patient_id)) return false;
    return !(allDeliveries || []).some(
      (delivery) => delivery && delivery.delivery_date === selectedDate && delivery.patient_id === prediction.patient_id
    );
  });
};

export default function useDeliveryProjectionManager({
  delivery,
  currentUser,
  stores,
  patients,
  allDeliveries,
  selectedDate,
  stagedDeliveries,
  scheduledDriverMap
}) {
  const [projectedDeliveries, setProjectedDeliveries] = useState([]);
  const [isLoadingPredictions, setIsLoadingPredictions] = useState(false);
  const fullPredictionListRef = useRef([]);
  const predictionsBlockedRef = useRef(false);
  const rebuildTokenRef = useRef(0);
  const idleHandleRef = useRef(null);

  const rebuildProjectedDeliveries = useCallback(() => {
    const nextPredictions = getLocalDeliveryPredictions({
      currentUser,
      stores,
      patients,
      allDeliveries,
      selectedDate,
      scheduledDriverMap
    });

    fullPredictionListRef.current = nextPredictions;
    setProjectedDeliveries(
      filterPredictionsAgainstStaged({
        predictions: nextPredictions,
        stagedDeliveries,
        allDeliveries,
        selectedDate
      })
    );

    return nextPredictions;
  }, [currentUser, stores, patients, allDeliveries, selectedDate, stagedDeliveries, scheduledDriverMap]);

  const handleRefreshProjections = useCallback(async () => {
    if (predictionsBlockedRef.current) return;

    setIsLoadingPredictions(true);
    const startedAt = Date.now();

    try {
      rebuildProjectedDeliveries();
    } catch {
      fullPredictionListRef.current = [];
      setProjectedDeliveries([]);
    } finally {
      const remainingMs = Math.max(0, MIN_REFRESH_INDICATOR_MS - (Date.now() - startedAt));
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }
      setIsLoadingPredictions(false);
    }
  }, [rebuildProjectedDeliveries]);

  // ── Deferred (non-blocking) projection rebuild ────────────────────────────
  // OWNER REPORT (Oct 28 2026): "the projections are getting refreshed when the
  // done button is being clicked" and that slowed the Done processing. The
  // rebuild ran SYNCHRONOUSLY inside the effect, and the Done flow changes
  // allDeliveries/stagedDeliveries identity repeatedly (optimistic writes, then
  // the real save), so a full patient-wide projection pass kept landing on the
  // main thread in the middle of the save. Rebuilds are now scheduled for idle
  // time and cancellable, and a blocked (saving) form schedules nothing at all.
  const cancelScheduledRebuild = useCallback(() => {
    rebuildTokenRef.current += 1;
    if (idleHandleRef.current !== null) {
      try {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandleRef.current);
        else clearTimeout(idleHandleRef.current);
      } catch { /* noop */ }
      idleHandleRef.current = null;
    }
  }, []);

  const scheduleRebuild = useCallback(() => {
    cancelScheduledRebuild();
    const token = rebuildTokenRef.current;
    const run = () => {
      idleHandleRef.current = null;
      if (token !== rebuildTokenRef.current) return;      // superseded
      if (predictionsBlockedRef.current) return;           // form is saving
      setIsLoadingPredictions(true);
      try {
        rebuildProjectedDeliveries();
      } catch {
        fullPredictionListRef.current = [];
        setProjectedDeliveries([]);
      } finally {
        setIsLoadingPredictions(false);
      }
    };
    try {
      idleHandleRef.current = typeof requestIdleCallback === 'function'
        ? requestIdleCallback(run, { timeout: 500 })
        : setTimeout(run, 60);
    } catch {
      idleHandleRef.current = setTimeout(run, 60);
    }
  }, [cancelScheduledRebuild, rebuildProjectedDeliveries]);

  const blockPredictions = useCallback(() => {
    predictionsBlockedRef.current = true;
    cancelScheduledRebuild();          // kill any queued rebuild
    setProjectedDeliveries([]);
    // No spinner: the Done/save path must not look like it is refreshing
    // projections while it is committing the route.
    setIsLoadingPredictions(false);
  }, [cancelScheduledRebuild]);

  const unblockPredictions = useCallback(() => {
    predictionsBlockedRef.current = false;
    // Repopulate lazily, never synchronously on the save path.
    scheduleRebuild();
  }, [scheduleRebuild]);

  useEffect(() => {
    if (delivery || !selectedDate || !currentUser || !stores || !allDeliveries) {
      cancelScheduledRebuild();
      fullPredictionListRef.current = [];
      setProjectedDeliveries([]);
      setIsLoadingPredictions(false);
      return undefined;
    }

    if (predictionsBlockedRef.current) return undefined;

    scheduleRebuild();
    return cancelScheduledRebuild;
  }, [delivery, selectedDate, currentUser, stores, patients, allDeliveries, stagedDeliveries, rebuildProjectedDeliveries, scheduleRebuild, cancelScheduledRebuild]);

  // Cancel any queued rebuild when the form unmounts (Done closes it).
  useEffect(() => () => cancelScheduledRebuild(), [cancelScheduledRebuild]);

  return {
    projectedDeliveries,
    setProjectedDeliveries,
    isLoadingPredictions,
    setIsLoadingPredictions,
    fullPredictionListRef,
    handleRefreshProjections,
    blockPredictions,
    unblockPredictions
  };
}