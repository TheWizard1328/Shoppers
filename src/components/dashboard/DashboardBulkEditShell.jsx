import React, { useMemo, useState, useCallback } from "react";
import StopCardsSection from "@/components/dashboard/StopCardsSection";
import DashboardBulkEditControls from "@/components/dashboard/DashboardBulkEditControls";

export default function DashboardBulkEditShell(props) {
  const [selectedDeliveryIds, setSelectedDeliveryIds] = useState({});

  const selectedDeliveries = useMemo(() => {
    const ids = Object.keys(selectedDeliveryIds).filter((id) => selectedDeliveryIds[id]);
    if (ids.length === 0) return [];
    const idSet = new Set(ids);
    return (props.deliveriesWithStopOrder || []).filter((delivery) => delivery?.id && idSet.has(delivery.id));
  }, [props.deliveriesWithStopOrder, selectedDeliveryIds]);

  const handleSelectionChange = useCallback((deliveryId, selected) => {
    setSelectedDeliveryIds((current) => {
      const next = { ...current };
      if (selected) next[deliveryId] = true;
      else delete next[deliveryId];
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedDeliveryIds({}), []);

  return (
    <>
      <DashboardBulkEditControls
        deliveriesWithStopOrder={props.deliveriesWithStopOrder}
        drivers={props.drivers}
        stores={props.stores}
        allDeliveries={props.deliveries}
        currentUser={props.currentUser}
        isMobile={props.isMobile}
        stopCardsBaseHeight={props.stopCardsBaseHeight}
        immersiveHidden={props.immersiveHidden}
        refreshData={props.refreshData}
        selectedDeliveries={selectedDeliveries}
        onClearSelection={clearSelection}
      />
      <StopCardsSection
        {...props}
        bulkSelectionEnabled={true}
        selectedDeliveryIds={selectedDeliveryIds}
        onSelectionChange={handleSelectionChange}
      />
    </>
  );
}