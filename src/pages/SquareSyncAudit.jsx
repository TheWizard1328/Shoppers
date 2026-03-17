import React, { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, Download, RefreshCw } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useUser } from "@/components/utils/UserContext";
import { isAppOwner } from "@/components/utils/userRoles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import AuditTable from "@/components/square-audit/AuditTable";
import {
  LOOKBACK_DAYS,
  attachDiscrepancies,
  buildStoreMaps,
  downloadAuditCsv,
  formatCurrencyFromCents,
  getAuditRange,
  normalizeDate,
  parseSquareItemName,
  toAmountCents,
} from "@/components/square-audit/squareAuditHelpers";
import { squareFetchPayments } from "@/functions/squareFetchPayments";
import { squareGetCODData } from "@/functions/squareGetCODData";
import { squareSyncCatalogItems } from "@/functions/squareSyncCatalogItems";

export default function SquareSyncAudit() {
  const { currentUser, isLoadingUser } = useUser();
  const [isLoading, setIsLoading] = React.useState(true);
  const [isReconciling, setIsReconciling] = React.useState(false);
  const [lastLoadedAt, setLastLoadedAt] = React.useState(null);
  const [tables, setTables] = React.useState({
    transactions: [],
    catalogItems: [],
    deliveries: [],
  });

  const loadAuditData = React.useCallback(async () => {
    const range = getAuditRange();
    setIsLoading(true);

    try {
      const [locationConfigs, stores, patients, deliveriesResponse] = await Promise.all([
        base44.entities.SquareLocationConfig.filter({ status: "active" }),
        base44.entities.Store.list(),
        base44.entities.Patient.list(),
        base44.entities.Delivery.filter({
          delivery_date: {
            $gte: range.startDate,
            $lte: range.endDate,
          },
        }),
      ]);

      const locationIds = (locationConfigs || []).map((config) => config.square_location_id).filter(Boolean);
      const [paymentsResponse, codDataResponse] = await Promise.all([
        squareFetchPayments({ locationIds, daysBack: LOOKBACK_DAYS, maxPerLocation: 100 }),
        squareGetCODData({}),
      ]);

      const paymentsData = paymentsResponse?.data || paymentsResponse || {};
      const codData = codDataResponse?.data || codDataResponse || {};
      const deliveries = (deliveriesResponse || []).filter(
        (delivery) => Number(delivery?.cod_total_amount_required || 0) > 0,
      );

      const { locationIdByStoreId, storeByLocationId, storeById, storeByAbbreviation } = buildStoreMaps(stores || [], locationConfigs || []);
      const patientById = new Map((patients || []).map((patient) => [patient.id, patient]));
      const deliveryById = new Map(deliveries.map((delivery) => [delivery.id, delivery]));

      const transactionRowsBase = (paymentsData.soldCatalogItems || []).map((item, index) => {
        const parsed = parseSquareItemName(item.item_name);
        const inferredStore = parsed?.store_abbreviation ? storeByAbbreviation.get(parsed.store_abbreviation) : null;
        const locationId = item.location_id || locationIdByStoreId.get(inferredStore?.id) || "";
        const amountCents = toAmountCents(item.amount);

        return {
          id: `tx-${item.payment_id || item.order_id || index}`,
          itemName: item.item_name || "Unnamed Transaction",
          date: normalizeDate(parsed?.delivery_date || item.payment_date),
          locationId,
          storeId: inferredStore?.id || "",
          storeName: inferredStore?.name || storeByLocationId.get(locationId)?.name || "Unknown Store",
          amountCents,
          amountLabel: formatCurrencyFromCents(amountCents),
          paymentId: item.payment_id || "",
          orderId: item.order_id || "",
        };
      });

      const catalogRowsBase = (codData.catalogItems || []).map((item, index) => {
        const parsed = parseSquareItemName(item.name || item.item_name);
        const delivery = item.delivery_id ? deliveryById.get(item.delivery_id) : null;
        const locationId = item.location_id || "";
        const store = storeByLocationId.get(locationId) || storeByAbbreviation.get(parsed?.store_abbreviation || "");
        const amountCents = Number(item.price_cents ?? item.amount_cents ?? 0);

        return {
          id: `catalog-${item.catalog_object_id || index}`,
          itemName: item.name || item.item_name || "Unnamed Catalog Item",
          date: normalizeDate(item.delivery_date || delivery?.delivery_date || parsed?.delivery_date),
          locationId,
          storeId: store?.id || delivery?.store_id || "",
          storeName: store?.name || "Unknown Store",
          amountCents,
          amountLabel: formatCurrencyFromCents(amountCents),
          catalogObjectId: item.catalog_object_id || "",
          status: item.status || "active",
        };
      });

      const deliveryRowsBase = deliveries.map((delivery) => {
        const locationId = locationIdByStoreId.get(delivery.store_id) || "";
        const store = storeById.get(delivery.store_id);
        const patient = patientById.get(delivery.patient_id);
        const amountCents = toAmountCents(delivery.cod_total_amount_required);
        const exportReference = store?.abbreviation && patient?.full_name
          ? `${String(delivery.delivery_date || "").slice(5, 7)}/${String(delivery.delivery_date || "").slice(8, 10)}(${store.abbreviation})-${patient.full_name}`
          : delivery.delivery_id || delivery.id;

        return {
          id: `delivery-${delivery.id}`,
          itemName: delivery.patient_id || delivery.delivery_id || delivery.id,
          date: normalizeDate(delivery.delivery_date),
          locationId,
          storeId: delivery.store_id || "",
          storeName: store?.name || "Unknown Store",
          amountCents,
          amountLabel: formatCurrencyFromCents(amountCents),
          deliveryId: delivery.id,
          exportReference,
          status: delivery.status || "pending",
        };
      });

      const transactionRows = attachDiscrepancies(transactionRowsBase, [
        { label: "Catalog", rows: catalogRowsBase },
        { label: "Deliveries", rows: deliveryRowsBase },
      ]);
      const catalogRows = attachDiscrepancies(catalogRowsBase, [
        { label: "Transactions", rows: transactionRowsBase },
        { label: "Deliveries", rows: deliveryRowsBase },
      ]);
      const deliveryRows = attachDiscrepancies(deliveryRowsBase, [
        { label: "Transactions", rows: transactionRowsBase },
        { label: "Catalog", rows: catalogRowsBase },
      ]);

      setTables({
        transactions: transactionRows,
        catalogItems: catalogRows,
        deliveries: deliveryRows,
      });
      setLastLoadedAt(new Date());
    } catch (error) {
      console.error("Square COD audit load failed:", error);
      toast.error(error?.message || "Failed to load Square COD audit data");
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!isLoadingUser && currentUser && isAppOwner(currentUser)) {
      loadAuditData();
    }
  }, [currentUser, isLoadingUser, loadAuditData]);

  const handleReconciliation = async () => {
    setIsReconciling(true);
    try {
      const response = await squareSyncCatalogItems({ skipLock: true });
      const data = response?.data || response || {};
      if (!data.success) {
        throw new Error(data.error || "Reconciliation failed");
      }
      toast.success("Square reconciliation completed");
      await loadAuditData();
    } catch (error) {
      console.error("Square reconciliation failed:", error);
      toast.error(error?.message || "Failed to trigger reconciliation");
    } finally {
      setIsReconciling(false);
    }
  };

  const handleExport = () => {
    downloadAuditCsv(
      [
        {
          title: "Collected Square Transactions",
          headers: ["Date", "Store", "Square Location ID", "Amount", "Item Name", "Payment ID", "Order ID", "Issues"],
          rows: tables.transactions.map((row) => [
            row.date,
            row.storeName,
            row.locationId,
            row.amountLabel,
            row.itemName,
            row.paymentId,
            row.orderId,
            row.issues.join(" | "),
          ]),
        },
        {
          title: "Current Square Catalog Items",
          headers: ["Date", "Store", "Square Location ID", "Amount", "Item Name", "Catalog Object ID", "Status", "Issues"],
          rows: tables.catalogItems.map((row) => [
            row.date,
            row.storeName,
            row.locationId,
            row.amountLabel,
            row.itemName,
            row.catalogObjectId,
            row.status,
            row.issues.join(" | "),
          ]),
        },
        {
          title: "In-App COD Deliveries",
          headers: ["Date", "Store", "Square Location ID", "Amount", "Reference", "Status", "Issues"],
          rows: tables.deliveries.map((row) => [
            row.date,
            row.storeName,
            row.locationId,
            row.amountLabel,
            row.exportReference,
            row.status,
            row.issues.join(" | "),
          ]),
        },
      ],
      `square-cod-audit-${format(new Date(), "yyyy-MM-dd-HHmm")}.csv`,
    );
  };

  const summary = React.useMemo(() => {
    const transactionIssues = tables.transactions.filter((row) => row.hasDiscrepancy).length;
    const catalogIssues = tables.catalogItems.filter((row) => row.hasDiscrepancy).length;
    const deliveryIssues = tables.deliveries.filter((row) => row.hasDiscrepancy).length;
    return transactionIssues + catalogIssues + deliveryIssues;
  }, [tables]);

  if (isLoadingUser || (isLoading && !lastLoadedAt)) {
    return <div className="p-6 text-sm" style={{ color: "var(--text-slate-500)" }}>Loading Square COD audit…</div>;
  }

  if (!currentUser || !isAppOwner(currentUser)) {
    return <div className="p-6 text-sm" style={{ color: "var(--text-slate-500)" }}>This page is only available to the App Owner.</div>;
  }

  return (
    <div className="h-[calc(100vh-1rem)] overflow-hidden p-4 md:h-[calc(100vh-1.5rem)] md:p-6" style={{ background: "var(--bg-slate-50)" }}>
      <div className="flex h-full w-full flex-col gap-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: "var(--text-slate-900)" }}>Square COD Audit</h1>
            <p className="text-sm" style={{ color: "var(--text-slate-500)" }}>
              Comparing collected transactions, current Square catalog items, and in-app COD deliveries using Date + Square Location ID + Amount.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={handleExport} className="gap-2">
              <Download className="h-4 w-4" />
              Download CSV
            </Button>
            <Button onClick={handleReconciliation} disabled={isReconciling} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${isReconciling ? "animate-spin" : ""}`} />
              Trigger Reconciliation
            </Button>
          </div>
        </div>

        <Card className="shadow-sm" style={{ borderColor: "var(--border-slate-200)", background: "var(--bg-white)" }}>
          <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="border" style={{ background: "var(--bg-slate-100)", color: "var(--text-slate-700)", borderColor: "var(--border-slate-200)" }}>
                {tables.transactions.length} transactions
              </Badge>
              <Badge variant="secondary" className="border" style={{ background: "var(--bg-slate-100)", color: "var(--text-slate-700)", borderColor: "var(--border-slate-200)" }}>
                {tables.catalogItems.length} catalog items
              </Badge>
              <Badge variant="secondary" className="border" style={{ background: "var(--bg-slate-100)", color: "var(--text-slate-700)", borderColor: "var(--border-slate-200)" }}>
                {tables.deliveries.length} in-app deliveries
              </Badge>
              {summary > 0 && (
                <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                  <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                  {summary} flagged rows
                </Badge>
              )}
            </div>
            <div className="text-xs" style={{ color: "var(--text-slate-500)" }}>
              Last loaded {lastLoadedAt ? format(lastLoadedAt, "MMM d, yyyy h:mm a") : "—"}
            </div>
          </CardContent>
        </Card>

        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          <div className="space-y-4">
        <AuditTable
          title="Collected Square Transactions"
          description="Fresh Square payment/order items used as the collected transaction audit source."
          rows={tables.transactions}
          defaultSortKey="date"
          columns={[
            { key: "date", label: "Date", headerClassName: "whitespace-nowrap w-[120px]", cellClassName: "whitespace-nowrap" },
            { key: "storeName", label: "Store", sortValue: (row) => row.storeName },
            { key: "locationId", label: "Square Location ID" },
            { key: "amountCents", label: "Amount", render: (row) => row.amountLabel, sortValue: (row) => row.amountCents, headerClassName: "whitespace-nowrap" },
            { key: "itemName", label: "Item Name", headerClassName: "whitespace-nowrap min-w-[320px]", cellClassName: "whitespace-nowrap" },
            { key: "paymentId", label: "Payment ID", headerClassName: "whitespace-nowrap" },
            { key: "orderId", label: "Order ID", headerClassName: "whitespace-nowrap" },
          ]}
        />

        <AuditTable
          title="Current Square Catalog Items"
          description="Current active COD-style catalog items available in Square."
          rows={tables.catalogItems}
          defaultSortKey="date"
          columns={[
            { key: "date", label: "Date", headerClassName: "whitespace-nowrap w-[120px]", cellClassName: "whitespace-nowrap" },
            { key: "storeName", label: "Store", sortValue: (row) => row.storeName },
            { key: "locationId", label: "Square Location ID" },
            { key: "amountCents", label: "Amount", render: (row) => row.amountLabel, sortValue: (row) => row.amountCents, headerClassName: "whitespace-nowrap" },
            { key: "itemName", label: "Item Name", headerClassName: "whitespace-nowrap min-w-[320px]", cellClassName: "whitespace-nowrap" },
            { key: "catalogObjectId", label: "Catalog Object ID", headerClassName: "whitespace-nowrap" },
            { key: "status", label: "Status", headerClassName: "whitespace-nowrap" },
          ]}
        />

        <AuditTable
          title="In-App COD Deliveries"
          description="Deliveries from the app that still require COD comparison against Square."
          rows={tables.deliveries}
          defaultSortKey="date"
          columns={[
            { key: "date", label: "Date", headerClassName: "whitespace-nowrap w-[120px]", cellClassName: "whitespace-nowrap" },
            { key: "storeName", label: "Store", sortValue: (row) => row.storeName },
            { key: "locationId", label: "Square Location ID" },
            { key: "amountCents", label: "Amount", render: (row) => row.amountLabel, sortValue: (row) => row.amountCents, headerClassName: "whitespace-nowrap" },
            { key: "deliveryId", label: "Delivery ID", headerClassName: "whitespace-nowrap" },
            { key: "status", label: "Status", headerClassName: "whitespace-nowrap" },
            { key: "itemName", label: "Reference", headerClassName: "whitespace-nowrap min-w-[320px]", cellClassName: "whitespace-nowrap" },
          ]}
        />
          </div>
        </div>
      </div>
    </div>
  );
}