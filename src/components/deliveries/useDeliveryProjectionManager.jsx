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

  const blockPredictions = useCallback(() => {
    predictionsBlockedRef.current = true;
    setProjectedDeliveries([]);
    setIsLoadingPredictions(true);
  }, []);

  const unblockPredictions = useCallback(() => {
    predictionsBlockedRef.current = false;
  }, []);

  useEffect(() => {
    if (delivery || !selectedDate || !currentUser || !stores || !allDeliveries) {
      fullPredictionListRef.current = [];
      setProjectedDeliveries([]);
      setIsLoadingPredictions(false);
      return;
    }

    if (predictionsBlockedRef.current) return;

    setIsLoadingPredictions(true);

    try {
      rebuildProjectedDeliveries();
    } catch {
      fullPredictionListRef.current = [];
      setProjectedDeliveries([]);
    } finally {
      setIsLoadingPredictions(false);
    }
  }, [delivery, selectedDate, currentUser, stores, patients, allDeliveries, stagedDeliveries, rebuildProjectedDeliveries]);

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