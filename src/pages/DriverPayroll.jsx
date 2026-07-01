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
              label: `Week ${weekNum}`,
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
              label: `Period ${periodNum}`,
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
  const [isLoadingPayroll, setIsLoadingPayroll] = useState(true);
  const [payrollRecords, setPayrollRecords] = useState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState(null);
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);

  const contentRef = useRef(null);
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
    base44.entities.AppUser.filter({ user_id: currentUser.id }).then((appUsers) => {
      const appUser = appUsers?.[0];
      if (!appUser) return;
      const isDriverRole = Array.isArray(appUser.app_roles) &&
        appUser.app_roles.includes('driver') &&
        !appUser.app_roles.includes('admin');
      if (isDriverRole && !appUser.ETrans_Email) {
        setShowETransEmailDialog(true);
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

  // All deliveries for the selected city (no period filter) for App Fee monthly pool
  const allCityDeliveries = useMemo(() => {
    const deliveries = Array.isArray(payrollData?.deliveries) ? payrollData.deliveries : [];
    const cityStoreIds = new Set(filteredStores.map((s) => s.id));
    return deliveries.filter((d) => d && cityStoreIds.has(d.store_id));
  }, [payrollData?.deliveries, filteredStores]);

  const sortedDrivers = useMemo(() => {
    if (!payrollData?.drivers || !payrollData?.appUsers) return [];

    const appUsersByDriverId = new Map();
    payrollData.appUsers.forEach((au) => {
      if (au?.user_id) appUsersByDriverId.set(au.user_id, au);
    });

    // Only include drivers who have deliveries in the current pay period
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

    return sortUsers(
      payrollData.drivers.
      filter((d) => {
        if (!d) return false;
        const driverId = d.user_id || d.id;
        const au = appUsersByDriverId.get(driverId);
        if (au?.pay_cycle_type !== payPeriod) return false;
        return driversWithDeliveriesInPeriod.has(driverId);
      }).
      map((d) => ({ ...d, ...(appUsersByDriverId.get(d.user_id || d.id) || {}) }))
    );
  }, [payrollData?.drivers, payrollData?.appUsers, payrollData?.deliveries, payPeriod, currentPeriod]);

  const availablePayCycles = useMemo(() => {
    if (!payrollData?.appUsers) return [];
    const cycles = new Set();
    payrollData.appUsers.forEach((au) => {
      if (au.pay_cycle_type) {
        cycles.add(au.pay_cycle_type);
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

    const result = sortUsers(
      payrollData.drivers.
      filter((d) => {
        if (!d) return false;
        const driverId = d.user_id || d.id;
        const au = appUsersByDriverId.get(driverId);
        if (au?.pay_cycle_type !== payPeriod) return false;
        return driversWithDeliveriesInPeriod.has(driverId);
      }).
      map((d) => ({ ...d, ...(appUsersByDriverId.get(d.user_id || d.id) || {}) }))
    );

    return result;
  }, [payrollData?.appUsers, payrollData?.drivers, payrollData?.deliveries, payPeriod, currentPeriod, selectedDriverId]);

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

    // Count drivers by pay cycle type
    const cycleCounts = {};
    filteredAppUsers.forEach((au) => {
      if (au.pay_cycle_type) {
        cycleCounts[au.pay_cycle_type] = (cycleCounts[au.pay_cycle_type] || 0) + 1;
      }
    });

    const cycles = Object.keys(cycleCounts);
    const order = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
    const sortedCycles = order.filter((c) => cycles.includes(c));

    // Find most common cycle
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

    // Filter by pay cycle (include inactive drivers)
    if (payrollData?.appUsers && payPeriod) {
      const matchingDriverIds = new Set();
      payrollData.appUsers.forEach((au) => {
        if (au.pay_cycle_type === payPeriod) {
          matchingDriverIds.add(au.user_id);
        }
      });
      filtered = filtered.filter((d) => d && matchingDriverIds.has(d.driver_id));
    }

    return filtered;
  }, [payrollData?.deliveries, payrollData?.appUsers, selectedCityId, filteredStores, currentPeriod, payPeriod]);

  const filteredPayrollRecords = useMemo(() => {
    if (!currentPeriod || !Array.isArray(payrollRecords)) return [];

    const periodStart = toLocalYMD(currentPeriod.start);
    const periodEnd = toLocalYMD(currentPeriod.end);
    const payCycleDriverIds = new Set(driversInPayCycle.map((driver) => driver.user_id || driver.id));

    return payrollRecords.filter((record) => {
      const matchesPeriod = record.pay_period_start === periodStart && record.pay_period_end === periodEnd;
      const matchesDriver = selectedDriverId === 'all' ?
      payCycleDriverIds.has(record.driver_id) :
      record.driver_id === selectedDriverId;
      const matchesCity = !selectedCityId || selectedCityId === 'all' || record.city_id === selectedCityId;
      const matchesPayPeriod = !payPeriod || record.pay_period_type === payPeriod;
      return matchesPeriod && matchesDriver && matchesCity && matchesPayPeriod;
    });
  }, [payrollRecords, currentPeriod, driversInPayCycle, selectedDriverId, selectedCityId, payPeriod]);

  const totalNetPay = useMemo(() => filteredPayrollRecords.reduce((sum, r) => sum + (Number(r.net_pay) || 0), 0), [filteredPayrollRecords]);
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

      setPayrollData((prev) => {
        if (selectedDriverId && selectedDriverId !== 'all' && prev?.appUsers) {
          const driverAppUser = prev.appUsers.find((au) => au.user_id === selectedDriverId);
          if (driverAppUser) {
            base44.entities.AppUser.update(driverAppUser.id, {
              pay_cycle_type: newPayPeriod
            }).catch((error) => console.error('Failed to save pay cycle type:', error));
            return {
              ...prev,
              appUsers: prev.appUsers.map((au) => au.id === driverAppUser.id ? { ...au, pay_cycle_type: newPayPeriod } : au)
            };
          }
        }
        return prev;
      });
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

    try {
      if (!contentRef.current) {
        toast.error('Content not found');
        return;
      }

      // Store original theme class
      const htmlElement = document.documentElement;
      const originalThemeClass = htmlElement.className;

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

      // Restore original state on error
      const htmlElement = document.documentElement;
      htmlElement.className = htmlElement.className.replace('light-theme', '').trim();
      const controlsElement = document.getElementById('payroll-controls');
      if (controlsElement) {
        controlsElement.style.display = 'flex';
      }
    } finally {
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

  const fetchPayroll = useCallback(async (isAutoRefresh = false, forceFresh = false) => {
    if (!currentUser || !isPayrollPageActive || !selectedCityId) return;

    const cacheKey = `${selectedYear}-${selectedCityId}`;
    const fetchSignature = `${cacheKey}-${isAutoRefresh}-${forceFresh}`;
    const now = Date.now();
    if (lastFetchSignatureRef.current === fetchSignature && now - lastFetchTimestampRef.current < 5000) {
      return fullYearPayrollDataRef.current;
    }

    if (!forceFresh && fullYearPayrollDataRef.current?.__cacheKey === cacheKey) {
      return fullYearPayrollDataRef.current;
    }

    if (fetchPayrollInFlightRef.current) {
      return fetchPayrollInFlightRef.current;
    }

    const runFetch = async () => {
      if (!isAutoRefresh) setIsLoadingPayroll(true);
      try {
        console.log(`📥 [DriverPayroll] Fetching FULL YEAR payroll data - Year: ${selectedYear}`);
        const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
          payrollYear: selectedYear,
          payrollCityId: selectedCityId,
          payrollPaginationMode: 'full_year'
        });
        const rawData = response?.data?.payrollData || response?.payrollData;
        const data = rawData ? { ...rawData, __cacheKey: cacheKey } : rawData;

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
        return data;
      } catch (error) {
        console.error('Failed to fetch payroll data:', error);
        toast.error(error?.response?.data?.error || error?.message || 'Failed to refresh payroll data');
        throw error;
      } finally {
        fetchPayrollInFlightRef.current = null;
        if (!isAutoRefresh) setIsLoadingPayroll(false);
      }
    };

    fetchPayrollInFlightRef.current = runFetch();
    return fetchPayrollInFlightRef.current;
  }, [selectedYear, selectedCityId, currentUser, isPayrollPageActive]);

  const handleManualRefresh = useCallback(async () => {
    if (!selectedCityId) return;
    setIsRefreshing(true);
    console.log('🔄 [DriverPayroll] Manual refresh triggered');
    try {
      await fetchPayroll(false, true);
      if (refreshPayrollRecords) {
        await refreshPayrollRecords();
      }
      toast.success('Payroll data refreshed');
    } catch (error) {
      console.error('❌ [DriverPayroll] Refresh failed:', error);
      toast.error(error?.response?.data?.error || error?.message || 'Failed to refresh payroll data');
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchPayroll, refreshPayrollRecords, selectedCityId]);

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
  useEffect(() => {
    if (hasInitialized && isPayrollPageActive && selectedCityId) {
      fetchPayroll(false, false).catch(() => {});
    }
  }, [hasInitialized, isPayrollPageActive, selectedCityId, selectedYear, fetchPayroll]);

  // Initialize defaults based on user role - runs ONCE on mount
  // CRITICAL: Reads offline Payroll records to determine the correct pay cycle + period BEFORE rendering data
  useEffect(() => {
    if (!currentUser || hasInitialized || !isPayrollPageActive) return;

    const initFromOfflineData = async () => {
      const defaultCityId = currentUser?.city_id || '';
      setSelectedCityId(defaultCityId && defaultCityId !== 'all' ? defaultCityId : '');

      if (isDriver) {
        setSelectedDriverId(currentUser.id);
      } else {
        setSelectedDriverId('all');
      }

      // Step 1: Read AppUsers from offline DB to determine pay cycle
      let determinedPayCycle = 'monthly'; // fallback
      try {
        const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
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
        const offlinePayrolls = (await offlineDB.getAll('payroll_records')) || [];
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



  // Refine pay cycle when live data loads (if different from offline-based initial choice)
  useEffect(() => {
    if (!payrollData?.appUsers || hasLoadedInitialDataRef.current || isManualChangeRef.current) return;

    let liveCycle = null;
    if (isDriver && selectedDriverId !== 'all') {
      const driverAppUser = payrollData.appUsers.find((au) => au.user_id === selectedDriverId);
      if (driverAppUser?.pay_cycle_type) liveCycle = driverAppUser.pay_cycle_type;
    } else if (!isDriver && selectedDriverId === 'all' && payCycleInfo.mostCommon) {
      liveCycle = payCycleInfo.mostCommon;
    }

    // Only update if live data disagrees with offline-based selection
    if (liveCycle && liveCycle !== payPeriod) {
      setPayPeriod(liveCycle);
      // Reset period selection so it recalculates for new cycle
      periodSelectionDoneWithRecordsRef.current = false;
    }

    hasLoadedInitialDataRef.current = true;
  }, [payrollData?.appUsers, selectedDriverId, isDriver, payCycleInfo.mostCommon, payPeriod]);

  // Re-select period when live payroll records arrive (may override offline-based initial selection)
  const periodSelectionDoneWithRecordsRef = useRef(false);

  // Keep the selected period stable after initialization; dedicated effects handle choosing the correct period.

  useEffect(() => {
    if (!hasInitialized || !payrollData || allPeriods.length === 0) return;

    // Skip auto-selection during manual navigation
    if (isManualChangeRef.current) return;

    // Use full-year records if available to evaluate previous period; fallback to current state
    const allRecords = payrollData?.payrollRecords || payrollRecords || [];
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

  // Auto-select previous period if current has no data
  useEffect(() => {
    if (!hasInitialized || payrollRecords.length > 0) return;
    if (isManualChangeRef.current) return;
    if (selectedPeriodIndex === 0) return; // Can't go back further
    if (triedPreviousPeriodRef.current) return; // Already tried going back

    triedPreviousPeriodRef.current = true;
    setSelectedPeriodIndex(selectedPeriodIndex - 1);
  }, [payrollRecords, hasInitialized, selectedPeriodIndex]);

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

  if (!currentUser) return <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}><span className="text-lg text-slate-600">Please log in to view payroll</span></div>;
  if (needsCitySelection) return <><div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}><span className="text-lg text-slate-600">Select a city to view payroll.</span></div>{eTransDialog}</>;
  if (isLoadingPayroll || payPeriod === null || selectedPeriodIndex === null) return <><div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}><div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div><span className="ml-3 text-lg text-slate-600">Loading payroll data...</span></div>{eTransDialog}</>;

  return

  <div className="px-3 py-2 h-full w-full max-w-full overflow-y-auto overflow-x-hidden flex flex-col md:p-4" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl w-full mx-auto flex flex-col min-h-full min-w-0" ref={contentRef}>
        {/* Header */}
        <div className="bg-[var(--bg-slate-50)]/95 pt-1 pb-1 sticky top-0 z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg-slate-50)]/75 w-full min-w-0 overflow-x-hidden">
          {/* Row 1 (Mobile) / Left section (Desktop) */}
          <div className="flex items-center gap-3 justify-between w-full lg:w-auto">
            <div className="flex items-center gap-3">
              <DollarSign className="w-8 h-8 text-emerald-600" />
              <h1 className="text-2xl font-bold min-w-[200px]" style={{ color: 'var(--text-slate-900)' }}>Driver Payroll</h1>

            </div>
            
            {/* Mobile/Tablet Portrait: Show Refresh and Share buttons next to title */}
            <div className="flex lg:hidden items-center gap-1">
              <Button
              onClick={handleManualRefresh}
              disabled={isRefreshing || isLoadingPayroll}
              size="sm"
              variant="ghost"
              className="p-2 h-auto border border-slate-900 dark:border-white"
              title="Refresh payroll data"
              style={{ color: 'var(--text-slate-900)' }}>
              
                <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Button
              onClick={handleCaptureScreenshot}
              disabled={isCapturingScreenshot}
              size="sm"
              variant="ghost"
              className="p-2 h-auto border border-slate-900 dark:border-white"
              title="Capture and share screenshot"
              style={{ color: 'var(--text-slate-900)' }}>
              
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
              {/* City Filter */}
              <Select value={selectedCityId} onValueChange={(v) => {
              if (!v || v === 'all') return;
              React.startTransition(() => {
                setSelectedCityId(v);
              });
            }} disabled={isDriver || !sortedCities.length}>
                <SelectTrigger ref={citySelectTriggerRef} className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="City" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  {sortedCities.map((city) =>
                <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>
                      {city.name}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>

              {/* Year Filter */}
              <Select value={String(selectedYear)} onValueChange={(v) => {
              React.startTransition(() => {
                setSelectedYear(Number(v));
              });
            }}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  {years.map((year) =>
                <SelectItem key={year} value={String(year)} style={{ color: 'var(--text-slate-900)' }}>
                      {year}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>

              {/* Driver Filter - filtered by pay cycle type */}
              <Select value={selectedDriverId} onValueChange={(v) => {
              isManualChangeRef.current = true;

              // Batch all state updates in a single transition
              React.startTransition(() => {
                setSelectedDriverId(v);
                if (v === 'all') {
                  // For admins viewing all drivers, select most common pay cycle
                  if (payCycleInfo.mostCommon) {
                    setPayPeriod(payCycleInfo.mostCommon);
                  }
                } else {
                  // For individual driver selection, use their pay cycle
                  const driverAppUser = payrollData?.appUsers?.find((au) => au.user_id === v);
                  if (driverAppUser?.pay_cycle_type) {
                    setPayPeriod(driverAppUser.pay_cycle_type);
                  }
                }
              });

              setTimeout(() => {isManualChangeRef.current = false;}, 200);
            }} disabled={isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="Driver" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers ({driversInPayCycle.length})</SelectItem>
                  {driversInPayCycle.map((driver) =>
                <SelectItem key={driver.user_id} value={driver.user_id} style={{ color: 'var(--text-slate-900)' }}>
                      {getDriverDisplayName(driver)}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>

              {/* Pay Cycle Selector - 4th position dropdown */}
              <Select value={payPeriod || 'monthly'} onValueChange={handlePayPeriodChange} disabled={isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="Cycle" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  {payCycleInfo.cycles.map((cycle) =>
                <SelectItem key={cycle} value={cycle} style={{ color: 'var(--text-slate-900)' }}>
                      {cycle.charAt(0).toUpperCase() + cycle.slice(1)}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>
              </div>

            {/* Icon Buttons - Far Right (Desktop only) */}
            <div id="payroll-controls" className="hidden lg:flex items-center gap-1 ml-auto">
              <Button
              onClick={handleManualRefresh}
              disabled={isRefreshing || isLoadingPayroll}
              size="sm"
              variant="ghost"
              className="p-2 h-auto"
              title="Refresh payroll data"
              style={{ color: 'var(--text-slate-900)' }}>
              
                <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Button
              onClick={handleCaptureScreenshot}
              disabled={isCapturingScreenshot}
              size="sm"
              variant="ghost"
              className="p-2 h-auto"
              title="Capture and share screenshot"
              style={{ color: 'var(--text-slate-900)' }}>
              
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
        <div className="pb- min-h-0 flex-1 overflow-y-auto overflow-x-hidden md:pb-1 overscroll-contain">
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
            storeStats={payrollData?.storeStats || {}} />
          
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
            payrollRecords={payrollRecords}
            refreshPayrollRecords={refreshPayrollRecords}
            storeStats={payrollData?.storeStats || {}} />
          
          </div>
        </div>
        
        <MobileBottomActions
        onSummary={() => summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        onShare={handleCaptureScreenshot}
        onRefresh={handleManualRefresh}
        refreshing={isRefreshing || isLoadingPayroll}
        capturing={isCapturingScreenshot} />
      

        {/* Screenshot Share Modal */}
        <ScreenshotShareModal
        isOpen={showScreenshotModal}
        onClose={() => setShowScreenshotModal(false)}
        imageDataUrl={screenshotDataUrl}
        filename={`driver-payroll-${selectedYear}.png`} />

        {eTransDialog}
      
      </div>
    </div>;

}