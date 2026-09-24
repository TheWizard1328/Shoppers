import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarRange, CreditCard, Download, Flag, RefreshCw, Search, Table2, Wallet } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { invokeWithLongTimeout } from "@/components/utils/squareLongTimeout";
import { useUser } from "@/components/utils/UserContext";
import { edmontonWallString, parseAnyTimestamp } from "@/components/utils/albertaTime";
import {
  getLedgerEntriesOffline,
  getLedgerLastSyncAt,
  saveLedgerEntriesOffline,
} from "@/components/utils/squareLedgerOfflineManager";
import SyncHealthPanel from "@/components/square-audit/SyncHealthPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

const CARD_LABELS_KEY = "square_card_labels";
const FETCH_PAGE = 2000;
const FETCH_PAGES_MAX = 15; // 30k records cap
const LEDGER_PAGE_SIZE = 100;

// ---------- pure helpers (Edmonton wall-clock rendering — never device-local) ----------

const fmtCents = (c) => `$${(Math.abs(Number(c || 0)) / 100).toFixed(2)}`;

const wallOf = (occurredAt) => {
  if (!occurredAt) return "1970-01-01T00:00:00";
  const d = parseAnyTimestamp(occurredAt);
  return edmontonWallString(d);
};

const displayDateTime = (wall) => String(wall || "").replace("T", " ").slice(0, 16);

const weekKeyOf = (wall) => {
  const y = Number(String(wall).slice(0, 4));
  const mo = Number(String(wall).slice(5, 7));
  const d = Number(String(wall).slice(8, 10));
  const utc = Date.UTC(y, mo - 1, d);
  const dow = new Date(utc).getUTCDay();
  const monday = utc - ((dow + 6) % 7) * 86400000;
  const m = new Date(monday);
  const mm = String(m.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(m.getUTCDate()).padStart(2, "0");
  return `${m.getUTCFullYear()}-${mm}-${dd}`;
};

const periodKeyOf = (wall, granularity) => {
  if (granularity === "year") return String(wall).slice(0, 4);
  if (granularity === "month") return String(wall).slice(0, 7);
  if (granularity === "week") return weekKeyOf(String(wall));
  return String(wall).slice(0, 10);
};

const periodLabelOf = (key, granularity) => {
  if (granularity === "year") return key;
  if (granularity === "month") return key;
  if (granularity === "week") return `Wk of ${String(key).slice(5).replace("-", "/")}`;
  return String(key).slice(5).replace("-", "/");
};

const RANGE_MONTHS_BY_VALUE = { today: 1, "1": 1, "3": 3, "6": 6, "12": 12, "24": 24 };

const rangeSelectionToMonths = (val) => RANGE_MONTHS_BY_VALUE[val] || 3;

const rangeSelectionToDates = (val) => {
  const todayWall = edmontonWallString(new Date()).slice(0, 10);
  if (val === "today") return { from: todayWall, to: todayWall };
  const months = RANGE_MONTHS_BY_VALUE[val] || 3;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return { from: edmontonWallString(start).slice(0, 10), to: todayWall };
};

const monthWindowUtc = (monthsAgo) => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 1));
  return { start: start.toISOString().slice(0, 10) + "T00:00:00Z", end: end.toISOString().slice(0, 10) + "T00:00:00Z", label: start.toISOString().slice(0, 7) };
};

// ---------- classification ----------

const CLASS_STYLES = {
  cod: { badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300", amount: "text-emerald-600 dark:text-emerald-400", sign: 1 },
  spend: { badge: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300", amount: "text-red-600 dark:text-red-400", sign: -1 },
  other: { badge: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300", amount: "text-sky-600 dark:text-sky-400", sign: 1 },
  decline: { badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", amount: "text-amber-600 dark:text-amber-400", sign: 0 },
  refund_in: { badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300", amount: "text-emerald-600 dark:text-emerald-400", sign: 1 },
  refund_out: { badge: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300", amount: "text-orange-600 dark:text-orange-400", sign: -1 },
  refund_unlinked: { badge: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200", amount: "text-slate-700 dark:text-slate-300", sign: 1 },
  payout: { badge: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300", amount: "text-violet-600 dark:text-violet-400", sign: 0 },
};

const CLASS_LABELS = {
  cod: "COD Collected",
  spend: "Card Spend",
  other: "Other Sale",
  decline: "Declined",
  refund_in: "Refund (charge)",
  refund_out: "Refund (customer)",
  refund_unlinked: "Refund",
  payout: "Bank Transfer",
};

const classifyEntry = (entry, labelsByFingerprint, entriesBySquareId) => {
  if (entry.entry_kind === "refund") {
    const linked = entry.refund_of_square_id ? entriesBySquareId.get(entry.refund_of_square_id) : null;
    const linkedClass = linked ? classifyEntry(linked, labelsByFingerprint, entriesBySquareId) : null;
    if (linkedClass && (linkedClass.code === "spend" || linkedClass.code === "other" && linked?.card_fingerprint && labelsByFingerprint[linked.card_fingerprint]?.is_business_card)) {
      return { code: "refund_in", sign: 1 };
    }
    if (linkedClass) return { code: "refund_out", sign: -1 };
    return { code: "refund_unlinked", sign: 1 };
  }
  if (entry.entry_kind === "decline") return { code: "decline", sign: 0 };
  if (entry.entry_kind === "payout") return { code: "payout", sign: 0 };
  if (entry.entry_kind === "sale") {
    if (entry.sale_class === "cod_collection") return { code: "cod", sign: 1 };
    const label = entry.card_fingerprint ? labelsByFingerprint[entry.card_fingerprint] : null;
    if (label?.is_business_card) return { code: "spend", sign: -1 };
    return { code: "other", sign: 1 };
  }
  return { code: "other", sign: 0 };
};

// ---------- page component ----------

export default function SquareSyncAudit() {
  const { currentUser, isLoadingUser } = useUser();
  const [activeTab, setActiveTab] = useState("ledger");
  const [entries, setEntries] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState("");
  const [storesById, setStoresById] = useState({});
  const [cardLabels, setCardLabels] = useState([]);
  const [cardLabelsRecordId, setCardLabelsRecordId] = useState(null);
  const [isSavingLabels, setIsSavingLabels] = useState(false);
  const [syncHealth, setSyncHealth] = useState({ runs: [], logs: [] });
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");
  const [lastSyncResult, setLastSyncResult] = useState(null);
  const [lastLedgerSyncAt, setLastLedgerSyncAt] = useState(null);
  const [rangeSelection, setRangeSelection] = useState("24");

  // ledger filters
  const [kindFilter, setKindFilter] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [ledgerLimit, setLedgerLimit] = useState(LEDGER_PAGE_SIZE);
  const [selectedLocations, setSelectedLocations] = useState([]);
  const [granularity, setGranularity] = useState("month");
  const syncAbortRef = useRef(false);

  const isAdmin = !isLoadingUser && (currentUser?.role === "admin" || currentUser?.email === "tauberr1328" || String(currentUser?.email || "").toLowerCase() === "the.wizard@live.ca");

  // ---------- data loading ----------

  const fetchLedgerFromServer = useCallback(async () => {
    const all = [];
    try {
      for (let page = 0; page < FETCH_PAGES_MAX; page++) {
        setLoadProgress(`Loading ledger ${all.length ? `(${all.length} records)` : ""}…`);
        const rows = await base44.entities.SquareLedgerEntry.list("-occurred_at", FETCH_PAGE, page * FETCH_PAGE).catch(() => []);
        const list = rows || [];
        all.push(...list);
        if (list.length < FETCH_PAGE) break;
      }
      setEntries(all);
      if (all.length > 0) {
        saveLedgerEntriesOffline(all);
        setLastLedgerSyncAt(getLedgerLastSyncAt());
      }
    } catch (error) {
      console.error("[SquareFinanceAudit] Error loading ledger:", error);
      toast.error("Failed to load ledger from server");
    } finally {
      setLoadProgress("");
    }
  }, []);

  const loadCardLabels = useCallback(async () => {
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: CARD_LABELS_KEY });
      const record = (rows || [])[0] || null;
      if (record) {
        setCardLabelsRecordId(record.id);
        const labels = record?.setting_value?.labels;
        setCardLabels(Array.isArray(labels) ? labels : []);
      }
    } catch (error) {
      console.error("[SquareFinanceAudit] Error loading card labels:", error);
    }
  }, []);

  const loadStores = useCallback(async () => {
    try {
      const rows = await base44.entities.Store.list();
      const map = {};
      for (const s of rows || []) map[s.id] = s;
      setStoresById(map);
    } catch {
      setStoresById({});
    }
  }, []);

  const loadSyncHealth = useCallback(async () => {
    try {
      const res = await invokeWithLongTimeout("squareSyncHealth", {});
      setSyncHealth(res?.data || res || { runs: [], logs: [] });
    } catch {
      setSyncHealth({ runs: [], logs: [] });
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      // IDB first — render immediately from the offline snapshot
      const cached = await getLedgerEntriesOffline();
      if (!cancelled && cached.length > 0) {
        setEntries(cached);
        setIsLoading(false);
      }
      setLastLedgerSyncAt(getLedgerLastSyncAt());
      await Promise.all([fetchLedgerFromServer(), loadCardLabels(), loadStores()]);
      if (!cancelled) setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [isAdmin, fetchLedgerFromServer, loadCardLabels, loadStores]);

  // ---------- derived data ----------

  const entriesBySquareId = useMemo(() => {
    const m = new Map();
    for (const e of entries || []) if (e.square_id) m.set(e.square_id, e);
    return m;
  }, [entries]);

  const labelsByFingerprint = useMemo(() => {
    const m = {};
    for (const l of cardLabels || []) if (l?.fingerprint) m[l.fingerprint] = l;
    return m;
  }, [cardLabels]);

  const locations = useMemo(() => {
    const m = new Map();
    for (const e of entries || []) {
      if (e.location_id) m.set(e.location_id, e.location_name || e.location_id);
    }
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  }, [entries]);

  const activeLocations = useMemo(() => {
    if (selectedLocations.length === 0) return locations;
    return locations.filter((l) => selectedLocations.includes(l.id));
  }, [locations, selectedLocations]);

  const fingerprintStats = useMemo(() => {
    const stats = new Map();
    for (const e of entries || []) {
      if (!e.card_fingerprint) continue;
      if (!stats.has(e.card_fingerprint)) {
        stats.set(e.card_fingerprint, {
          fingerprint: e.card_fingerprint,
          last4: e.card_last4 || "",
          brand: e.card_brand || "",
          locations: new Set(),
          saleCount: 0,
          saleTotal: 0,
          declineCount: 0,
          lastSeen: "",
        });
      }
      const st = stats.get(e.card_fingerprint);
      if (e.location_name) st.locations.add(e.location_name);
      const cls = classifyEntry(e, labelsByFingerprint, entriesBySquareId);
      if (e.entry_kind === "sale") { st.saleCount++; st.saleTotal += Number(e.amount_cents || 0); }
      if (e.entry_kind === "decline") st.declineCount++;
      if (e.occurred_at > st.lastSeen) st.lastSeen = e.occurred_at;
    }
    return Array.from(stats.values()).map((st) => ({
      ...st,
      locations: Array.from(st.locations),
      likelyBusinessCard: st.locations.length >= 2,
    }));
  }, [entries, labelsByFingerprint, entriesBySquareId]);

  const enhancedEntries = useMemo(() => {
    return (entries || []).map((e) => {
      const cls = classifyEntry(e, labelsByFingerprint, entriesBySquareId);
      const wall = wallOf(e.occurred_at);
      return { ...e, cls, wall, classCode: cls.code };
    });
  }, [entries, labelsByFingerprint, entriesBySquareId]);

  const filteredEntries = useMemo(() => {
    const from = fromDate ? `${fromDate}T00:00:00` : "";
    const to = toDate ? `${toDate}T23:59:59` : "";
    const search = searchText.trim().toLowerCase();
    const locSet = selectedLocations.length ? new Set(selectedLocations) : null;
    return enhancedEntries
      .filter((e) => {
        if (locSet && !locSet.has(e.location_id)) return false;
        if (from && e.wall < from) return false;
        if (to && e.wall > to) return false;
        if (kindFilter !== "all" && e.classCode !== kindFilter) return false;
        if (search) {
          const hay = `${e.location_name || ""} ${e.cod_item_name || ""} ${e.reason || ""} ${e.card_brand || ""} ${e.card_last4 || ""}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  }, [enhancedEntries, fromDate, toDate, kindFilter, searchText, selectedLocations]);

  const summaryRows = useMemo(() => {
    const from = fromDate ? `${fromDate}T00:00:00` : "0000";
    const to = toDate ? `${toDate}T23:59:59` : "9999";
    const locSet = selectedLocations.length ? new Set(selectedLocations) : null;
    const rows = new Map();
    for (const e of enhancedEntries) {
      if (locSet && !locSet.has(e.location_id)) continue;
      if (e.wall < from || e.wall > to) continue;
      const key = periodKeyOf(e.wall, granularity);
      const locKey = `${key}::${e.location_id}`;
      const getBucket = (k) => {
        if (!rows.has(k)) rows.set(k, { collected: 0, spent: 0, other: 0, refundIn: 0, refundOut: 0, declines: 0, payout: 0, count: 0 });
        return rows.get(k);
      };
      const b = getBucket(locKey);
      b.count++;
      const amt = Number(e.amount_cents || 0);
      switch (e.classCode) {
        case "cod": b.collected += amt; break;
        case "spend": b.spent += amt; break;
        case "other": b.other += amt; break;
        case "refund_in": b.refundIn += amt; break;
        case "refund_out": b.refundOut += amt; break;
        case "decline": b.declines++; break;
        case "payout": b.payout += amt; break;
        default: break;
      }
    }
    return rows;
  }, [enhancedEntries, fromDate, toDate, selectedLocations, granularity]);

  const netOf = (b) => (b ? b.collected + b.other + b.refundIn - b.spent - b.refundOut : 0);

  const totals = useMemo(() => {
    let collected = 0, spent = 0, other = 0, refundIn = 0, refundOut = 0, declines = 0;
    for (const [, b] of summaryRows) {
      collected += b.collected; spent += b.spent; other += b.other;
      refundIn += b.refundIn; refundOut += b.refundOut; declines += b.declines;
    }
    return { collected, spent, other, refundIn, refundOut, declines, net: collected + other + refundIn - spent - refundOut };
  }, [summaryRows]);

  // ---------- red flags ----------

  const [redFlags, setRedFlags] = useState(null);
  const [isLoadingFlags, setIsLoadingFlags] = useState(false);

  const loadRedFlags = useCallback(async () => {
    setIsLoadingFlags(true);
    try {
      const toWall = edmontonWallString(new Date()).slice(0, 10);
      const fromWall = edmontonWallString(new Date(Date.now() - 90 * 86400000)).slice(0, 10);
      const deliveries = await base44.entities.Delivery.filter({
        delivery_date: { $gte: fromWall, $lte: toWall },
      }, "-updated_date", 2000).catch(() => []);
      const flagged = (deliveries || []).filter((d) =>
        ["failed", "returned"].includes(String(d?.status || "").toLowerCase())
      );
      const collectedByDelivery = new Map();
      for (const e of enhancedEntries) {
        if (e.entry_kind === "sale" && e.sale_class === "cod_collection" && e.delivery_id) {
          collectedByDelivery.set(e.delivery_id, e);
        }
      }
      const refundByDelivery = new Map();
      for (const e of enhancedEntries) {
        if (e.entry_kind === "refund" && e.delivery_id) refundByDelivery.set(e.delivery_id, e);
      }
      const unlinkedRefunds = enhancedEntries
        .filter((e) => e.entry_kind === "refund" && !e.delivery_id)
        .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
        .slice(0, 50);
      const rows = flagged.map((d) => {
        const collected = collectedByDelivery.get(d.id) || null;
        const refund = refundByDelivery.get(d.id) || null;
        return {
          id: d.id,
          date: d.delivery_date,
          status: d.status,
          storeName: storesById[d.store_id]?.name || "Unknown store",
          codRequired: d.cod_total_amount_required || 0,
          collected: collected ? { amount: collected.amount_cents, wall: collected.wall, item: collected.cod_item_name } : null,
          refund: refund ? { amount: refund.amount_cents, wall: refund.wall } : null,
          needsRefund: Boolean(collected) && !refund,
        };
      });
      setRedFlags({ rows: rows.sort((a, b) => (a.date < b.date ? 1 : -1)), unlinkedRefunds });
    } catch (error) {
      console.error("[SquareFinanceAudit] Error loading red flags:", error);
      toast.error("Failed to load red flags");
    } finally {
      setIsLoadingFlags(false);
    }
  }, [enhancedEntries, storesById]);

  useEffect(() => {
    if (activeTab === "flags" && redFlags === null && isAdmin) {
      loadRedFlags();
    }
  }, [activeTab, redFlags, isAdmin, loadRedFlags]);

  // Range-selection dropdown drives the displayed date window for Ledger + Summaries
  useEffect(() => {
    const { from, to } = rangeSelectionToDates(rangeSelection);
    setFromDate(from);
    setToDate(to);
  }, [rangeSelection]);

  // ---------- sync actions ----------

  const runMonthlyBackfill = useCallback(async (months) => {
    setIsSyncing(true);
    syncAbortRef.current = false;
    let totalUpserted = 0;
    try {
      for (let i = months - 1; i >= 0; i--) {
        if (syncAbortRef.current) break;
        const win = monthWindowUtc(i);
        setSyncProgress(`Backfilling ${win.label} (${months - i} of ${months})…`);
        const res = await invokeWithLongTimeout("squareLedgerSync", { startDate: win.start, endDate: win.end });
        const data = res?.data || res || {};
        if (data?.success === false) throw new Error(data?.error || "Sync failed");
        totalUpserted += Number(data?.entriesUpserted || 0);
        setLastSyncResult(data);
      }
      toast.success(`Backfill complete — ${totalUpserted} ledger entries synced`);
      await fetchLedgerFromServer();
    } catch (error) {
      console.error("[SquareFinanceAudit] Backfill failed:", error);
      toast.error(`Backfill failed: ${error?.message || error}`);
    } finally {
      setIsSyncing(false);
      setSyncProgress("");
    }
  }, [fetchLedgerFromServer]);

  const runRecentSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      setSyncProgress("Syncing recent Square activity (last 3 days)…");
      const res = await invokeWithLongTimeout("squareLedgerSync", { startDate: new Date(Date.now() - 3 * 86400000).toISOString() });
      const data = res?.data || res || {};
      if (data?.success === false) throw new Error(data?.error || "Sync failed");
      setLastSyncResult(data);
      toast.success(`Synced ${data?.entriesUpserted ?? 0} ledger entries`);
      await fetchLedgerFromServer();
    } catch (error) {
      console.error("[SquareFinanceAudit] Sync failed:", error);
      toast.error(`Sync failed: ${error?.message || error}`);
    } finally {
      setIsSyncing(false);
      setSyncProgress("");
    }
  }, [fetchLedgerFromServer]);

  const saveCardLabel = useCallback(async (fingerprint, patch) => {
    setCardLabels((prev) => {
      const next = [...(prev || [])];
      const idx = next.findIndex((l) => l.fingerprint === fingerprint);
      if (idx >= 0) next[idx] = { ...next[idx], ...patch };
      else next.push({ fingerprint, ...patch });
      return next;
    });
  }, []);

  const persistCardLabels = useCallback(async () => {
    setIsSavingLabels(true);
    try {
      const settingValue = { labels: cardLabels };
      if (cardLabelsRecordId) {
        await base44.entities.AppSettings.update(cardLabelsRecordId, { setting_value: settingValue });
      } else {
        const created = await base44.entities.AppSettings.create({
          setting_key: CARD_LABELS_KEY,
          setting_value: settingValue,
          description: "Square card fingerprints -> friendly labels for the finance audit",
        });
        if (created?.id) setCardLabelsRecordId(created.id);
      }
      toast.success("Card labels saved");
    } catch (error) {
      toast.error(`Failed to save card labels: ${error?.message || error}`);
    } finally {
      setIsSavingLabels(false);
    }
  }, [cardLabels, cardLabelsRecordId]);

  const downloadCsv = useCallback(() => {
    const header = ["Date (Edmonton)", "Location", "Card", "Type", "Entry Method", "Status", "Amount (CAD)", "Order ID", "Delivery ID", "Item / Reason"];
    const lines = filteredEntries.map((e) => {
      const label = e.card_fingerprint ? (labelsByFingerprint[e.card_fingerprint]?.label || `${e.card_brand || "Card"} •${e.card_last4 || ""}`) : (e.tender_type === "CASH" ? "Cash" : "");
      const sign = e.cls.sign;
      const amount = (sign * Number(e.amount_cents || 0)) / 100;
      return [
        displayDateTime(e.wall), e.location_name || "", label, CLASS_LABELS[e.classCode], e.entry_method || "", e.status || "",
        amount.toFixed(2), e.order_id || "", e.delivery_id || "", e.cod_item_name || e.reason || "",
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
    });
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `square-ledger-${edmontonWallString(new Date()).slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredEntries, labelsByFingerprint]);

  if (isLoadingUser || !currentUser) {
    return <div className="p-6 text-slate-500 dark:text-slate-400">Loading…</div>;
  }
  if (!isAdmin) {
    return <div className="p-6 text-slate-500 dark:text-slate-400">Admin access required.</div>;
  }

  const tabs = [
    { id: "ledger", label: "Transaction Ledger", icon: Table2 },
    { id: "summary", label: "Summaries", icon: CalendarRange },
    { id: "cards", label: "Cards & Red Flags", icon: CreditCard },
    { id: "health", label: "COD Sync Health", icon: RefreshCw },
  ];

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-body">Square Finance Audit</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Card spends, COD collections, refunds, declines and transfers per location
            {lastLedgerSyncAt ? ` · cached ${displayDateTime(edmontonWallString(parseAnyTimestamp(lastLedgerSyncAt)))}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={rangeSelection} onValueChange={setRangeSelection}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="1">1 mo</SelectItem>
              <SelectItem value="3">3 mo</SelectItem>
              <SelectItem value="6">6 mo</SelectItem>
              <SelectItem value="12">1 yr</SelectItem>
              <SelectItem value="24">2 yrs</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={isSyncing || isLoading} onClick={runRecentSync}>
            <RefreshCw className={`h-4 w-4 mr-1 ${isSyncing ? "animate-spin" : ""}`} /> Refresh Recent
          </Button>
          <Button size="sm" disabled={isSyncing || isLoading} onClick={() => runMonthlyBackfill(rangeSelectionToMonths(rangeSelection))}>
            <Wallet className="h-4 w-4 mr-1" /> {isSyncing ? "Syncing…" : "Full Backfill"}
          </Button>
        </div>
      </div>

      {(syncProgress || loadProgress) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40 px-4 py-2 text-sm text-blue-700 dark:text-blue-300">
          {syncProgress || loadProgress}
        </div>
      )}

      {lastSyncResult && !isSyncing && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-4 py-2 text-xs text-slate-600 dark:text-slate-400">
          Last sync: {lastSyncResult.entriesUpserted ?? 0} entries ({lastSyncResult.entriesFailed ?? 0} failed)
          {lastSyncResult.payoutsAvailable === false && " · payouts unavailable (missing PAYOUTS_READ scope)"}
          {Array.isArray(lastSyncResult.errors) && lastSyncResult.errors.length > 0 && ` · ${lastSyncResult.errors.length} warnings`}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => { setActiveTab(t.id); if (t.id === "health") loadSyncHealth(); }}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${activeTab === t.id ? "border-blue-600 bg-blue-600 text-white shadow-sm dark:border-blue-500 dark:bg-blue-500 dark:text-white" : "border-transparent bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"}`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {isLoading && entries.length === 0 ? (
        <div className="p-6 text-slate-500 dark:text-slate-400">Loading ledger…</div>
      ) : entries.length === 0 ? (
        <Card><CardContent className="p-6 space-y-2">
          <div className="font-semibold">No Square ledger data yet.</div>
          <div className="text-sm text-slate-500 dark:text-slate-400">Run a Full Backfill to pull card spends, collections, refunds and declines from Square.</div>
        </CardContent></Card>
      ) : (
        <>
          {/* Filters bar (ledger + summary) */}
          {(activeTab === "ledger" || activeTab === "summary") && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5">
                <span className="text-xs text-slate-500 dark:text-slate-400">Locations:</span>
                {locations.map((l) => (
                  <label key={l.id} className="inline-flex items-center gap-1 cursor-pointer">
                    <Checkbox
                      checked={selectedLocations.includes(l.id)}
                      onCheckedChange={(c) => setSelectedLocations((prev) => (c ? [...prev, l.id] : prev.filter((x) => x !== l.id)))}
                    />
                    <span className="text-xs">{l.name}</span>
                  </label>
                ))}
                {selectedLocations.length > 0 && (
                  <button className="text-xs underline text-slate-500 dark:text-slate-400" onClick={() => setSelectedLocations([])}>all</button>
                )}
              </div>
              <Input type="date" className="w-36" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              <span className="text-slate-400">→</span>
              <Input type="date" className="w-36" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              {activeTab === "ledger" && (
                <>
                  <Select value={kindFilter} onValueChange={setKindFilter}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      <SelectItem value="cod">COD Collected</SelectItem>
                      <SelectItem value="spend">Card Spends</SelectItem>
                      <SelectItem value="other">Other Sales</SelectItem>
                      <SelectItem value="refund_in">Refunds (charge)</SelectItem>
                      <SelectItem value="refund_out">Refunds (customer)</SelectItem>
                      <SelectItem value="refund_unlinked">Refunds (unlinked)</SelectItem>
                      <SelectItem value="decline">Declines</SelectItem>
                      <SelectItem value="payout">Bank Transfers</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Search className="h-4 w-4 absolute left-2 top-2.5 text-slate-400" />
                    <Input className="pl-7 w-48" placeholder="Search…" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
                  </div>
                  <Button variant="outline" size="sm" onClick={downloadCsv}><Download className="h-4 w-4 mr-1" /> CSV</Button>
                </>
              )}
              {activeTab === "summary" && (
                <Select value={granularity} onValueChange={setGranularity}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="year">Yearly</SelectItem>
                    <SelectItem value="month">Monthly</SelectItem>
                    <SelectItem value="week">Weekly</SelectItem>
                    <SelectItem value="day">Daily</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* LEDGER TAB */}
          {activeTab === "ledger" && (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-slate-50 dark:bg-slate-900 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Location</th>
                        <th className="px-3 py-2">Card / Tender</th>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Method</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2">Item / Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEntries.slice(0, ledgerLimit).map((e) => {
                        const style = CLASS_STYLES[e.classCode] || CLASS_STYLES.other;
                        const cardLabel = e.card_fingerprint
                          ? (labelsByFingerprint[e.card_fingerprint]?.label || `${e.card_brand || "Card"} •${e.card_last4 || ""}`)
                          : (e.tender_type === "CASH" ? "Cash" : e.tender_type || "");
                        return (
                          <tr key={`${e.entry_kind}-${e.square_id}`} className="border-b last:border-0 hover:bg-slate-50 dark:hover:bg-slate-900/50">
                            <td className="px-3 py-2 whitespace-nowrap">{displayDateTime(e.wall)}</td>
                            <td className="px-3 py-2">{e.location_name || e.location_id}</td>
                            <td className="px-3 py-2 text-xs">{cardLabel}</td>
                            <td className="px-3 py-2"><Badge className={style.badge}>{CLASS_LABELS[e.classCode]}</Badge></td>
                            <td className="px-3 py-2 text-xs">{e.entry_method || (e.tender_type === "CASH" ? "cash" : "")}</td>
                            <td className="px-3 py-2 text-xs">{e.status}</td>
                            <td className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${style.amount}`}>
                              {e.cls.sign === -1 ? "-" : ""}{fmtCents(e.amount_cents)}
                            </td>
                            <td className="px-3 py-2 text-xs max-w-48 truncate" title={e.cod_item_name || e.reason || ""}>{e.cod_item_name || e.reason || ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {filteredEntries.length > ledgerLimit && (
                  <div className="p-3 text-center">
                    <Button variant="outline" size="sm" onClick={() => setLedgerLimit((l) => l + LEDGER_PAGE_SIZE * 2)}>
                      Load more ({filteredEntries.length - ledgerLimit} remaining)
                    </Button>
                  </div>
                )}
                <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {filteredEntries.length} of {entries.length} entries
                </div>
              </CardContent>
            </Card>
          )}

          {/* SUMMARY TAB */}
          {activeTab === "summary" && (
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div className="rounded-lg border p-3"><div className="text-xs text-slate-500 dark:text-slate-400">COD Collected</div><div className="font-bold text-emerald-600 dark:text-emerald-400">{fmtCents(totals.collected)}</div></div>
                  <div className="rounded-lg border p-3"><div className="text-xs text-slate-500 dark:text-slate-400">Card Spends</div><div className="font-bold text-red-600 dark:text-red-400">-{fmtCents(totals.spent)}</div></div>
                  <div className="rounded-lg border p-3"><div className="text-xs text-slate-500 dark:text-slate-400">Refunds</div><div className="font-bold">{fmtCents(totals.refundIn - totals.refundOut)} <span className="text-xs font-normal">({fmtCents(totals.refundIn)} in / {fmtCents(totals.refundOut)} out)</span></div></div>
                  <div className="rounded-lg border p-3"><div className="text-xs text-slate-500 dark:text-slate-400">Net</div><div className={`font-bold ${totals.net >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{fmtCents(totals.net)}</div></div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-900 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
                        <th className="px-3 py-2">Period</th>
                        {activeLocations.map((l) => (
                          <th key={l.id} colSpan={3} className="px-3 py-2 border-l text-center">{l.name}</th>
                        ))}
                        <th className="px-3 py-2 border-l text-right">All Net</th>
                      </tr>
                      <tr className="bg-slate-50 dark:bg-slate-900 text-xs text-slate-400">
                        <th className="px-3 py-1"></th>
                        {activeLocations.map((l) => (
                          <React.Fragment key={l.id}>
                            <th className="px-3 py-1 border-l text-right font-normal">Collected</th>
                            <th className="px-3 py-1 text-right font-normal">Spent</th>
                            <th className="px-3 py-1 text-right font-normal">Net</th>
                          </React.Fragment>
                        ))}
                        <th className="px-3 py-1 border-l"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const periodKeys = Array.from(new Set(
                          Array.from(summaryRows.keys()).map((k) => k.split("::")[0])
                        )).sort().reverse();
                        return periodKeys.map((pk) => {
                          let allNet = 0;
                          return (
                            <tr key={pk} className="border-t hover:bg-slate-50 dark:hover:bg-slate-900/50">
                              <td className="px-3 py-2 font-medium whitespace-nowrap">{periodLabelOf(pk, granularity)}</td>
                              {activeLocations.map((l) => {
                                const b = summaryRows.get(`${pk}::${l.id}`);
                                const net = netOf(b);
                                allNet += net;
                                return (
                                  <React.Fragment key={l.id}>
                                    <td className="px-3 py-2 border-l text-right whitespace-nowrap">{b ? fmtCents(b.collected) : "–"}</td>
                                    <td className="px-3 py-2 text-right text-red-600 dark:text-red-400 whitespace-nowrap">{b?.spent ? `-${fmtCents(b.spent)}` : "–"}</td>
                                    <td className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${net >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{fmtCents(net)}</td>
                                  </React.Fragment>
                                );
                              })}
                              <td className={`px-3 py-2 border-l text-right font-bold whitespace-nowrap ${allNet >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{fmtCents(allNet)}</td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Declines excluded from net. Bank transfers shown in the ledger tab. Card spend/refund classification depends on card labels (Cards & Red Flags tab).
                </div>
              </CardContent>
            </Card>
          )}

          {/* CARDS & RED FLAGS TAB */}
          {activeTab === "cards" && (
            <div className="space-y-4">
              <Card>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold">Business Cards (fingerprints)</h2>
                    <Button size="sm" disabled={isSavingLabels} onClick={persistCardLabels}>{isSavingLabels ? "Saving…" : "Save Labels"}</Button>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Name the three business Square Cards and toggle “Business card” so spends and their refunds classify correctly. Fingerprints seen at 2+ locations are likely business cards.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs uppercase text-slate-500 dark:text-slate-400">
                          <th className="px-2 py-1">Card</th>
                          <th className="px-2 py-1">Label</th>
                          <th className="px-2 py-1">Business</th>
                          <th className="px-2 py-1 text-right">Sales</th>
                          <th className="px-2 py-1 text-right">Volume</th>
                          <th className="px-2 py-1">Locations</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fingerprintStats.length === 0 && (
                          <tr><td colSpan={6} className="px-2 py-3 text-sm text-slate-500">No card fingerprints yet — run a sync.</td></tr>
                        )}
                        {fingerprintStats.map((st) => {
                          const label = labelsByFingerprint[st.fingerprint];
                          return (
                            <tr key={st.fingerprint} className="border-b last:border-0">
                              <td className="px-2 py-1.5 text-xs">{st.brand} •{st.last4} {st.likelyBusinessCard && !label?.is_business_card && <span className="text-amber-600 text-[10px]">(likely business)</span>}</td>
                              <td className="px-2 py-1.5">
                                <Input
                                  className="h-7 w-44 text-xs"
                                  placeholder="e.g. Callingwood's Card"
                                  value={label?.label || ""}
                                  onChange={(e) => saveCardLabel(st.fingerprint, { label: e.target.value })}
                                />
                              </td>
                              <td className="px-2 py-1.5">
                                <Checkbox
                                  checked={Boolean(label?.is_business_card)}
                                  onCheckedChange={(c) => saveCardLabel(st.fingerprint, { is_business_card: Boolean(c) })}
                                />
                              </td>
                              <td className="px-2 py-1.5 text-right text-xs">{st.saleCount}{st.declineCount > 0 && <span className="text-amber-600"> ({st.declineCount} declines)</span>}</td>
                              <td className="px-2 py-1.5 text-right text-xs font-medium">{fmtCents(st.saleTotal)}</td>
                              <td className="px-2 py-1.5 text-xs">{st.locations.join(", ")}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold flex items-center gap-1.5"><Flag className="h-4 w-4 text-red-500" /> Failed / Returned deliveries with COD activity (last 90 days)</h2>
                    <Button variant="outline" size="sm" disabled={isLoadingFlags} onClick={() => loadRedFlags()}>
                      <RefreshCw className={`h-4 w-4 mr-1 ${isLoadingFlags ? "animate-spin" : ""}`} /> Refresh
                    </Button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs uppercase text-slate-500 dark:text-slate-400">
                          <th className="px-2 py-1">Date</th>
                          <th className="px-2 py-1">Store</th>
                          <th className="px-2 py-1">Status</th>
                          <th className="px-2 py-1">COD Item</th>
                          <th className="px-2 py-1 text-right">Collected</th>
                          <th className="px-2 py-1">Refund</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!redFlags && isLoadingFlags && <tr><td colSpan={6} className="px-2 py-3 text-sm text-slate-500">Loading…</td></tr>}
                        {redFlags && redFlags.rows.length === 0 && <tr><td colSpan={6} className="px-2 py-3 text-sm text-slate-500">No failed/returned deliveries in the last 90 days.</td></tr>}
                        {redFlags?.rows.map((r) => (
                          <tr key={r.id} className="border-b last:border-0">
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.date}</td>
                            <td className="px-2 py-1.5">{r.storeName}</td>
                            <td className="px-2 py-1.5"><Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">{r.status}</Badge></td>
                            <td className="px-2 py-1.5 text-xs max-w-56 truncate" title={r.collected?.item || ""}>{r.collected?.item || "—"}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">{r.collected ? fmtCents(r.collected.amount) : <span className="text-slate-400">not collected</span>}</td>
                            <td className="px-2 py-1.5">
                              {r.refund ? (
                                <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Refunded {fmtCents(r.refund.amount)}</Badge>
                              ) : r.needsRefund ? (
                                <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"><AlertTriangle className="h-3 w-3 mr-1" />No refund</Badge>
                              ) : (
                                <span className="text-slate-400 text-xs">n/a</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <h3 className="text-sm font-semibold pt-2">Unlinked refunds (eyeball against failed/returned deliveries)</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Refunds with no COD delivery link — likely Rx charge refunds. Cross-check dates/stores against the table above.</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs uppercase text-slate-500 dark:text-slate-400">
                          <th className="px-2 py-1">Date</th>
                          <th className="px-2 py-1">Location</th>
                          <th className="px-2 py-1 text-right">Amount</th>
                          <th className="px-2 py-1">Status</th>
                          <th className="px-2 py-1">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {redFlags?.unlinkedRefunds.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-sm text-slate-500">No unlinked refunds.</td></tr>}
                        {redFlags?.unlinkedRefunds.map((e) => (
                          <tr key={e.id || e.square_id} className="border-b last:border-0">
                            <td className="px-2 py-1.5 whitespace-nowrap">{displayDateTime(e.wall)}</td>
                            <td className="px-2 py-1.5">{e.location_name || e.location_id}</td>
                            <td className="px-2 py-1.5 text-right font-medium">{fmtCents(e.amount_cents)}</td>
                            <td className="px-2 py-1.5 text-xs">{e.status}</td>
                            <td className="px-2 py-1.5 text-xs">{e.reason || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* HEALTH TAB */}
          {activeTab === "health" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Health of the COD catalog sync jobs (Square Catalog DB Daily Prune, reconciles).
              </p>
              <SyncHealthPanel runs={syncHealth.runs || []} logs={syncHealth.logs || []} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
