import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DollarSign, ChevronLeft, ChevronRight, Share2, Loader2, Download, RefreshCw, User } from "lucide-react";
import { ProfilePanel, SettingsDialog } from '@/pages/Settings';
import { sortUsers, sortStores } from '../components/utils/sorting';
import { useUser } from '../components/utils/UserContext';
import { useAppData } from '../components/utils/AppDataContext';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { userHasRole } from '../components/utils/userRoles';
import { base44 } from '@/api/base44Client';
import DriverPayrollGrid from '../components/payroll/DriverPayrollGrid';
import PayrollSummaryCard from '@/components/payroll/PayrollSummaryCard';
import { smartRefreshManager } from '../components/utils/smartRefreshManager';
import { toast } from 'sonner';
import ScreenshotShareModal from '../components/common/ScreenshotShareModal';
import html2canvas from 'html2canvas';
import { offlineDB } from '../components/utils/offlineDatabase';
import { mergePagedPayrollData, missingPayrollMonthsFor } from '@/components/utils/payrollPagedMerge';
import MobilePayrollSummary from '@/components/payroll/MobilePayrollSummary';
import MobileBottomActions from '@/components/payroll/MobileBottomActions';

// Local date helper (device timezone, no UTC offset)
const toLocalYMD = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const da = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
};

// Helper: Get first Monday of a given year
const getFirstMondayOfYear = (year) => {
  const jan1 = new Date(year, 0, 1);
  const dayOfWeek = jan1.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
  return new Date(year, 0, 1 + daysUntilMonday);
};

// Helper: Monday on or before a given date
const getMondayOnOrBefore = (date) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=Sun,1=Mon,...
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d;
};

// Count overlap days (inclusive) of a period within a specific calendar year
const countOverlapDaysInYear = (start, end, year) => {
  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  const s = new Date(Math.max(start.getTime(), jan1.getTime()));
  const e = new Date(Math.min(end.getTime(), dec31.getTime()));
  if (s > e) return 0;
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.floor((e.getTime() - s.getTime()) / oneDay) + 1; // inclusive days
};

// Determine classification year for a weekly/biweekly period by majority days
const classifyPeriodYear = (start, end) => {
  const yStart = start.getFullYear();
  const yEnd = end.getFullYear();
  if (yStart === yEnd) return yStart;
  const daysStartYear = countOverlapDaysInYear(start, end, yStart);
  const daysEndYear = countOverlapDaysInYear(start, end, yEnd);
  return daysStartYear >= daysEndYear ? yStart : yEnd;
};

// Determine which year the CURRENT period (containing given date) belongs to, based on most days
const getClassificationYearForDate = (date, payPeriodType) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const stepDays = payPeriodType === 'biweekly' ? 14 : 7;
  const anchor = getMondayOnOrBefore(new Date(year, 0, 1));
  // Generate a safe window covering the boundary around current date
  const endBoundary = new Date(year + 1, 0, 1);
  endBoundary.setDate(endBoundary.getDate() + (stepDays - 1));

  let cur = new Date(anchor);
  while (cur <= endBoundary) {
    const start = new Date(cur);
    const end = new Date(cur);
    end.setDate(end.getDate() + (stepDays - 1));
    if (d >= start && d <= end) {
      return classifyPeriodYear(start, end);
    }
    cur.setDate(cur.getDate() + stepDays);
  }
  return year; // fallback
};

// Helper: Calculate all pay periods for a given year and pay period type
// For weekly/biweekly, we generate Monday-anchored periods across the boundary
// and then include only those whose majority of days fall in the requested year.
// Compact date-range label for the cycle navigator ('Oct 1-15' style).
// Crosses month boundaries as 'Sep 28-Oct 4'; same month keeps one month name.
const formatPeriodRangeLabel = (start, end) => {
  const sm = start.toLocaleString('default', { month: 'short' });
  const em = end.toLocaleString('default', { month: 'short' });
  const sd = start.getDate();
  const ed = end.getDate();
  return sm === em ? `${sm} ${sd}-${ed}` : `${sm} ${sd}-${em} ${ed}`;
};

const calculateAllPeriods = (year, payPeriodType) => {
  const periods = [];

  switch (payPeriodType) {
    case 'weekly':{
        const stepDays = 7;
        const anchor = getMondayOnOrBefore(new Date(year, 0, 1));
        const endBoundary = new Date(year + 1, 0, 1);
        endBoundary.setDate(endBoundary.getDate() + (stepDays - 1)); // cover spill

        let cur = new Date(anchor);
        let weekNum = 1;
        while (cur <= endBoundary) {
          const start = new Date(cur);
          const end = new Date(cur);
          end.setDate(end.getDate() + (stepDays - 1));
          const belongsToYear = classifyPeriodYear(start, end) === year;
          if (belongsToYear) {
            periods.push({
              year,
              start,
              end,
              // Oct 20 owner spec: navigator label always shows the cycle's
              // DATE RANGE (matching semimonthly 'Oct 1-15'), not 'Week N'.
              label: formatPeriodRangeLabel(start, end),
              weekNum
            });
            weekNum++;
          }
          cur.setDate(cur.getDate() + stepDays);
        }
        break;
      }
    case 'biweekly':{
        const stepDays = 14;
        const anchor = getMondayOnOrBefore(new Date(year, 0, 1));
        const endBoundary = new Date(year + 1, 0, 1);
        endBoundary.setDate(endBoundary.getDate() + (stepDays - 1));

        let cur = new Date(anchor);
        let periodNum = 1;
        while (cur <= endBoundary) {
          const start = new Date(cur);
          const end = new Date(cur);
          end.setDate(end.getDate() + (stepDays - 1));
          const belongsToYear = classifyPeriodYear(start, end) === year;
          if (belongsToYear) {
            periods.push({
              year,
              start,
              end,
              // Oct 20 owner spec: date range instead of 'Period N'.
              label: formatPeriodRangeLabel(start, end),
              periodNum
            });
            periodNum++;
          }
          cur.setDate(cur.getDate() + stepDays);
        }
        break;
      }
    case 'semimonthly':{
        for (let month = 0; month < 12; month++) {
          const daysInMonth = new Date(year, month + 1, 0).getDate();
          periods.push({
            year,
            start: new Date(year, month, 1),
            end: new Date(year, month, 15),
            label: `${new Date(year, month, 1).toLocaleString('default', { month: 'short' })} 1-15`,
            month: month + 1,
            half: 1
          });
          periods.push({
            year,
            start: new Date(year, month, 16),
            end: new Date(year, month, daysInMonth),
            label: `${new Date(year, month, 1).toLocaleString('default', { month: 'short' })} 16-${daysInMonth}`,
            month: month + 1,
            half: 2
          });
        }
        break;
      }
    case 'monthly':
    default:{
        for (let month = 0; month < 12; month++) {
          const daysInMonth = new Date(year, month + 1, 0).getDate();
          periods.push({
            year,
            start: new Date(year, month, 1),
            end: new Date(year, month, daysInMonth),
            label: new Date(year, month, 1).toLocaleString('default', { month: 'long' }),
            month: month + 1
          });
        }
        break;
      }
  }
  return periods;
};

// Oct 15 owner spec: the ONLY months client devices re-gather on payroll page
// load / manual refresh are the months spanned by the CURRENT pay period.
// Past years never re-gather; historical accuracy belongs to the history host.
const getCurrentPayrollCycleMonths = (year, payPeriodType) => {
  const now = new Date();
  if (parseInt(year, 10) !== now.getFullYear()) return [];
  try {
    const periods = calculateAllPeriods(year, payPeriodType || 'monthly');
    const cur = periods.find((p) => now >= p.start && now <= p.end);
    if (!cur) return [now.getMonth() + 1];
    const months = [];
    [cur.start, cur.end].forEach((d) => {
      const m = d.getMonth() + 1;
      if (!months.includes(m)) months.push(m);
    });
    return months;
  } catch (_) {
    return [now.getMonth() + 1];
  }
};

// Owner directive Oct 30 2026: the payroll Refresh spinner must re-check ALL the
// data for the SELECTED pay cycle, finalized or not — never only the current
// cycle. Returns the months spanned by the selected period.
const getSelectedPeriodMonths = (currentPeriod) => {
  try {
    if (!currentPeriod?.start || !currentPeriod?.end) return [];
    const months = [];
    [currentPeriod.start, currentPeriod.end].forEach((d) => {
      const m = new Date(d).getMonth() + 1;
      if (m >= 1 && m <= 12 && !months.includes(m)) months.push(m);
    });
    return months;
  } catch (_) {
    return [];
  }
};

// Helper: Find current period index based on today's date
// For weekly/biweekly, if today is near year boundary ensure we use the classification-year set
const findCurrentPeriodIndex = (periods, today) => {
  const t = new Date(today);
  t.setHours(0, 0, 0, 0);
  const todayStr = toLocalYMD(t);

  for (let i = 0; i < periods.length; i++) {
    const startStr = toLocalYMD(periods[i].start);
    const endStr = toLocalYMD(periods[i].end);
    if (todayStr >= startStr && todayStr <= endStr) {
      return i;
    }
  }
  // Fallback: closest past
  for (let i = periods.length - 1; i >= 0; i--) {
    const endStr = toLocalYMD(periods[i].end);
    if (todayStr > endStr) return i;
  }
  return 0;
};

const isPayrollAdminFinalized = (record) => {
  if (!record) return false;
  return !!record.admin_finalized_at && !!record.admin_finalized_by;
};

const determinePreferredPayrollPeriodIndex = ({ periods, payrollRecords = [], selectedCityId = '', selectedDriverId = 'all', payPeriodType = '', today = new Date() }) => {
  if (!Array.isArray(periods) || periods.length === 0) return 0;

  const todayIdx = findCurrentPeriodIndex(periods, today);
  const previousIdx = todayIdx > 0 ? todayIdx - 1 : -1;
  if (previousIdx < 0) return todayIdx;

  const previousPeriod = periods[previousIdx];
  const startStr = toLocalYMD(previousPeriod.start);
  const endStr = toLocalYMD(previousPeriod.end);
  const scopedRecords = (payrollRecords || []).filter((record) => {
    const matchPeriod = record.pay_period_start === startStr && record.pay_period_end === endStr;
    const matchCity = !selectedCityId || selectedCityId === 'all' || record.city_id === selectedCityId;
    const matchDriver = selectedDriverId === 'all' || record.driver_id === selectedDriverId;
    const matchPayCycleType = !payPeriodType || record.pay_period_type === payPeriodType;
    return matchPeriod && matchCity && matchDriver && matchPayCycleType;
  });

  if (scopedRecords.some((record) => !isPayrollAdminFinalized(record))) {
    return previousIdx;
  }

  return todayIdx;
};


/**
 * Returns the effective pay_cycle_type for an AppUser as of a given DATE.
 * Classification is per-delivery: each delivery is classified by the cycle that
 * was active ON THAT DELIVERY'S DATE, not by the period start date.
 * This means a driver who switched from semimonthly to weekly on Aug 1 will have
 * their Jul 20 delivery show in semimonthly and their Aug 3 delivery show in weekly.
 *
 * History entries store the NEW cycle that became active on effective_date.
 * To find the cycle for a given date: find the most recent history entry with
 * effective_date <= date — that entry's pay_cycle_type was the active cycle then.
 * If date is before all history entries, fall back to the earliest history entry.
 *
 * Example: Sharuk has history [Aug 01 → weekly, Jan 19 → semimonthly].
 * Delivery on Jul 20: Aug 01 > Jul 20 (skip), Jan 19 ≤ Jul 20 → return semimonthly ✓
 * Delivery on Aug 03: Aug 01 ≤ Aug 03 → return weekly ✓
 */
const getDriverCycleForDate = (appUser, date) => {
  if (!appUser) return null;
  const current = appUser.pay_cycle_type;
  if (!date) return current;
  const history = appUser.pay_rate_history;
  if (!history || !Array.isArray(history) || history.length === 0) return current;
  // Sort newest → oldest
  const sorted = [...history].sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date));

  // Find the most recent history entry whose effective_date is on or before the given date.
  // That entry's pay_cycle_type was the active cycle on that date.
  for (const entry of sorted) {
    const entryDate = new Date(entry.effective_date);
    entryDate.setHours(0, 0, 0, 0);
    const compareDate = new Date(date);
    compareDate.setHours(0, 0, 0, 0);
    if (entryDate <= compareDate && entry.pay_cycle_type) {
      return entry.pay_cycle_type;
    }
  }

  // No entry with pay_cycle_type found on or before this date.
  // Find the earliest entry that has a pay_cycle_type — that represents the
  // cycle that was active BEFORE the first recorded change.
  const earliestWithCycle = [...sorted].reverse().find((e) => e.pay_cycle_type);
  if (earliestWithCycle) return earliestWithCycle.pay_cycle_type;

  // Last resort: if NO history entry has pay_cycle_type at all,
  // we cannot determine the historical cycle. Return null so callers
  // can handle it (rather than blindly returning the current/new cycle
  // which would misclassify all pre-change deliveries).
  return null;
};

/**
 * Build a per-driver cycle lookup map: driverId -> function(deliveryDate) => cycle.
 * Used to classify individual deliveries by their own date, not the period start.
 */
const buildDeliveryCycleClassifier = (appUsers) => {
  const map = new Map();
  if (!appUsers) return map;
  appUsers.forEach((au) => {
    if (au?.user_id) {
      map.set(au.user_id, (dateStr) => getDriverCycleForDate(au, dateStr));
    }
  });
  return map;
};

export default function DriverPayroll() {
  // CRITICAL: ALL hooks must be at the top, before any conditional logic
  const { currentUser } = useUser();
  useAppData();

  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());
  const [selectedCityId, setSelectedCityId] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState('all');
  const [payPeriod, setPayPeriod] = useState(null); // null until determined from data
  const [selectedPeriodIndex, setSelectedPeriodIndex] = useState(null); // null until determined
  const [hasInitialized, setHasInitialized] = useState(false);
  const [payrollData, setPayrollData] = useState(null);
  const payrollDataRef = useRef(null);
  payrollDataRef.current = payrollData;
  const [isLoadingPayroll, setIsLoadingPayroll] = useState(true);
  // Grace timer: the first-ever load (no IDB cache) must wait on the full-year
  // backend gather, which can run 25-60s. After LOAD_GRACE_MS we swap the
  // blocking spinner for the page shell + a syncing banner so the screen is
  // never a dead spinner. Later loads render instantly from IDB.
  const [blockingGraceExpired, setBlockingGraceExpired] = useState(false);
  const [loadedFromOffline, setLoadedFromOffline] = useState(false);
  const [payrollRecords, setPayrollRecords] = useState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Owner Oct 30 2026: bumped after every manual refresh so the summary card runs
  // ONE payroll sync pass that may also rewrite finalized (never 'paid') totals.
  const [forceFinalizedSyncToken, setForceFinalizedSyncToken] = useState(0);
  // Owner Oct 12: true while ANY payroll fetch is in flight (manual click OR
  // automatic background sync). Drives the header refresh spinner + the
  // "Syncing Payroll" balloon so the owner always sees when a sync is running.
  const [isPayrollSyncing, setIsPayrollSyncing] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState(null);
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);

  const contentRef = useRef(null);
  const summaryCardRef = useRef(null);
  const [isSharingPdf, setIsSharingPdf] = useState(false);
  const payrollScrollRef = useRef(null);
  const isManualChangeRef = useRef(false);
  const hasLoadedInitialDataRef = useRef(false);
  const triedPreviousPeriodRef = useRef(false);
  const summaryRef = useRef(null);
  const fetchPayrollInFlightRef = useRef(null);
  const lastFetchSignatureRef = useRef('');
  const lastFetchTimestampRef = useRef(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const citySelectTriggerRef = useRef(null);
  const [showETransEmailDialog, setShowETransEmailDialog] = useState(false);

  // Define isDriver early (after refs, before useMemo/useCallback that might use it)
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin');

  // Drivers without e-Transfer email: prompt them to add one
  // Use AppUser directly — currentUser from auth context may not carry app_roles reliably
  useEffect(() => {
    if (!currentUser?.id) return;
    base44.entities.AppUser.filter({ user_id: currentUser.id }, null, null, null, 'id,user_id,user_name,app_roles,status,driver_status,driver_id,driver_name,store_ids,city_id,city_ids,home_latitude,home_longitude,current_latitude,current_longitude,location_tracking_enabled,location_updated_at,preferred_travel_mode,sort_order,role,full_name,created_date,updated_date,ETrans_Email').then((appUsers) => {
      const appUser = appUsers?.[0];
      if (!appUser) return;
      const isDriverRole = Array.isArray(appUser.app_roles) &&
        appUser.app_roles.includes('driver') &&
        !appUser.app_roles.includes('admin');
      if (isDriverRole && !appUser.ETrans_Email) {
        setShowETransEmailDialog(true);
      }
      // Oct 15: last-resort city repair — if init could not resolve a city from
      // the merged user or the offline DB, use the fresh AppUser record so the
      // payroll page can load (all current users are Edmonton-based).
      const appCity = appUser.city_id || (Array.isArray(appUser.city_ids) && appUser.city_ids[0]);
      if (appCity) {
        setSelectedCityId((prev) => (prev && prev !== 'all' ? prev : appCity));
      }
    }).catch(() => {});
  }, [currentUser?.id]);
  const isPayrollPageActive = typeof window !== 'undefined' && window.location.pathname.toLowerCase().includes('driverpayroll');

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  const allPeriods = useMemo(() => {
    if (!payPeriod) return [];
    return calculateAllPeriods(selectedYear, payPeriod);
  }, [selectedYear, payPeriod]);

  const currentPeriod = useMemo(() => {
    if (selectedPeriodIndex === null || allPeriods.length === 0) return null;
    return allPeriods[selectedPeriodIndex] || allPeriods[0];
  }, [allPeriods, selectedPeriodIndex]);

  const sortedCities = useMemo(() => {
    const allCities = Array.isArray(payrollData?.cities) ? payrollData.cities : [];
    return [...allCities].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
  }, [payrollData?.cities]);

  const filteredStores = useMemo(() => {
    if (!payrollData?.stores || !selectedCityId) return [];
    const filtered = payrollData.stores.filter((s) => s.status !== 'inactive' && s.city_id === selectedCityId);
    return sortStores(filtered);
  }, [payrollData?.stores, selectedCityId]);

  // Owner report Oct 30 2026 (Anna Oct 8 + 14: payroll read 6.54 km while the
  // dashboard read 10.41): an edited Delivery Km Override was live on the device
  // and on the server, but the payroll payload kept the pre-edit value, so the
  // paid km silently fell back to the patient's stored distance. Overlay the
  // local IDB overrides onto the payroll rows so payroll always agrees with the
  // dashboard. A missing/blank local value never erases a server value.
  // LIVE KM OVERRIDES (owner report Oct 31 2026: payroll kept replaying 6.54 /
  // 10.41 while the Delivery records already held 21.90). The payroll payload
  // clearly serves stale delivery rows on some devices, so the paid km is now
  // resolved from the Delivery ENTITY for the selected period - one query per
  // period/refresh - and overlaid on both the by-store table and the driver
  // cards. Same server record for every device, no local caches involved.
  const [liveKmOverrides, setLiveKmOverrides] = useState({});
  const [liveKmToken, setLiveKmToken] = useState(0);
  const liveKmFetchedRef = useRef('');
  useEffect(() => {
    if (!currentPeriod?.start || !currentPeriod?.end) return;
    const from = toLocalYMD(currentPeriod.start);
    const to = toLocalYMD(currentPeriod.end);
    const key = `${from}:${to}:${selectedCityId || ''}:${liveKmToken}`;
    if (liveKmFetchedRef.current === key) return;
    liveKmFetchedRef.current = key;
    let cancelled = false;
    (async () => {
      try {
        const rows = await base44.entities.Delivery.filter(
          { delivery_date: { $gte: from, $lte: to } },
          '-delivery_date',
          5000
        );
        if (cancelled || !Array.isArray(rows)) return;
        const map = {};
        rows.forEach((r) => {
          const v = Number(r?.paid_km_override);
          if (r?.id && Number.isFinite(v) && v > 0) map[r.id] = v;
        });
        setLiveKmOverrides(map);
        console.log(`📏 [DriverPayroll] live km overrides for ${from}..${to}: ${Object.keys(map).length}`);
      } catch (e) {
        console.warn('[DriverPayroll] live km override fetch failed:', e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, [currentPeriod?.start?.getTime?.() ?? null, currentPeriod?.end?.getTime?.() ?? null, selectedCityId, liveKmToken]);

  const applyLiveKmOverrides = (rows) => {
    if (!Array.isArray(rows) || Object.keys(liveKmOverrides).length === 0) return rows;
    return rows.map((d) => {
      const live = liveKmOverrides[d?.id];
      if (live === undefined) return d;
      const current = Number(d?.paid_km_override);
      if (Number.isFinite(current) && Math.abs(current - live) < 0.005) return d;
      return { ...d, paid_km_override: live };
    });
  };

  // All deliveries for the selected city (no period filter) for App Fee monthly pool
  const allCityDeliveries = useMemo(() => {
    const deliveries = Array.isArray(payrollData?.deliveries) ? payrollData.deliveries : [];
    const cityStoreIds = new Set(filteredStores.map((s) => s.id));
    let filtered = deliveries.filter((d) => d && cityStoreIds.has(d.store_id));

    // Filter by pay cycle using PER-DELIVERY classification.
    // Each delivery is classified by the driver's cycle on that delivery's date.
    // A driver who switched cycles mid-period will have pre-change deliveries in the
    // old cycle and post-change deliveries in the new cycle.
    if (payrollData?.appUsers && payPeriod) {
      const appUserMap = new Map();
      payrollData.appUsers.forEach((au) => {
        if (au?.user_id) appUserMap.set(au.user_id, au);
      });
      // Also include drivers with payroll records in this period (covers inactive drivers without appUsers data)
      const payrollDriverIds = new Set();
      if (currentPeriod && Array.isArray(payrollData?.payrollRecords)) {
        const periodStart = toLocalYMD(currentPeriod.start);
        const periodEnd = toLocalYMD(currentPeriod.end);
        payrollData.payrollRecords.forEach((r) => {
          if (r?.driver_id && r.pay_period_start === periodStart && r.pay_period_end === periodEnd) {
            payrollDriverIds.add(r.driver_id);
          }
        });
      }
      filtered = filtered.filter((d) => {
        if (!d.driver_id) return false;
        // If driver has payroll records in this period, include them even without AppUser match
        if (payrollDriverIds.has(d.driver_id)) return true;
        const au = appUserMap.get(d.driver_id);
        if (!au) return false;
        return getDriverCycleForDate(au, d.delivery_date) === payPeriod;
      });
    }

    return applyLiveKmOverrides(filtered);
  }, [payrollData?.deliveries, payrollData?.appUsers, payrollData?.payrollRecords, filteredStores, payPeriod, currentPeriod, liveKmOverrides]);

  // Screenshot/share "Save" file name: pay-period date range + selected driver
  // ("All Drivers" when no driver is filtered), mirroring the PDF export naming.
  const screenshotFilename = useMemo(() => {
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let datePart = selectedYear;
    if (currentPeriod?.start && currentPeriod?.end) {
      const start = new Date(currentPeriod.start);
      const end = new Date(currentPeriod.end);
      const year = end.getFullYear();
      const sm = MONTHS[start.getMonth()];
      const em = MONTHS[end.getMonth()];
      const sd = String(start.getDate()).padStart(2, '0');
      const ed = String(end.getDate()).padStart(2, '0');
      datePart = start.getMonth() === end.getMonth()
        ? `${year} ${sm} ${sd}-${ed}`
        : `${year} ${sm} ${sd}-${em} ${ed}`;
    }
    let context = 'All Drivers';
    if (selectedDriverId && selectedDriverId !== 'all') {
      const d = (payrollData?.drivers || []).find((dr) => (dr?.user_id || dr?.id) === selectedDriverId);
      context = d?.user_name || d?.full_name || 'Driver';
    }
    return `payroll ${datePart} - ${context}.png`;
  }, [currentPeriod, selectedDriverId, payrollData?.drivers, selectedYear]);

  const sortedDrivers = useMemo(() => {
    if (!payrollData?.drivers || !payrollData?.appUsers) return [];

    const appUsersByDriverId = new Map();
    payrollData.appUsers.forEach((au) => {
      if (au?.user_id) appUsersByDriverId.set(au.user_id, au);
    });

    // Include drivers who have deliveries OR existing payroll records in the current pay period.
    // This ensures inactive drivers with data are still shown.
    const periodStart = currentPeriod ? toLocalYMD(currentPeriod.start) : null;
    const periodEnd = currentPeriod ? toLocalYMD(currentPeriod.end) : null;
    const driversWithDeliveriesInPeriod = new Set();
    if (periodStart && periodEnd && Array.isArray(payrollData?.deliveries)) {
      payrollData.deliveries.forEach((d) => {
        if (d?.driver_id && d.delivery_date >= periodStart && d.delivery_date <= periodEnd) {
          driversWithDeliveriesInPeriod.add(d.driver_id);
        }
      });
    }
    // Also include drivers who already have payroll records for this period
    const payrollDriverIds = new Set();
    if (periodStart && periodEnd && Array.isArray(payrollData?.payrollRecords)) {
      payrollData.payrollRecords.forEach((r) => {
        if (r?.pay_period_start === periodStart && r?.pay_period_end === periodEnd) {
          payrollDriverIds.add(r.driver_id);
        }
      });
    }

    // Build per-delivery cycle classification: a driver is included if ANY of their
    // deliveries in this period were classified under the currently selected cycle.
    const driversWithMatchingDeliveries = new Set();
    if (periodStart && periodEnd && Array.isArray(payrollData?.deliveries)) {
      payrollData.deliveries.forEach((d) => {
        if (!d?.driver_id || !d.delivery_date) return;
        if (d.delivery_date < periodStart || d.delivery_date > periodEnd) return;
        const au = appUsersByDriverId.get(d.driver_id);
        if (!au) return;
        if (getDriverCycleForDate(au, d.delivery_date) === payPeriod) {
          driversWithMatchingDeliveries.add(d.driver_id);
        }
      });
    }

    return sortUsers(
      payrollData.drivers.
      filter((d) => {
        if (!d) return false;
        const driverId = d.user_id || d.id;
        // Include if: has matching-cycle deliveries in period, OR has payroll records for this period.
        // Status is NOT checked — inactive drivers with data are always shown.
        return driversWithMatchingDeliveries.has(driverId) || payrollDriverIds.has(driverId);
      }).
      map((d) => ({ ...d, ...(appUsersByDriverId.get(d.user_id || d.id) || {}) }))
    );
  }, [payrollData?.drivers, payrollData?.appUsers, payrollData?.deliveries, payPeriod, currentPeriod, payrollData?.payrollRecords]);

  const availablePayCycles = useMemo(() => {
    if (!payrollData?.appUsers) return [];
    const cycles = new Set();
    payrollData.appUsers.forEach((au) => {
      if (au.app_roles && au.app_roles.includes('driver')) {
        if (au.pay_cycle_type) cycles.add(au.pay_cycle_type);
        if (Array.isArray(au.pay_rate_history)) {
          au.pay_rate_history.forEach((h) => {
            if (h.pay_cycle_type) cycles.add(h.pay_cycle_type);
          });
        }
      }
    });
    const order = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
    return order.filter((c) => cycles.has(c));
  }, [payrollData?.appUsers]);

  const driversInPayCycle = useMemo(() => {
    if (!payrollData?.appUsers || !payrollData?.drivers) return [];

    const appUsersByDriverId = new Map();
    payrollData.appUsers.forEach((au) => {
      if (au?.user_id) appUsersByDriverId.set(au.user_id, au);
    });

    // Only show drivers who have deliveries in the current pay period
    const periodStart = currentPeriod ? toLocalYMD(currentPeriod.start) : null;
    const periodEnd = currentPeriod ? toLocalYMD(currentPeriod.end) : null;
    const driversWithDeliveriesInPeriod = new Set();
    if (periodStart && periodEnd && Array.isArray(payrollData?.deliveries)) {
      payrollData.deliveries.forEach((d) => {
        if (d?.driver_id && d.delivery_date >= periodStart && d.delivery_date <= periodEnd) {
          driversWithDeliveriesInPeriod.add(d.driver_id);
        }
      });
    }

    // CRITICAL: Always include the currently selected driver to prevent dropdown mismatch during transitions
    if (selectedDriverId !== 'all') {
      driversWithDeliveriesInPeriod.add(selectedDriverId);
    }

    // Also include drivers who already have payroll records for this period,
    // even if their deliveries aren't in the current data set.
    const periodStartStr = periodStart;
    const periodEndStr = periodEnd;
    const payrollDriverIds = new Set();
    if (Array.isArray(payrollData?.payrollRecords)) {
      payrollData.payrollRecords.forEach((r) => {
        if (r?.pay_period_start === periodStartStr && r?.pay_period_end === periodEndStr) {
          payrollDriverIds.add(r.driver_id);
        }
      });
    }

    // Build per-delivery cycle classification: a driver is included if ANY of their
    // deliveries in this period were classified under the currently selected cycle.
    const driversWithMatchingDeliveries = new Set();
    if (periodStart && periodEnd && Array.isArray(payrollData?.deliveries)) {
      payrollData.deliveries.forEach((d) => {
        if (!d?.driver_id || !d.delivery_date) return;
        if (d.delivery_date < periodStart || d.delivery_date > periodEnd) return;
        const au = appUsersByDriverId.get(d.driver_id);
        if (!au) return;
        if (getDriverCycleForDate(au, d.delivery_date) === payPeriod) {
          driversWithMatchingDeliveries.add(d.driver_id);
        }
      });
    }

    const result = sortUsers(
      payrollData.drivers.
      filter((d) => {
        if (!d) return false;
        const driverId = d.user_id || d.id;
        // Include if: has matching-cycle deliveries in period, OR has payroll records,
        // OR is the currently selected driver (prevents dropdown mismatch during transitions).
        // Status is NOT checked — inactive drivers with data are always shown.
        return driversWithMatchingDeliveries.has(driverId) || payrollDriverIds.has(driverId) || driverId === selectedDriverId;
      }).
      map((d) => ({ ...d, ...(appUsersByDriverId.get(d.user_id || d.id) || {}) }))
    );

    return result;
  }, [payrollData?.appUsers, payrollData?.drivers, payrollData?.deliveries, payPeriod, currentPeriod, selectedDriverId, payrollData?.payrollRecords]);

  // Calculate available pay cycles and their counts for the selected city/year
  const payCycleInfo = useMemo(() => {
    if (!payrollData?.appUsers) return { cycles: ['weekly', 'biweekly', 'semimonthly', 'monthly'], mostCommon: 'monthly', disabled: false };

    // Filter appUsers to drivers only (include inactive — admins and drivers see all)
    let filteredAppUsers = payrollData.appUsers.filter((au) =>
    au.app_roles && au.app_roles.includes('driver')
    );

    // If no drivers found, allow all cycle types
    if (filteredAppUsers.length === 0) {
      console.log(`📊 [payCycleInfo] No active drivers found, allowing all cycles`);
      return { cycles: ['weekly', 'biweekly', 'semimonthly', 'monthly'], mostCommon: 'monthly', disabled: false, cycleCounts: {} };
    }

    // Count drivers by CURRENT pay cycle type — these are the available cycle FILTERS,
    // not period-specific data. A driver who switched from semimonthly to weekly should
    // show "weekly" as an available button so admins can view their weekly periods.
    // The per-delivery classification (via getDriverCycleForDate) happens later when
    // filtering deliveries and building the driver grid for a specific period.
    const cycleCounts = {};
    filteredAppUsers.forEach((au) => {
      // Use current pay_cycle_type, but also include any historical cycle types
      // so that past periods remain accessible via the filter buttons.
      const current = au.pay_cycle_type;
      if (current) cycleCounts[current] = (cycleCounts[current] || 0) + 1;
      // Also include cycles from pay_rate_history so old cycle types stay visible
      if (Array.isArray(au.pay_rate_history)) {
        au.pay_rate_history.forEach((h) => {
          if (h.pay_cycle_type && !cycleCounts[h.pay_cycle_type]) {
            cycleCounts[h.pay_cycle_type] = 0; // count as 0 so the button appears
          }
        });
      }
    });

    const cycles = Object.keys(cycleCounts);
    const order = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
    const sortedCycles = order.filter((c) => cycles.includes(c));

    // Find most common CURRENT cycle (count > 0 excludes historical-only cycles)
    let mostCommon = null;
    let maxCount = 0;
    Object.entries(cycleCounts).forEach(([cycle, count]) => {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = cycle;
      }
    });

    const disabled = sortedCycles.length <= 1;

    console.log(`📊 [payCycleInfo] Available cycles:`, {
      cycles: sortedCycles,
      counts: cycleCounts,
      mostCommon,
      disabled,
      filteredDriversCount: filteredAppUsers.length
    });

    return { cycles: sortedCycles, mostCommon, disabled, cycleCounts };
  }, [payrollData?.appUsers]);

  const cityFilteredDeliveries = useMemo(() => {
    // CRITICAL: Ensure deliveries is always an array
    const deliveries = Array.isArray(payrollData?.deliveries) ? payrollData.deliveries : [];
    let filtered = deliveries;

    // Filter by city (via store)
    const cityStoreIds = new Set(filteredStores.map((s) => s.id));
    filtered = filtered.filter((d) => d && cityStoreIds.has(d.store_id));

    // CRITICAL: Filter by selected pay period date range
    // All year data is loaded; the grid/summary need only the current period's deliveries
    if (currentPeriod) {
      const periodStart = toLocalYMD(currentPeriod.start);
      const periodEnd = toLocalYMD(currentPeriod.end);
      filtered = filtered.filter((d) => d && d.delivery_date >= periodStart && d.delivery_date <= periodEnd);
    }

    // Filter by pay cycle using PER-DELIVERY classification.
    // Each delivery is classified by the driver's cycle on that delivery's date.
    if (payrollData?.appUsers && payPeriod) {
      const appUserMap = new Map();
      payrollData.appUsers.forEach((au) => {
        if (au?.user_id) appUserMap.set(au.user_id, au);
      });
      // Also include drivers who have payroll records in this period (covers inactive drivers)
      const payrollDriverIds = new Set();
      if (currentPeriod && Array.isArray(payrollData?.payrollRecords)) {
        const periodStart = toLocalYMD(currentPeriod.start);
        const periodEnd = toLocalYMD(currentPeriod.end);
        payrollData.payrollRecords.forEach((r) => {
          if (r?.driver_id && r.pay_period_start === periodStart && r.pay_period_end === periodEnd) {
            payrollDriverIds.add(r.driver_id);
          }
        });
      }
      filtered = filtered.filter((d) => {
        if (!d || !d.driver_id) return false;
        if (payrollDriverIds.has(d.driver_id)) return true;
        const au = appUserMap.get(d.driver_id);
        if (!au) return false;
        return getDriverCycleForDate(au, d.delivery_date) === payPeriod;
      });
    }

    return applyLiveKmOverrides(filtered);
  }, [payrollData?.deliveries, payrollData?.appUsers, selectedCityId, filteredStores, currentPeriod, payPeriod, payrollData?.payrollRecords, liveKmOverrides]);

  const filteredPayrollRecords = useMemo(() => {
    if (!currentPeriod || !Array.isArray(payrollRecords)) return [];

    const periodStart = toLocalYMD(currentPeriod.start);
    const periodEnd = toLocalYMD(currentPeriod.end);
    const payCycleDriverIds = new Set(driversInPayCycle.map((driver) => driver.user_id || driver.id));

    // Build a map of driver_id -> effective pay cycle for the current period.
    // Uses the period start date to classify the driver's cycle for this period.
    // (Payroll records are per-period, not per-delivery, so period-start classification is correct here.)
    const driverCycleMap = new Map();
    if (payrollData?.appUsers) {
      payrollData.appUsers.forEach((au) => {
        if (au?.user_id) {
          const effective = getDriverCycleForDate(au, currentPeriod?.start);
          if (effective) driverCycleMap.set(au.user_id, effective);
        }
      });
    }

    return payrollRecords.filter((record) => {
      const matchesPeriod = record.pay_period_start === periodStart && record.pay_period_end === periodEnd;
      const matchesDriver = selectedDriverId === 'all' ?
      payCycleDriverIds.has(record.driver_id) :
      record.driver_id === selectedDriverId;
      const matchesCity = !selectedCityId || selectedCityId === 'all' || record.city_id === selectedCityId;
      // Match if the record's pay_period_type matches the page payPeriod OR the
      // driver's actual pay_cycle_type. This prevents records from being hidden
      // when the page-level payPeriod doesn't match the driver's real cycle.
      const driverCycle = driverCycleMap.get(record.driver_id);
      const matchesPayPeriod = !payPeriod ||
        record.pay_period_type === payPeriod ||
        (driverCycle && record.pay_period_type === driverCycle);
      return matchesPeriod && matchesDriver && matchesCity && matchesPayPeriod;
    });
  }, [payrollRecords, currentPeriod, driversInPayCycle, selectedDriverId, selectedCityId, payPeriod, payrollData?.appUsers]);

  // Defensive dedupe: if duplicate Payroll records exist for the same driver+period
  // (caused by create-instead-of-update bugs), only count the most recently updated one.
  const totalNetPay = useMemo(() => {
    const seen = new Map(); // key: driver_id+period → record
    for (const r of filteredPayrollRecords) {
      const key = `${r.driver_id}|${r.pay_period_start}|${r.pay_period_end}`;
      const existing = seen.get(key);
      if (!existing || new Date(r.updated_date || r.created_date) > new Date(existing.updated_date || existing.created_date)) {
        seen.set(key, r);
      }
    }
    let sum = 0;
    for (const r of seen.values()) sum += Number(r.net_pay) || 0;
    return sum;
  }, [filteredPayrollRecords]);
  const totalDeliveries = useMemo(() => {
    const payrollRows = Array.isArray(payrollData) ? payrollData : [];
    if (payrollRows.length === 0) return 0;
    if (selectedDriverId === 'all') {
      return payrollRows.reduce((sum, driverData) => sum + (Number(driverData?.graphDeliveryCount) || 0), 0);
    }
    const selectedDriverData = payrollRows.find((driverData) => driverData?.driver?.id === selectedDriverId);
    return Number(selectedDriverData?.graphDeliveryCount) || 0;
  }, [payrollData, selectedDriverId]);
  const periodLabel = useMemo(() => currentPeriod ? currentPeriod.label : '', [currentPeriod]);
  const needsCitySelection = !!currentUser && sortedCities.length > 0 && !selectedCityId;

  const handlePayPeriodChange = useCallback((newPayPeriod) => {
    isManualChangeRef.current = true;

    const shouldClassify = newPayPeriod === 'weekly' || newPayPeriod === 'biweekly';
    const effectiveYear = shouldClassify ? getClassificationYearForDate(new Date(), newPayPeriod) : selectedYear;
    const nextPeriods = calculateAllPeriods(effectiveYear, newPayPeriod);
    const nextIdx = determinePreferredPayrollPeriodIndex({
      periods: nextPeriods,
      payrollRecords: payrollData?.payrollRecords || [],
      selectedCityId,
      selectedDriverId: 'all',
      payPeriodType: newPayPeriod,
      today: new Date()
    });

    triedPreviousPeriodRef.current = true;
    periodSelectionDoneWithRecordsRef.current = true;

    React.startTransition(() => {
      setPayPeriod(newPayPeriod);

      if (shouldClassify && effectiveYear !== selectedYear) {
        setSelectedYear(effectiveYear);
      }

      setSelectedPeriodIndex(nextIdx);

      if (selectedDriverId !== 'all') {
        setSelectedDriverId('all');
      }

      // REMOVED: Previously this block updated the selected driver's pay_cycle_type
      // in the database when the admin changed the pay period dropdown while a
      // specific driver was selected. This was a dangerous side-effect — the
      // dropdown is for VIEWING different pay periods, not for SETTING a driver's
      // pay cycle. Driver pay cycle should only be changed via DriverEditForm.
      // The selectedDriverId is already reset to 'all' above.
    });

    setTimeout(() => {isManualChangeRef.current = false;}, 200);
  }, [selectedCityId, selectedDriverId, selectedYear, payrollData?.payrollRecords]);

  const refreshPayrollRecords = useCallback(async () => {
    if (!currentPeriod || !payrollData?.payrollRecords) {
      return;
    }

    // CRITICAL: Just filter existing year data - no API calls
    // All year data is already loaded in fetchPayroll from getAdminMetricsAndPayrollData
    const periodStart = toLocalYMD(currentPeriod.start);
    const periodEnd = toLocalYMD(currentPeriod.end);

    const filtered = payrollData.payrollRecords.filter((r) =>
    r.pay_period_start === periodStart && r.pay_period_end === periodEnd
    );

    setPayrollRecords(filtered);
  }, [currentPeriod, payrollData?.payrollRecords]);

  // All useCallback hooks must be declared here, before useEffect
  const handleCaptureScreenshot = useCallback(async () => {
    setIsCapturingScreenshot(true);
    toast.info('Capturing screenshot...');

    // Store original theme class BEFORE the try so the catch path can restore it
    // (Oct 2 2026: it was declared inside try, and the old catch only stripped
    // 'light-theme' — leaving a Dark-theme user with NO theme class at all, so
    // the app's CSS vars fell back to light while Tailwind dark: utilities
    // stayed dark → split light/dark page until reload).
    const htmlElement = document.documentElement;
    const originalThemeClass = htmlElement.className;

    try {
      if (!contentRef.current) {
        toast.error('Content not found');
        return;
      }

      // Force light mode temporarily
      htmlElement.classList.remove('dark-theme', 'auto-theme');
      htmlElement.classList.add('light-theme');

      // Hide all controls, buttons, toggles, and dropdowns
      const controlsElement = document.getElementById('payroll-controls');
      if (controlsElement) {
        controlsElement.style.display = 'none';
      }

      // Hide Select dropdowns and other UI controls
      const selectTriggers = contentRef.current.querySelectorAll('[class*="SelectTrigger"]');
      selectTriggers.forEach((el) => {
        el.style.display = 'none';
      });

      // Hide any buttons within the content
      const buttons = contentRef.current.querySelectorAll('button');
      buttons.forEach((el) => {
        el.style.display = 'none';
      });

      // Hide App Fee % rows
      const appFeeRows = document.querySelectorAll('[data-app-fee-row="true"]');
      appFeeRows.forEach((row) => {row.style.display = 'none';});

      // Hide Notes sections
      const notesSections = contentRef.current.querySelectorAll('[data-notes-section="true"]');
      notesSections.forEach((el) => {el.style.display = 'none';});

      // Unclip the scroll area so html2canvas renders the FULL page, not just
      // the visible viewport portion (the flex-1 min-h-0 overflow container was
      // cropping the capture to one screen's worth of driver cards).
      const scrollEl = payrollScrollRef.current;
      if (scrollEl) {
        scrollEl.style.overflow = 'visible';
        scrollEl.style.maxHeight = 'none';
        scrollEl.style.flex = 'none';
      }

      // Small delay to ensure UI updates
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Capture with html2canvas using better settings for clean output
      const canvas = await html2canvas(contentRef.current, {
        backgroundColor: '#f8fafc',
        scale: 2,
        useCORS: true,
        logging: false,
        imageTimeout: 0,
        allowTaint: true
      });

      // Restore original theme
      htmlElement.className = originalThemeClass;

      // Show all controls again
      if (controlsElement) {
        controlsElement.style.display = 'flex';
      }

      selectTriggers.forEach((el) => {
        el.style.display = '';
      });

      buttons.forEach((el) => {
        el.style.display = '';
      });

      // Show App Fee % rows again
      appFeeRows.forEach((row) => {row.style.display = '';});

      // Show Notes sections again
      const notesSectionsToShow = contentRef.current.querySelectorAll('[data-notes-section="true"]');
      notesSectionsToShow.forEach((el) => {el.style.display = '';});

      const dataUrl = canvas.toDataURL('image/png');
      setScreenshotDataUrl(dataUrl);
      setShowScreenshotModal(true);
      toast.success('Screenshot captured!');
    } catch (error) {
      console.error('Screenshot error:', error);
      toast.error('Failed to capture screenshot');

      // Restore original state on error — the full captured class set
      htmlElement.className = originalThemeClass;
      const controlsElement = document.getElementById('payroll-controls');
      if (controlsElement) {
        controlsElement.style.display = 'flex';
      }
    } finally {
      const scrollEl = payrollScrollRef.current;
      if (scrollEl) {
        scrollEl.style.overflow = '';
        scrollEl.style.maxHeight = '';
        scrollEl.style.flex = '';
      }
      setIsCapturingScreenshot(false);
    }
  }, []);

  const payrollPageCacheRef = useRef(new Map());
  const fullYearPayrollDataRef = useRef(null);

  const mergePagedPayrollData = useCallback((existingData, incomingData) => {
    if (!incomingData) return existingData;
    if (!existingData) return incomingData;

    const mergeById = (first = [], second = []) => {
      const map = new Map();
      [...first, ...second].forEach((item) => {
        if (!item?.id) return;
        map.set(item.id, { ...(map.get(item.id) || {}), ...item });
      });
      return Array.from(map.values());
    };

    return {
      ...existingData,
      ...incomingData,
      deliveries: mergeById(existingData.deliveries, incomingData.deliveries),
      patients: mergeById(existingData.patients, incomingData.patients),
      stores: mergeById(existingData.stores, incomingData.stores),
      appUsers: mergeById(existingData.appUsers, incomingData.appUsers),
      drivers: mergeById(existingData.drivers, incomingData.drivers),
      payrollRecords: mergeById(existingData.payrollRecords, incomingData.payrollRecords)
    };
  }, []);

  // Offline-first payroll page payload cache (AdminMetrics pattern, Oct 4 2026).
  // The full-year gather takes ~30s server-side; render the last saved payload
  // instantly and resync quietly behind it.
  const getPayrollPageCacheKey = useCallback((year, cityId) => `payroll-page-v1-${year}-${cityId}`, []);

  const saveOfflinePayroll = useCallback(async (year, cityId, data) => {
    if (!year || !cityId || !data) return;
    try {
      await offlineDB.save(offlineDB.STORES.PAYROLL_PAGE_CACHE, {
        id: getPayrollPageCacheKey(year, cityId),
        year: parseInt(year, 10),
        city_id: cityId,
        payrollData: data,
        saved_date: new Date().toISOString()
      });
    } catch (e) {
      console.warn('⚠️ [DriverPayroll] Failed to save offline payroll cache:', e);
    }
  }, [getPayrollPageCacheKey]);

  const loadOfflinePayroll = useCallback(async (year, cityId) => {
    if (!year || !cityId) return false;
    try {
      const cached = await offlineDB.getById(offlineDB.STORES.PAYROLL_PAGE_CACHE, getPayrollPageCacheKey(year, cityId));
      const data = cached?.payrollData;
      if (!data || !Array.isArray(data.deliveries)) return false;
      const cacheKey = `${year}-${cityId}`;
      // Only apply when it matches the requested selection and there is no
      // newer live data for this exact selection already rendered.
      if (data.__cacheKey !== cacheKey) return false;
      setPayrollData((prev) => (!prev || prev?.__cacheKey !== cacheKey) ? data : prev);
      setPayrollRecords(data?.payrollRecords || []);
      setLoadedFromOffline(true);
      // Cached data is on screen now — never leave the page on the blocking
      // spinner/banner waiting for the background refresh below to finish.
      setIsLoadingPayroll(false);
      // Oct 15: return the DATA (truthy) — the caller passes it to fetchPayroll
      // as the merge base so the paged refresh never drops historical months.
      return data;
    } catch (e) {
      console.warn('⚠️ [DriverPayroll] No offline payroll cache:', e);
      return false;
    }
  }, [getPayrollPageCacheKey]);

  // Oct 15 owner spec step 3: after the server-side sync, persist the selected
  // year's Payroll records into the offline DB one cycle (pay period) at a time.
  // Scoped to the selected year only — older years are never touched.
  const persistPayrollCyclesToIdb = useCallback(async (year, payrollRecords) => {
    if (!year || !Array.isArray(payrollRecords) || payrollRecords.length === 0) return;
    const yearNum = parseInt(year, 10);
    const scoped = payrollRecords.filter((r) => {
      const startY = r?.pay_period_start ? parseInt(String(r.pay_period_start).slice(0, 4), 10) : null;
      return startY === yearNum;
    });
    const cycles = new Map();
    scoped.forEach((r) => {
      const key = `${r.pay_period_start}_${r.pay_period_end}`;
      if (!cycles.has(key)) cycles.set(key, []);
      cycles.get(key).push(r);
    });
    let saved = 0;
    for (const [key, recs] of cycles) {
      try {
        await offlineDB.bulkSave(offlineDB.STORES.PAYROLL, recs);
        saved += recs.length;
        console.log(`💾 [DriverPayroll] IDB payroll cycle saved ${key}: ${recs.length} records`);
      } catch (e) {
        console.warn(`⚠️ [DriverPayroll] IDB payroll cycle save failed ${key}:`, e?.message || e);
      }
    }
    if (saved > 0) console.log(`💾 [DriverPayroll] IDB payroll sync complete: ${saved}/${scoped.length} records across ${cycles.size} cycle(s) for ${yearNum}`);
  }, []);

  // ── QUIET HISTORY BACKFILL (owner plan Oct 18 2026, step 3) ─────────────────
  // After the page renders from IDB and the CURRENT cycle syncs, slowly and
  // quietly fill any MISSING historical months of the selected year into the
  // offline cache — one month per paged call, staggered 2.5s, no sync banner,
  // no blocking. Once a year+city+scope pass completes it is flagged and never
  // repeated on this device. Drivers receive only their own records because
  // the backend scopes driver-only requests to the requester.
  const historyBackfillRef = useRef(null);
  const quietHistoryBackfill = useCallback(async () => {
    const year = selectedYear;
    const cityId = selectedCityId;
    const data = payrollDataRef.current;
    if (!year || !cityId || !data || data.__cacheKey !== `${year}-${cityId}`) return;
    if (historyBackfillRef.current) return; // a pass is already running

    const scopeKey = isDriver ? 'self' : 'city';
    const flagKey = `payroll_hist_bf_${year}_${cityId}_${scopeKey}`;
    try { if (localStorage.getItem(flagKey) === 'done') return; } catch (_) {}

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const lastMonth = Number(year) === currentYear ? currentMonth : 12;
    const loadedMonths = new Set(
      (data.deliveries || []).map((d) => Number(String(d?.delivery_date || '').slice(5, 7))).filter(Boolean)
    );
    const missing = [];
    for (let m = 1; m <= lastMonth; m++) {
      if (!loadedMonths.has(m)) missing.push(m);
    }
    if (missing.length === 0) {
      try { localStorage.setItem(flagKey, 'done'); } catch (_) {}
      return;
    }
    console.log(`[DriverPayroll] quiet history backfill: ${missing.length} missing month(s) for ${year}/${cityId} [${scopeKey}]`);

    const run = async () => {
      let ok = 0;
      for (const m of missing) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          // Owner report Oct 31 2026 (values flipping between 6.54 / 10.41 on every
          // refresh): this loop captured ONE snapshot up front and wrote it back
          // minutes later, so a manual refresh landing mid-pass was silently
          // reverted to the older rows. Always merge onto the CURRENT state and
          // skip months that are already loaded.
          const latest = payrollDataRef.current;
          if (!latest) continue;
          const alreadyLoaded = new Set(
            (latest.deliveries || []).map((d) => Number(String(d?.delivery_date || '').slice(5, 7))).filter(Boolean)
          );
          if (alreadyLoaded.has(Number(m))) continue;
          const res = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
            payrollYear: year,
            payrollCityId: cityId,
            payrollPaginationMode: 'paged',
            payrollPageMonths: [m]
          });
          const raw = res?.data?.payrollData || res?.payrollData;
          if (raw) {
            merged = { ...mergePagedPayrollData(payrollDataRef.current || latest, raw, [m]), __cacheKey: `${year}-${cityId}` };
            // per-month cycle persistence into the offline DB (quiet)
            persistPayrollCyclesToIdb(year, raw?.payrollRecords || []).catch(() => {});
            ok++;
          }
        } catch (e) {
          console.warn(`[DriverPayroll] quiet backfill month ${m} failed:`, e?.message || e);
        }
      }
      if (ok > 0) {
        fullYearPayrollDataRef.current = merged;
        lastFetchTimestampRef.current = Date.now();
        setPayrollData(merged);
        setPayrollRecords(merged?.payrollRecords || []);
        saveOfflinePayroll(year, cityId, merged);
      }
      try { localStorage.setItem(flagKey, 'done'); } catch (_) {}
      console.log(`[DriverPayroll] quiet history backfill done: ${ok}/${missing.length} month(s) filled for ${year}/${cityId}`);
    };

    historyBackfillRef.current = run().finally(() => { historyBackfillRef.current = null; });
  }, [selectedYear, selectedCityId, isDriver, mergePagedPayrollData, persistPayrollCyclesToIdb, saveOfflinePayroll]);

  const fetchPayroll = useCallback(async (isAutoRefresh = false, forceFresh = false, { bypassSummary = false, refreshMonths = 0, baseData = null } = {}) => {
    if (!currentUser || !isPayrollPageActive || !selectedCityId) {
      // Oct 15: this guard silently killed the page for users whose city never
      // resolved — ship the reason so the deadlock is visible in remote logs.
      console.warn(`⚠️ [DriverPayroll] fetchPayroll blocked — user=${!!currentUser} pageActive=${isPayrollPageActive} city=${selectedCityId || 'NONE'}`);
      return;
    }

    // Oct 15: refreshMonths is now an EXPLICIT list of months (the current pay
    // cycle's months) — historical months are never re-gathered by client
    // devices anymore; the payroll history host owns them (payrollHistorySync).
    const refreshMonthsList = Array.isArray(refreshMonths)
      ? refreshMonths.map((m) => Number(m)).filter((m) => m >= 1 && m <= 12)
      : (refreshMonths > 0
          ? Array.from({ length: refreshMonths }, (_, i) => new Date().getMonth() + 1 - i).filter((m) => m >= 1)
          : []);

    const cacheKey = `${selectedYear}-${selectedCityId}`;
    const fetchSignature = `${cacheKey}-${isAutoRefresh}-${forceFresh}-${bypassSummary}-${refreshMonthsList.join(',')}`;
    const now = Date.now();
    if (lastFetchSignatureRef.current === fetchSignature && now - lastFetchTimestampRef.current < 5000) {
      return fullYearPayrollDataRef.current;
    }

    if (!forceFresh && fullYearPayrollDataRef.current?.__cacheKey === cacheKey && lastFetchTimestampRef.current > 0) {
      return fullYearPayrollDataRef.current;
    }

    if (fetchPayrollInFlightRef.current) {
      // a manual bypass-summary request waits for the in-flight load, then runs its own
      if (bypassSummary && !fetchPayrollInFlightRef.bypass) {
        try { await fetchPayrollInFlightRef.current; } catch (e) {}
      } else {
        return fetchPayrollInFlightRef.current;
      }
    }

    const runFetch = async () => {
      setIsPayrollSyncing(true);
      // Owner Oct 12: Manual Payroll Sync blanked the whole screen and showed
      // the "First-time sync" banner because it flipped the BLOCKING flag even
      // though data was already rendered. Only block on a true first load
      // (nothing on screen); otherwise sync quietly behind the visible data.
      if (!isAutoRefresh && !fullYearPayrollDataRef.current && !payrollDataRef.current) setIsLoadingPayroll(true);
      try {
        // Oct 15 outage fix: the FULL-YEAR response (~10MB+ with all months'
        // deliveries + patients) exceeds the platform's function response limit —
        // every user got a 500 (Anna, Riyaz, owner 23:2x). Paged mode fetches
        // ONLY the current pay cycle's months; payroll records, drivers, stores
        // and patients refs still arrive year-wide in every paged response.
        const pageMonths = refreshMonthsList.length ? refreshMonthsList : [new Date().getMonth() + 1];
        console.log(`📥 [DriverPayroll] Fetching paged payroll - Year: ${selectedYear} months: [${pageMonths.join(',')}]`);
        const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
          payrollYear: selectedYear,
          payrollCityId: selectedCityId,
          payrollPaginationMode: 'paged',
          payrollPageMonths: pageMonths,
          forceRefreshCurrentYear: bypassSummary
        });
        const rawData = response?.data?.payrollData || response?.payrollData;
        const priorYearData = baseData || fullYearPayrollDataRef.current || payrollDataRef.current || null;
        let data = rawData ? { ...mergePagedPayrollData(priorYearData, rawData, pageMonths), __cacheKey: cacheKey } : rawData;
        // Cold device (no cache, no prior year rendered — e.g. a driver's first
        // payroll visit): stitch the missing months from one-month paged fetches
        // so the full year lands on screen and in the offline cache. One-time
        // cost; every later load serves instantly from the offline cache.
        if (data && !priorYearData) {
          const missingMonths = missingPayrollMonthsFor(selectedYear, pageMonths);
          for (const m of missingMonths) {
            try {
              const res2 = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
                payrollYear: selectedYear,
                payrollCityId: selectedCityId,
                payrollPaginationMode: 'paged',
                payrollPageMonths: [m]
              });
              const raw2 = res2?.data?.payrollData || res2?.payrollData;
              if (raw2) data = { ...mergePagedPayrollData(data, raw2, [m]), __cacheKey: cacheKey };
            } catch (e) {
              console.warn(`⚠️ [DriverPayroll] cold-boot month ${m} fetch failed:`, e?.message || e);
            }
          }
        }

        fullYearPayrollDataRef.current = data;
        lastFetchSignatureRef.current = fetchSignature;
        lastFetchTimestampRef.current = Date.now();

        console.log(`✅ [DriverPayroll] Loaded:`, {
          deliveries: data?.deliveries?.length || 0,
          drivers: data?.drivers?.length || 0,
          payrollRecords: data?.payrollRecords?.length || 0
        });

        setPayrollData(data);
        setPayrollRecords(data?.payrollRecords || []);
        setLoadedFromOffline(false);
        // Oct 15 owner spec: server sync first (current cycle up to date online),
        // then sync online→offline for the SELECTED YEAR only, one payroll cycle
        // at a time, so the offline DB holds the current cycle for this city.
        persistPayrollCyclesToIdb(selectedYear, data?.payrollRecords).catch(() => {});
        saveOfflinePayroll(selectedYear, selectedCityId, data);
        return data;
      } catch (error) {
        // Log the server's error body too — the Oct 15 outage showed only
        // "status 500" client-side while the true cause sat in the response.
        console.error('Failed to fetch payroll data:', error?.message, '| server:', error?.response?.data?.error || '(no body)');
        toast.error(error?.response?.data?.error || error?.message || 'Failed to refresh payroll data');
        throw error;
      } finally {
        fetchPayrollInFlightRef.current = null;
        setIsPayrollSyncing(false);
        // Always clear: by the time any fetch (foreground or background)
        // settles, there is something on screen (fresh data, cache, or an
        // error toast) — the blocking state must never outlive the request.
        setIsLoadingPayroll(false);
      }
    };

    fetchPayrollInFlightRef.bypass = !!bypassSummary;
    fetchPayrollInFlightRef.current = runFetch();
    return fetchPayrollInFlightRef.current;
  }, [selectedYear, selectedCityId, currentUser, isPayrollPageActive, saveOfflinePayroll]);

  // Authoritative payroll re-gather (owner directive Oct 31 2026): the spinner
  // must re-check the SELECTED cycle's real records every time, finalized or
  // not. This bypasses every client cache guard (in-flight promise reuse,
  // 5s signature skip, offline base merge) and writes the server rows for the
  // cycle's months straight into state, so a click can never leave last week's
  // numbers on screen.
  const deepRefreshPayrollCycle = useCallback(async () => {
    if (!selectedCityId) throw new Error('No city selected');
    const months = [...new Set([
      ...getSelectedPeriodMonths(currentPeriod),
      ...getCurrentPayrollCycleMonths(selectedYear, payPeriod),
    ])].sort((a, b) => a - b);
    const effectiveMonths = months.length ? months : [new Date().getMonth() + 1];
    const res = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
      payrollYear: selectedYear,
      payrollCityId: selectedCityId,
      payrollPaginationMode: 'paged',
      payrollPageMonths: effectiveMonths,
      forceRefreshCurrentYear: true
    });
    const raw = res?.data?.payrollData || res?.payrollData;
    if (!raw || !Array.isArray(raw.deliveries)) throw new Error('Payroll service returned no data');
    const base = fullYearPayrollDataRef.current || payrollDataRef.current || {};
    const monthSet = new Set(effectiveMonths.map(Number));
    const inMonths = (d) => monthSet.has(Number(String(d?.delivery_date || '').slice(5, 7)));
    const byId = (a, b) => {
      const map = new Map();
      (a || []).forEach((r) => { if (r?.id) map.set(r.id, r); });
      (b || []).forEach((r) => { if (r?.id) map.set(r.id, r); });
      return Array.from(map.values());
    };
    const next = {
      ...base,
      ...raw,
      deliveries: [
        ...((base?.deliveries) || []).filter((d) => !inMonths(d)),
        ...(raw.deliveries || [])
      ],
      patients: byId(base?.patients, raw.patients),
      appUsers: byId(base?.appUsers, raw.appUsers),
      stores: byId(base?.stores, raw.stores),
      cities: byId(base?.cities, raw.cities),
      payrollRecords: byId(base?.payrollRecords, raw.payrollRecords),
      __cacheKey: `${selectedYear}-${selectedCityId}`
    };
    fullYearPayrollDataRef.current = next;
    lastFetchTimestampRef.current = Date.now();
    lastFetchSignatureRef.current = '';
    setPayrollData(next);
    setPayrollRecords(next.payrollRecords || []);
    saveOfflinePayroll(selectedYear, selectedCityId, next);
    // Keep the history host's markers in step with what just landed.
    try { persistPayrollCyclesToIdb(selectedYear, next.payrollRecords).catch(() => {}); } catch (_) {}
    return next;
  }, [selectedCityId, selectedYear, payPeriod, currentPeriod, saveOfflinePayroll, persistPayrollCyclesToIdb]);

  // OWNER SPEC Oct 31 2026 (v2 - deep fix): the payroll spinner must COMPLETELY
  // recalculate the selected period from the real stop data, including edits the
  // owner just made on a delivery or a patient. Sources, in order:
  //   1. the LOCAL offline DB for the period's deliveries and their patients -
  //      this is what the stop cards and forms write instantly, so a km the owner
  //      has just corrected is picked up even before the server catches up
  //   2. the Delivery entity over the network, only when the local rows are empty
  // The rows replace the payload's rows for the period, so deliveries, extra km,
  // oversized, after hours, no charge and failed/returns all recompute from them.
  const refreshSelectedPeriodFromDeliveries = useCallback(async () => {
    if (!currentPeriod || !selectedCityId) return 0;
    const from = toLocalYMD(currentPeriod.start);
    const to = toLocalYMD(currentPeriod.end);

    let rows = [];
    try {
      rows = await offlineDB.getDeliveriesByDateRange(from, to);
      console.log(`📦 [DriverPayroll] period rebuild: ${Array.isArray(rows) ? rows.length : 0} local stop(s) for ${from}..${to}`);
    } catch (e) {
      console.warn('[DriverPayroll] local period delivery read failed:', e?.message || e);
      rows = [];
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      try {
        rows = await base44.entities.Delivery.filter(
          { delivery_date: { $gte: from, $lte: to } },
          'delivery_date',
          5000
        );
        console.log(`📥 [DriverPayroll] period rebuild: ${Array.isArray(rows) ? rows.length : 0} server stop(s) for ${from}..${to}`);
      } catch (e) {
        console.warn('[DriverPayroll] server period delivery read failed:', e?.message || e);
        return 0;
      }
    }
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    const cityStoreIds = new Set((filteredStores || []).map((s) => s.id));
    const inPeriod = (d) => d && d.delivery_date >= from && d.delivery_date <= to;
    const fresh = rows
      .filter((d) => d && inPeriod(d) && (!cityStoreIds.size || cityStoreIds.has(d.store_id)))
      .map((d) => ({
        id: d.id,
        delivery_date: d.delivery_date,
        delivery_id: d.delivery_id,
        driver_id: d.driver_id,
        driver_name: d.driver_name,
        store_id: d.store_id,
        patient_id: d.patient_id,
        status: d.status,
        after_hours_pickup: d.after_hours_pickup,
        after_hours_rate: d.after_hours_rate,
        paid_km_override: d.paid_km_override,
        travel_dist: d.travel_dist,
        oversized: d.oversized,
        no_charge: d.no_charge,
        delivery_notes: d.delivery_notes,
        actual_delivery_time: d.actual_delivery_time
      }));

    // Patients for these stops, straight from the local DB too - a corrected
    // patient km is what a blank-override stop is paid from.
    let freshPatients = [];
    try {
      const neededIds = new Set(fresh.map((d) => d.patient_id).filter(Boolean));
      if (neededIds.size > 0) {
        const localPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
        freshPatients = (localPatients || [])
          .filter((p) => p && neededIds.has(p.id))
          .map((p) => ({
            id: p.id,
            full_name: p.full_name,
            store_id: p.store_id,
            distance_from_store: p.distance_from_store,
            latitude: p.latitude,
            longitude: p.longitude
          }));
      }
    } catch (e) {
      console.warn('[DriverPayroll] local period patient read failed:', e?.message || e);
    }

    setPayrollData((prev) => {
      if (!prev) return prev;
      const keptPatients = (prev.patients || []).filter((p) => !freshPatients.some((fp) => fp.id === p?.id));
      const next = {
        ...prev,
        deliveries: [...(prev.deliveries || []).filter((d) => !inPeriod(d)), ...fresh],
        patients: [...keptPatients, ...freshPatients],
        __cacheKey: prev.__cacheKey || `${selectedYear}-${selectedCityId}`,
        __periodRefreshedAt: Date.now()
      };
      fullYearPayrollDataRef.current = next;
      payrollDataRef.current = next;
      return next;
    });
    return fresh.length;
  }, [currentPeriod, selectedCityId, filteredStores, selectedYear]);


  // PAYROLL DATA REFRESH (the spinner next to the by-store table). This must NOT
  // touch the app refresh manager — owner report Oct 31 2026: the table spinner
  // was firing the page-level refresh too and spamming rate limits.
  const handlePayrollDataRefresh = useCallback(async () => {
    if (!selectedCityId) return;
    setIsRefreshing(true);
    try {
      await deepRefreshPayrollCycle();
      await refreshSelectedPeriodFromDeliveries();
      if (refreshPayrollRecords) await refreshPayrollRecords();
      setLiveKmToken((n) => n + 1); // re-read the entity overrides
      setForceFinalizedSyncToken((n) => n + 1);
      toast.success('Payroll data refreshed');
    } catch (error) {
      console.error('❌ [DriverPayroll] Payroll data refresh failed:', error);
      toast.error(error?.response?.data?.error || error?.message || 'Failed to refresh payroll data');
    } finally {
      setIsRefreshing(false);
    }
  }, [deepRefreshPayrollCycle, refreshSelectedPeriodFromDeliveries, refreshPayrollRecords, selectedCityId]);


  const handleManualRefresh = useCallback(async () => {
    if (!selectedCityId) return;
    setIsRefreshing(true);
    console.log('🔄 [DriverPayroll] Manual refresh triggered');
    try {
      // Owner directive Oct 30 2026: Refresh re-checks the SELECTED pay cycle's
      // own months (finalized or not), plus the current cycle, and asks the
      // server for live entity data instead of the cached summary.
      await deepRefreshPayrollCycle();
      if (refreshPayrollRecords) {
        await refreshPayrollRecords();
      }
      setLiveKmToken((n) => n + 1);
      // Re-read the local delivery km overrides so a just-edited override shows
      // up even when the payroll payload lags behind.
      // Push the recalculated totals onto the stored records — even when the
      // selected pay period is already driver-confirmed / admin-finalized.
      setForceFinalizedSyncToken((n) => n + 1);
      toast.success('Payroll data refreshed');
    } catch (error) {
      console.error('❌ [DriverPayroll] Refresh failed:', error);
      toast.error(error?.response?.data?.error || error?.message || 'Failed to refresh payroll data');
    } finally {
      setIsRefreshing(false);
    }
  }, [deepRefreshPayrollCycle, refreshPayrollRecords, selectedCityId, selectedYear, payPeriod, currentPeriod]);

  // ON-DEMAND PERIOD SYNC (owner report Oct 23 2026: selecting an older
  // payroll cycle showed empty data). Page load gathers only the CURRENT
  // cycle's months; older cycles relied entirely on the offline full-year
  // cache / history host, so any device whose PAYROLL_PAGE_CACHE was thin
  // rendered every older cycle empty ("up to 1 past cycle"). Now the selected
  // period fetches ITS OWN missing months (paged, merged, persisted back to
  // the offline cache — which self-heals the device). Fetched periods are
  // remembered per year+city+period so legitimately-empty cycles (a week with
  // zero stops) don't loop.
  const onDemandFetchedRef = useRef(new Set());
  useEffect(() => {
    if (!hasInitialized || !isPayrollPageActive || !selectedCityId) return;
    if (!currentPeriod || !payrollData) return;
    const deliveries = Array.isArray(payrollData?.deliveries) ? payrollData.deliveries : [];
    const periodMonths = [...new Set([
      currentPeriod.start.getMonth() + 1,
      currentPeriod.end.getMonth() + 1
    ])].filter((m) => m >= 1 && m <= 12);
    const loadedMonths = new Set(
      deliveries.map((d) => Number(String(d?.delivery_date || '').slice(5, 7))).filter((m) => m >= 1 && m <= 12)
    );
    const missing = periodMonths.filter((m) => !loadedMonths.has(m));
    if (missing.length === 0) return;
    const demandKey = `${selectedYear}-${selectedCityId}-${toLocalYMD(currentPeriod.start)}-${toLocalYMD(currentPeriod.end)}`;
    if (onDemandFetchedRef.current.has(demandKey)) return; // empty cycle — never re-fetch it
    // If the initial-load fetch is still in flight, wait — fetchPayroll would
    // just return its promise without fetching our months, and marking the
    // key now would prevent the retry. The effect refires when it completes.
    if (fetchPayrollInFlightRef.current) return;
    onDemandFetchedRef.current.add(demandKey);
    console.log(`📥 [DriverPayroll] On-demand period sync: missing month(s) [${missing.join(',')}] for ${demandKey}`);
    fetchPayroll(false, true, { refreshMonths: missing }).catch((e) => {
      console.warn('⚠️ [DriverPayroll] On-demand period sync failed:', e?.message || e);
    });
  }, [hasInitialized, isPayrollPageActive, selectedCityId, selectedYear,
      currentPeriod?.start?.getTime?.() ?? null, currentPeriod?.end?.getTime?.() ?? null,
      payrollData?.deliveries, fetchPayroll]);

  // Navigation handlers - must be useCallback
  const goToPrevPeriod = useCallback(() => {
    if (selectedPeriodIndex > 0) {
      isManualChangeRef.current = true; // Mark manual navigation to prevent auto-reset
      setSelectedPeriodIndex((idx) => Math.max(0, idx - 1));
      setTimeout(() => {isManualChangeRef.current = false;}, 200);
    }
  }, [selectedPeriodIndex]);

  const goToNextPeriod = useCallback(() => {
    if (selectedPeriodIndex < allPeriods.length - 1) {
      isManualChangeRef.current = true; // Mark manual navigation to prevent auto-reset
      setSelectedPeriodIndex((idx) => Math.min(allPeriods.length - 1, idx + 1));
      setTimeout(() => {isManualChangeRef.current = false;}, 200);
    }
  }, [selectedPeriodIndex, allPeriods.length]);

  // Require a valid city selection before loading payroll data
  useEffect(() => {
    if (!sortedCities.length) return;
    if (selectedCityId && sortedCities.some((city) => city.id === selectedCityId)) return;
    if (selectedCityId) {
      setSelectedCityId('');
    }
  }, [sortedCities, selectedCityId]);

  useEffect(() => {
    if (!needsCitySelection) return;
    const timer = setTimeout(() => {
      citySelectTriggerRef.current?.click();
    }, 150);
    return () => clearTimeout(timer);
  }, [needsCitySelection]);

  // Trigger fetch when filters change (after initialization)
  // Force a fresh fetch when year changes so stale cached data for past years is replaced
  useEffect(() => {
    if (!hasInitialized || !isPayrollPageActive || !selectedCityId) return;
    let cancelled = false;
    (async () => {
      // Instant render from the last saved payload, then refresh silently.
      // First-ever visit (no cache) keeps the blocking spinner.
      const gotOffline = await loadOfflinePayroll(selectedYear, selectedCityId).catch(() => false);
      if (cancelled) return;
      const offlineBase = (gotOffline && typeof gotOffline === 'object') ? gotOffline : null;
      // Owner Oct 15: sync right after load covers ONLY the current pay cycle
      // (1-2 months). Historical cycles are owned by the payroll history host
      // (Editor → PWA fallback, payrollHistorySync.js) — client devices never
      // re-gather history on load or refresh anymore.
      fetchPayroll(!!gotOffline, true, { refreshMonths: getCurrentPayrollCycleMonths(selectedYear, payPeriod), baseData: offlineBase }).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, [hasInitialized, isPayrollPageActive, selectedCityId, selectedYear, payPeriod, fetchPayroll, loadOfflinePayroll]);

  // Kick the quiet history backfill whenever a fresh payload for the current
  // year+city lands on screen (post IDB-render + current-cycle sync).
  useEffect(() => {
    if (!payrollData?.__cacheKey || !hasInitialized || !isPayrollPageActive) return;
    const t = setTimeout(() => { quietHistoryBackfill().catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [payrollData?.__cacheKey, hasInitialized, isPayrollPageActive, quietHistoryBackfill]);

  // Grace timer for the blocking spinner: only counts when a blocking load is in
  // flight (isAutoRefresh loads never set isLoadingPayroll).
  useEffect(() => {
    if (!isLoadingPayroll) return;
    setBlockingGraceExpired(false);
    const t = setTimeout(() => setBlockingGraceExpired(true), 10000);
    return () => clearTimeout(t);
  }, [isLoadingPayroll]);

  // Initialize defaults based on user role - runs ONCE on mount
  // CRITICAL: Reads offline Payroll records to determine the correct pay cycle + period BEFORE rendering data
  useEffect(() => {
    if (!currentUser || hasInitialized || !isPayrollPageActive) return;

    const initFromOfflineData = async () => {
      // Oct 15: city resolution ladder — merged-user city_id, then city_ids[0],
      // then the OWN AppUser record from the offline DB. A missing city used to
      // deadlock the whole page (no fetch, no city prompt, no data).
      let defaultCityId = currentUser?.city_id ||
        (Array.isArray(currentUser?.city_ids) && currentUser.city_ids[0]) || '';

      // Step 1: Read AppUsers from offline DB to determine pay cycle
      // (hoisted above city selection so the AppUser city fallback is available)
      let determinedPayCycle = 'monthly'; // fallback
      let offlineAppUsers = [];
      try {
        // 5s guard: a stalled IDB transaction must not hang init forever
        // (hasInitialized would never set and the page would never fetch).
        offlineAppUsers = await Promise.race([
          offlineDB.getAll(offlineDB.STORES.APP_USERS),
          new Promise((_, rej) => setTimeout(() => rej(new Error('offlineDB getAll APP_USERS timed out')), 5000))
        ]) || [];
      } catch (e) {
        console.warn('⚠️ [DriverPayroll] Could not read offline AppUsers for pay cycle:', e);
      }
      if (!defaultCityId) {
        const myAppUser = (offlineAppUsers || []).find((au) => au.user_id === currentUser.id);
        defaultCityId = myAppUser?.city_id ||
          (Array.isArray(myAppUser?.city_ids) && myAppUser.city_ids[0]) || '';
        if (defaultCityId) console.log(`📍 [DriverPayroll] City resolved from offline AppUser: ${defaultCityId}`);
      }

      setSelectedCityId(defaultCityId && defaultCityId !== 'all' ? defaultCityId : '');

      if (isDriver) {
        setSelectedDriverId(currentUser.id);
      } else {
        setSelectedDriverId('all');
      }

      try {
        const activeDrivers = (offlineAppUsers || []).filter((au) => au.app_roles?.includes('driver'));

        if (isDriver) {
          const myAppUser = activeDrivers.find((au) => au.user_id === currentUser.id);
          if (myAppUser?.pay_cycle_type) determinedPayCycle = myAppUser.pay_cycle_type;
        } else {
          // Admin: find the most common pay cycle
          const cycleCounts = {};
          activeDrivers.forEach((au) => {
            if (au.pay_cycle_type) cycleCounts[au.pay_cycle_type] = (cycleCounts[au.pay_cycle_type] || 0) + 1;
          });
          let maxCount = 0;
          Object.entries(cycleCounts).forEach(([cycle, count]) => {
            if (count > maxCount) {maxCount = count;determinedPayCycle = cycle;}
          });
        }
      } catch (e) {
        console.warn('⚠️ [DriverPayroll] Could not read offline AppUsers for pay cycle:', e);
      }

      // Step 2: Compute periods for determined pay cycle and find the right period index
      const year = new Date().getFullYear();
      const periods = calculateAllPeriods(year, determinedPayCycle);
      let determinedPeriodIndex = 0;
      const today = new Date();

      // Determine the closest relevant index for today within this year's periods
      const todayStr = toLocalYMD(today);
      // Robust index detection using local date strings
      let idxClose = -1;
      for (let i = 0; i < periods.length; i++) {
        const s = toLocalYMD(periods[i].start);
        const e = toLocalYMD(periods[i].end);
        if (todayStr >= s && todayStr <= e) {idxClose = i;break;}
      }
      if (idxClose === -1) {
        let lastPastIdx = -1;
        let lastPastEnd = '0000-00-00';
        for (let i = 0; i < periods.length; i++) {
          const e = toLocalYMD(periods[i].end);
          if (e < todayStr && e > lastPastEnd) {lastPastIdx = i;lastPastEnd = e;}
        }
        idxClose = lastPastIdx !== -1 ? lastPastIdx : 0;
      }
      let isInRange = false;
      if (periods[idxClose]) {
        const s = toLocalYMD(periods[idxClose].start);
        const e = toLocalYMD(periods[idxClose].end);
        isInRange = todayStr >= s && todayStr <= e;
      }

      // Step 3: Read offline Payroll records and prefer previous period only when the whole cycle is still not admin finalized
      try {
        // Oct 15 fix: the store is 'payroll' (offlineDB.STORES.PAYROLL) — the old
        // 'payroll_records' name threw "object store was not found" on EVERY device.
        const offlinePayrolls = await Promise.race([
          offlineDB.getAll(offlineDB.STORES.PAYROLL),
          new Promise((_, rej) => setTimeout(() => rej(new Error('offlineDB getAll PAYROLL timed out')), 5000))
        ]).catch(() => []) || [];
        determinedPeriodIndex = determinePreferredPayrollPeriodIndex({
          periods,
          payrollRecords: offlinePayrolls,
          selectedCityId: defaultCityId,
          selectedDriverId: 'all',
          payPeriodType: determinedPayCycle,
          today
        });
      } catch (e) {
        determinedPeriodIndex = idxClose;
        console.warn('⚠️ [DriverPayroll] Could not read offline payroll records:', e);
      }

      // Set all state at once to avoid double-renders
      setPayPeriod(determinedPayCycle);
      setSelectedPeriodIndex(determinedPeriodIndex);
      setSelectedYear(year);
      setHasInitialized(true);

    };

    initFromOfflineData();
  }, [currentUser, isDriver, hasInitialized, isPayrollPageActive, fetchPayroll]);



  // Refine pay cycle when live data loads — ONLY on initial load, never override manual selection.
  // Uses getDriverCycleForDate to respect pay_rate_history (per-delivery classification).
  useEffect(() => {
    if (!payrollData?.appUsers || hasLoadedInitialDataRef.current || isManualChangeRef.current) return;

    // Initial determination only — pick the most common effective cycle among drivers
    let newCycle = null;
    if (!isDriver && selectedDriverId === 'all') {
      const cycleCounts = {};
      payrollData.appUsers.forEach((au) => {
        if (au?.app_roles?.includes('driver')) {
          const effective = getDriverCycleForDate(au, currentPeriod?.start);
          if (effective) cycleCounts[effective] = (cycleCounts[effective] || 0) + 1;
        }
      });
      let maxCount = 0;
      for (const [cycle, count] of Object.entries(cycleCounts)) {
        if (count > maxCount) { maxCount = count; newCycle = cycle; }
      }
    } else if (isDriver && selectedDriverId !== 'all') {
      const driverAppUser = payrollData.appUsers.find((au) => au.user_id === selectedDriverId);
      newCycle = getDriverCycleForDate(driverAppUser, currentPeriod?.start);
    }

    if (newCycle && newCycle !== payPeriod) {
      // CRITICAL: Recompute the period index for the NEW cycle's period array.
      // The init effect computed selectedPeriodIndex for the cycle guessed from
      // offline AppUsers. When live data reveals the real most-common cycle
      // differs, the old index is meaningless against the new cycle's periods
      // (e.g. monthly index 8 → weekly index 8 = late Feb). Without this
      // recompute the page opened to an early-year period and the live-records
      // effect (which locks periodSelectionDoneWithRecordsRef using the stale
      // old-cycle index) prevented it from ever correcting.
      const shouldClassify = newCycle === 'weekly' || newCycle === 'biweekly';
      const effectiveYear = shouldClassify ? getClassificationYearForDate(new Date(), newCycle) : selectedYear;
      const nextPeriods = calculateAllPeriods(effectiveYear, newCycle);
      const nextIdx = determinePreferredPayrollPeriodIndex({
        periods: nextPeriods,
        payrollRecords: payrollData?.payrollRecords || [],
        selectedCityId,
        selectedDriverId: 'all',
        payPeriodType: newCycle,
        today: new Date()
      });
      setPayPeriod(newCycle);
      if (shouldClassify && effectiveYear !== selectedYear) setSelectedYear(effectiveYear);
      setSelectedPeriodIndex(nextIdx);
      // Lock the selection so the live-records effect doesn't override with a
      // stale index computed for the previous cycle, and suppress the
      // auto-go-back-one effect from shifting the freshly-computed index.
      periodSelectionDoneWithRecordsRef.current = true;
      triedPreviousPeriodRef.current = true;
    }

    hasLoadedInitialDataRef.current = true;
  }, [payrollData?.appUsers, selectedDriverId, isDriver, payCycleInfo.mostCommon, payPeriod, currentPeriod, selectedCityId, selectedYear]);

  // Re-select period when live payroll records arrive (may override offline-based initial selection)
  const periodSelectionDoneWithRecordsRef = useRef(false);

  // Keep the selected period stable after initialization; dedicated effects handle choosing the correct period.

  useEffect(() => {
    if (!hasInitialized || !payrollData || allPeriods.length === 0) return;

    // Skip auto-selection during manual navigation
    if (isManualChangeRef.current) return;

    // Use full-year records if available to evaluate previous period; fallback to current state
    const allRecords = payrollData?.payrollRecords || payrollRecords || [];

    // Don't lock in the period selection until we have real live records.
    // If allRecords is empty, we're still using stale offline data — wait for live data.
    if (allRecords.length === 0 && !periodSelectionDoneWithRecordsRef.current) return;

    if (periodSelectionDoneWithRecordsRef.current) return;

    const targetIdx = determinePreferredPayrollPeriodIndex({
      periods: allPeriods,
      payrollRecords: allRecords,
      selectedCityId,
      selectedDriverId: 'all',
      payPeriodType: payPeriod,
      today: new Date()
    });

    if (targetIdx !== selectedPeriodIndex) {
      console.log(`🔧 [DriverPayroll] Period selection: ${selectedPeriodIndex} → ${targetIdx} (based on ${allRecords.length} records)`);
      setSelectedPeriodIndex(targetIdx);
    }
    periodSelectionDoneWithRecordsRef.current = true;
  }, [payPeriod, selectedYear, allPeriods, hasInitialized, payrollRecords, payrollData, selectedPeriodIndex]);


  // Filter payroll records when period changes (don't re-fetch since all year data is loaded)
  // CRITICAL: Uses refs to avoid redundant updates
  const lastFilteredPeriodRef = useRef(null);

  useEffect(() => {
    if (!currentPeriod || !hasInitialized || !payrollRecords.length) return;

    // CRITICAL: Skip if we've already filtered for this exact period
    const periodKey = `${currentPeriod.start}-${currentPeriod.end}`;
    if (lastFilteredPeriodRef.current === periodKey) return;

    lastFilteredPeriodRef.current = periodKey;

    // CRITICAL: Just filter, don't invalidate or re-fetch
    refreshPayrollRecords();
  }, [currentPeriod?.label, hasInitialized, payrollRecords.length]);

  // Auto-select previous period if current has no data AND previous period is not finalized.
  // CRITICAL: Only run after live data has loaded — not during initial offline-only phase.
  useEffect(() => {
    if (!hasInitialized || !payrollData) return;
    if (isManualChangeRef.current) return;
    if (selectedPeriodIndex === 0) return; // Can't go back further
    if (triedPreviousPeriodRef.current) return; // Already tried going back

    // Only proceed if we have live data loaded
    const allRecords = payrollData?.payrollRecords || [];
    if (allRecords.length === 0) return;

    // Check if the CURRENT period has any records
    if (!currentPeriod) return;
    const periodStart = toLocalYMD(currentPeriod.start);
    const periodEnd = toLocalYMD(currentPeriod.end);
    const currentPeriodRecords = allRecords.filter((r) =>
      r?.pay_period_start === periodStart && r?.pay_period_end === periodEnd
    );
    if (currentPeriodRecords.length > 0) return; // Current period has data, stay here

    // Current period has no records — check if previous period is finalized.
    // Only go back if previous period is NOT fully admin-finalized.
    const previousIdx = selectedPeriodIndex - 1;
    const previousPeriod = allPeriods[previousIdx];
    if (!previousPeriod) return;
    const prevStart = toLocalYMD(previousPeriod.start);
    const prevEnd = toLocalYMD(previousPeriod.end);
    const prevRecords = allRecords.filter((r) =>
      r?.pay_period_start === prevStart && r?.pay_period_end === prevEnd
    );
    // If previous period has records and ALL are admin-finalized, stay on current period
    if (prevRecords.length > 0 && prevRecords.every((r) => isPayrollAdminFinalized(r))) {
      return; // Previous period is fully finalized — stay on current period
    }

    triedPreviousPeriodRef.current = true;
    setSelectedPeriodIndex(previousIdx);
  }, [payrollRecords, hasInitialized, selectedPeriodIndex, payrollData, currentPeriod, allPeriods]);

  // Reset the flag when period is manually changed
  useEffect(() => {
    triedPreviousPeriodRef.current = false;
  }, [selectedYear]);

  // Listen for real-time Payroll WebSocket updates and merge into local state immediately
  useEffect(() => {
    const handlePayrollUpdated = (event) => {
      const { type, id, data, payrollRecords: freshRecords, fullReplacement } = event.detail || {};

      if (fullReplacement && Array.isArray(freshRecords)) {
        // Full replacement from offline DB flush — update both payrollData and filtered records
        setPayrollData((prev) => {
          if (!prev) return prev;
          const next = { ...prev, payrollRecords: freshRecords };
          fullYearPayrollDataRef.current = next;
          return next;
        });
        setPayrollRecords((prev) => {
          // Re-filter using the current period
          if (!currentPeriod) return freshRecords;
          const periodStart = toLocalYMD(currentPeriod.start);
          const periodEnd = toLocalYMD(currentPeriod.end);
          return freshRecords.filter((r) => r.pay_period_start === periodStart && r.pay_period_end === periodEnd);
        });
        return;
      }

      if ((type === 'create' || type === 'update') && data?.id) {
        // Merge single record update
        setPayrollData((prev) => {
          if (!prev) return prev;
          const existing = prev.payrollRecords || [];
          const idx = existing.findIndex((r) => r.id === data.id);
          const updated = idx >= 0
            ? existing.map((r) => r.id === data.id ? { ...r, ...data } : r)
            : [...existing, data];
          const next = { ...prev, payrollRecords: updated };
          fullYearPayrollDataRef.current = next;
          return next;
        });
        setPayrollRecords((prev) => {
          const idx = prev.findIndex((r) => r.id === data.id);
          if (idx >= 0) return prev.map((r) => r.id === data.id ? { ...r, ...data } : r);
          // Only add if it matches the current period
          if (currentPeriod) {
            const periodStart = toLocalYMD(currentPeriod.start);
            const periodEnd = toLocalYMD(currentPeriod.end);
            if (data.pay_period_start === periodStart && data.pay_period_end === periodEnd) {
              return [...prev, data];
            }
          }
          return prev;
        });
      }
    };

    window.addEventListener('payrollUpdated', handlePayrollUpdated);
    window.addEventListener('payrollRecordsUpdated', handlePayrollUpdated);
    return () => {
      window.removeEventListener('payrollUpdated', handlePayrollUpdated);
      window.removeEventListener('payrollRecordsUpdated', handlePayrollUpdated);
    };
  }, [currentPeriod]);

  // Share now produces the full payroll PDF (complete data document) instead
  // of a screen snapshot — snapshots could not reliably capture the whole
  // scrollable page on mobile.
  const handleSharePayroll = useCallback(() => {
    summaryCardRef.current?.exportPdf();
  }, []);

  // Conditional rendering without early return to maintain hook order
  if (!isPayrollPageActive) return null;

  const eTransDialog = (
    <SettingsDialog
      open={showETransEmailDialog}
      onOpenChange={(o) => !o && setShowETransEmailDialog(false)}
      title="Account"
      description="Update your display name and phone number."
      icon={User}>
      <ProfilePanel currentUser={currentUser} onClose={() => setShowETransEmailDialog(false)} />
    </SettingsDialog>
  );

  if (!currentUser) return <>{eTransDialog}<div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}><span className="text-lg text-slate-600 dark:text-slate-400">Please log in to view payroll</span></div></>;
  if (needsCitySelection) return <><div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}><span className="text-lg text-slate-600 dark:text-slate-400">Select a city to view payroll.</span></div>{eTransDialog}</>;
  const showBlockingSpinner = (isLoadingPayroll && !blockingGraceExpired) || payPeriod === null || selectedPeriodIndex === null;
  if (showBlockingSpinner) return <><div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}><div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div><span className="ml-3 text-lg text-slate-600 dark:text-slate-400">Loading payroll data...</span></div>{eTransDialog}</>;

  return <div className="px-3 py-2 h-full w-full max-w-full overflow-y-auto overflow-x-hidden flex flex-col md:p-4" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl w-full mx-auto flex flex-col min-h-full min-w-0" ref={contentRef}>
        {isLoadingPayroll && blockingGraceExpired && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-slate-800 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            <span className="animate-spin inline-block w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full"></span>
            First-time sync of this year's payroll data — this can take up to a minute. The page loads instantly on every visit after this.
          </div>
        )}
        {/* Header */}
        <div className="bg-[var(--bg-slate-50)]/95 pt-1 pb-1 sticky top-0 z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg-slate-50)]/75 w-full min-w-0 overflow-x-hidden">
          {/* Row 1 (Mobile) / Left section (Desktop) */}
          <div className="flex items-center gap-3 justify-between w-full lg:w-auto">
            <div className="flex items-center gap-2 min-w-0 flex-1 lg:flex-initial lg:gap-3">
              <DollarSign className="w-6 h-6 lg:w-8 lg:h-8 text-emerald-600 flex-shrink-0" />
              <h1 className="text-lg lg:text-2xl font-bold truncate lg:min-w-[200px] text-body">Driver Payroll</h1>

            </div>
            
            {/* Mobile/Tablet Portrait: City filter + Refresh and Share buttons next to title */}
            <div className="flex lg:hidden items-center gap-1 flex-shrink-0">
              {/* City Filter (mobile) — sits next to the header title */}
              <Select value={selectedCityId} onValueChange={(v) => {
              if (!v || v === 'all') return;
              React.startTransition(() => {
                setSelectedCityId(v);
              });
            }} disabled={isDriver || !sortedCities.length}>
                <SelectTrigger className="w-[78px] text-xs px-2 text-body bg-surface" style={{ borderColor: 'var(--border-slate-300)' }}>
                  <SelectValue placeholder="City" />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface">
                  {sortedCities.map((city) =>
                <SelectItem key={city.id} value={city.id} className="text-body">
                      {city.name}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>
              <div className="relative flex items-center">
                {isPayrollSyncing && (
                  <span className="absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap bg-emerald-600 text-white text-xs font-medium px-2 py-1 rounded-md shadow-lg z-30 animate-pulse">
                    Syncing Payroll
                    <span className="absolute left-full top-1/2 -translate-y-1/2 border-4 border-transparent border-l-emerald-600" />
                  </span>
                )}
                <Button
 onClick={handleManualRefresh}
 disabled={isRefreshing || isPayrollSyncing || isLoadingPayroll}
 size="sm"
 variant="ghost"
 className="p-2 h-auto border border-slate-900 dark:border-white text-body"
 title="Refresh payroll data"
 >
              
                <RefreshCw className={`w-5 h-5 ${isPayrollSyncing ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              {loadedFromOffline && !isLoadingPayroll && (
                <span className="text-xs text-slate-400 dark:text-slate-500 italic whitespace-nowrap" title="Showing your last saved payroll data — live sync running in the background">
                  saved data • syncing…
                </span>
              )}
              <Button
 onClick={handleSharePayroll}
 disabled={isCapturingScreenshot}
 size="sm"
 variant="ghost"
 className="p-2 h-auto border border-slate-900 dark:border-white text-body"
 title="Capture and share screenshot"
 >
              
                {isCapturingScreenshot ?
              <Loader2 className="w-5 h-5 animate-spin" /> :

              <Share2 className="w-5 h-5" />
              }
              </Button>
            </div>
          </div>
          
          {/* Row 2 (Mobile centered) / Middle section (Desktop) */}
          <div className="flex flex-row items-center gap-2 justify-center w-full">
            {/* City, Year, Driver Dropdowns */}
            <div className="flex items-center gap-2">
              {/* City Filter — desktop only now; mobile version moved next to header title above */}
              <div className="hidden lg:block">
              <Select value={selectedCityId} onValueChange={(v) => {
              if (!v || v === 'all') return;
              React.startTransition(() => {
                setSelectedCityId(v);
              });
            }} disabled={isDriver || !sortedCities.length}>
                <SelectTrigger ref={citySelectTriggerRef} className="w-[105px] md:w-[130px] text-body bg-surface" style={{ borderColor: 'var(--border-slate-300)' }}>
                  <SelectValue placeholder="City" />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface">
                  {sortedCities.map((city) =>
                <SelectItem key={city.id} value={city.id} className="text-body">
                      {city.name}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>
              </div>

              {/* Year Filter */}
              <Select value={String(selectedYear)} onValueChange={(v) => {
              React.startTransition(() => {
                setSelectedYear(Number(v));
              });
            }}>
                <SelectTrigger className="w-[105px] md:w-[130px] text-body bg-surface" style={{ borderColor: 'var(--border-slate-300)' }}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface">
                  {years.map((year) =>
                <SelectItem key={year} value={String(year)} className="text-body">
                      {year}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>

              {/* Driver Filter - filtered by pay cycle type */}
              <Select value={selectedDriverId} onValueChange={(v) => {
              isManualChangeRef.current = true;

              // Only change the driver filter — keep the current pay cycle selection.
              // The pay cycle is a global filter that should persist across driver changes.
              React.startTransition(() => {
                setSelectedDriverId(v);
              });

              setTimeout(() => {isManualChangeRef.current = false;}, 200);
            }} disabled={isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px] text-body bg-surface" style={{ borderColor: 'var(--border-slate-300)' }}>
                  <SelectValue placeholder="Driver" />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface">
                  <SelectItem value="all" className="text-body">All Drivers ({driversInPayCycle.length})</SelectItem>
                  {driversInPayCycle.map((driver) =>
                <SelectItem key={driver.user_id} value={driver.user_id} className="text-body">
                      {getDriverDisplayName(driver)}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>

              {/* Pay Cycle Selector - 4th position dropdown */}
              <Select value={payPeriod || 'monthly'} onValueChange={handlePayPeriodChange} disabled={isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px] text-body bg-surface" style={{ borderColor: 'var(--border-slate-300)' }}>
                  <SelectValue placeholder="Cycle" />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface">
                  {payCycleInfo.cycles.map((cycle) =>
                <SelectItem key={cycle} value={cycle} className="text-body">
                      {cycle.charAt(0).toUpperCase() + cycle.slice(1)}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>
              </div>

            {/* Icon Buttons - Far Right (Desktop only) */}
            <div id="payroll-controls" className="hidden lg:flex items-center gap-1 ml-auto">
              <div className="relative flex items-center">
                {isPayrollSyncing && (
                  <span className="absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap bg-emerald-600 text-white text-xs font-medium px-2 py-1 rounded-md shadow-lg z-30 animate-pulse">
                    Syncing Payroll
                    <span className="absolute left-full top-1/2 -translate-y-1/2 border-4 border-transparent border-l-emerald-600" />
                  </span>
                )}
                <Button
 onClick={handleManualRefresh}
 disabled={isRefreshing || isPayrollSyncing || isLoadingPayroll}
 size="sm"
 variant="ghost"
 className="p-2 h-auto text-body"
 title="Refresh payroll data"
 >
              
                <RefreshCw className={`w-5 h-5 ${isPayrollSyncing ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              <Button
 onClick={handleSharePayroll}
 disabled={isCapturingScreenshot}
 size="sm"
 variant="ghost"
 className="p-2 h-auto text-body"
 title="Capture and share screenshot"
 >
              
                {isCapturingScreenshot ?
              <Loader2 className="w-5 h-5 animate-spin" /> :

              <Share2 className="w-5 h-5" />
              }
              </Button>
            </div>
          </div>
        </div>

        <MobilePayrollSummary
        periodLabel={periodLabel}
        totalNetPay={totalNetPay}
        totalDeliveries={totalDeliveries}
        onPrev={goToPrevPeriod}
        onNext={goToNextPeriod} />
      

        {/* Content Area for Screenshot */}
        <div ref={payrollScrollRef} className="pb- min-h-0 flex-1 overflow-y-auto overflow-x-hidden md:pb-1 overscroll-contain">
          {/* Grid (mobile collapsible) */}
          <div className="lg:hidden mb-3">
            <Button size="sm" variant="outline" className="bg-background px-2 text-xs font-medium rounded-md inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border border-input shadow-sm hover:bg-accent hover:text-accent-foreground h-8 w-full" onClick={() => setDetailsOpen(!detailsOpen)}>
              {detailsOpen ? 'Hide Details' : 'View Details'}
            </Button>
          </div>
          <div className={detailsOpen ? '' : 'hidden lg:block'}>
            <DriverPayrollGrid
            deliveries={cityFilteredDeliveries}
            stores={filteredStores}
            patients={payrollData?.patients || []}
            appUsers={payrollData?.appUsers || []}
            selectedYear={selectedYear}
            selectedDriverId={selectedDriverId}
            payPeriod={payPeriod}
            onPayPeriodChange={handlePayPeriodChange}
            currentPeriod={currentPeriod}
            allPeriods={allPeriods}
            selectedPeriodIndex={selectedPeriodIndex}
            onPrevPeriod={goToPrevPeriod}
            onNextPeriod={goToNextPeriod}
            driverStats={payrollData?.driverStats || {}}
            storeStats={payrollData?.storeStats || {}}
            onRefreshPayrollData={handlePayrollDataRefresh} />
          
          </div>

          {/* Payroll Summary */}
          <div ref={summaryRef}>
          <PayrollSummaryCard
            deliveries={allCityDeliveries}
            drivers={sortedDrivers}
            appUsers={payrollData?.appUsers || []}
            patients={payrollData?.patients || []}
            cities={sortedCities}
            stores={filteredStores}
            selectedYear={selectedYear}
            selectedDriverId={selectedDriverId}
            selectedCityId={selectedCityId}
            payPeriod={payPeriod}
            currentPeriod={currentPeriod}
            onFinalizePayroll={(data) => {
              console.log('Payroll finalized:', data);
            }}
            onPayrollRecordsChange={(records) => {
              setPayrollRecords(records);
              setPayrollData((prev) => {
                if (!prev) return prev;
                const incomingById = new Map((records || []).map((record) => [record.id, record]));
                const mergedPayrollRecords = (prev.payrollRecords || []).map((record) => incomingById.get(record.id) || record);
                (records || []).forEach((record) => {
                  if (!mergedPayrollRecords.some((existing) => existing.id === record.id)) {
                    mergedPayrollRecords.push(record);
                  }
                });
                const next = { ...prev, payrollRecords: mergedPayrollRecords };
                if (fullYearPayrollDataRef.current) {
                  fullYearPayrollDataRef.current = next;
                }
                return next;
              });
            }}
            ref={summaryCardRef}
            onExportingChange={setIsSharingPdf}
            payrollRecords={payrollRecords}
            allPayrollRecords={payrollData?.payrollRecords || []}
            refreshPayrollRecords={refreshPayrollRecords}
            forceFinalizedSyncToken={forceFinalizedSyncToken}
            storeStats={payrollData?.storeStats || {}} />
          
          </div>
        </div>
        
        <MobileBottomActions
        onSummary={() => summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        onShare={handleSharePayroll}
        onRefresh={handleManualRefresh}
        refreshing={isRefreshing || isPayrollSyncing || isLoadingPayroll}
        capturing={isSharingPdf || isCapturingScreenshot} />
      

        {/* Screenshot Share Modal */}
        <ScreenshotShareModal
        isOpen={showScreenshotModal}
        onClose={() => setShowScreenshotModal(false)}
        imageDataUrl={screenshotDataUrl}
        filename={screenshotFilename} />

        {eTransDialog}
      
      </div>
    </div>;
}