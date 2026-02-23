import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DollarSign, ChevronLeft, ChevronRight, Share2, Loader2, Download, RefreshCw } from "lucide-react";
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

// Helper: Get first Monday of a given year
const getFirstMondayOfYear = (year) => {
  const jan1 = new Date(year, 0, 1);
  const dayOfWeek = jan1.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (dayOfWeek === 1 ? 0 : 8 - dayOfWeek);
  return new Date(year, 0, 1 + daysUntilMonday);
};

// Helper: Calculate all pay periods for a given year and pay period type
const calculateAllPeriods = (year, payPeriodType) => {
  const periods = [];
  
  switch (payPeriodType) {
    case 'weekly': {
      const firstMonday = getFirstMondayOfYear(year);
      // Add prior year period if Jan 1 is before first Monday
      const jan1 = new Date(year, 0, 1);
      if (jan1 < firstMonday) {
        periods.push({
          year,
          start: jan1,
          end: new Date(firstMonday.getTime() - 86400000), // day before first Monday
          label: `Prior Year Period`,
          isPriorYear: true
        });
      }
      // Generate weekly periods
      let weekStart = new Date(firstMonday);
      let weekNum = 1;
      const yearEnd = new Date(year, 11, 31);
      while (weekStart <= yearEnd) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        periods.push({
          year,
          start: new Date(weekStart),
          end: weekEnd > yearEnd ? yearEnd : weekEnd,
          label: `Week ${weekNum}`,
          weekNum
        });
        weekNum++;
        weekStart.setDate(weekStart.getDate() + 7);
      }
      break;
    }
    case 'biweekly': {
      const firstMonday = getFirstMondayOfYear(year);
      const jan1 = new Date(year, 0, 1);
      if (jan1 < firstMonday) {
        periods.push({
          year,
          start: jan1,
          end: new Date(firstMonday.getTime() - 86400000),
          label: `Prior Year Period`,
          isPriorYear: true
        });
      }
      let biweekStart = new Date(firstMonday);
      let periodNum = 1;
      const yearEnd = new Date(year, 11, 31);
      while (biweekStart <= yearEnd) {
        const biweekEnd = new Date(biweekStart);
        biweekEnd.setDate(biweekStart.getDate() + 13);
        periods.push({
          year,
          start: new Date(biweekStart),
          end: biweekEnd > yearEnd ? yearEnd : biweekEnd,
          label: `Period ${periodNum}`,
          periodNum
        });
        periodNum++;
        biweekStart.setDate(biweekStart.getDate() + 14);
      }
      break;
    }
    case 'semimonthly': {
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
    default: {
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
const findCurrentPeriodIndex = (periods, today) => {
  // Use ISO string comparison (YYYY-MM-DD) to avoid timezone issues
  const todayStr = today.toISOString().split('T')[0];
  
  console.log(`🔍 [findCurrentPeriodIndex] Today: ${todayStr}, Periods:`, periods.map((p, i) => 
    `${i}: ${p.start.toISOString().split('T')[0]}-${p.end.toISOString().split('T')[0]} (${p.label})`
  ).join(' | '));
  
  for (let i = 0; i < periods.length; i++) {
    const startStr = periods[i].start.toISOString().split('T')[0];
    const endStr = periods[i].end.toISOString().split('T')[0];
    const isInRange = todayStr >= startStr && todayStr <= endStr;
    console.log(`  Period ${i} (${periods[i].label}): ${startStr} <= ${todayStr} <= ${endStr}? ${isInRange}`);
    
    if (isInRange) {
      console.log(`✅ Found current period: index ${i} (${periods[i].label})`);
      return i;
    }
  }
  
  // If not found, return closest past period
  console.log(`⚠️ No exact match found, returning closest past period`);
  for (let i = periods.length - 1; i >= 0; i--) {
    const endStr = periods[i].end.toISOString().split('T')[0];
    if (todayStr > endStr) {
      console.log(`✅ Returning closest past: index ${i} (${periods[i].label})`);
      return i;
    }
  }
  return 0;
};

export default function DriverPayroll() {
  // CRITICAL: ALL hooks must be at the top, before any conditional logic
  const { currentUser } = useUser();
  const { smartRefreshActivity, setSmartRefreshActivity } = useAppData();
  
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());
  const [selectedCityId, setSelectedCityId] = useState('all');
  const [selectedDriverId, setSelectedDriverId] = useState('all');
  const [payPeriod, setPayPeriod] = useState('monthly');
  const [selectedPeriodIndex, setSelectedPeriodIndex] = useState(0);
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

  // Define isDriver early (after refs, before useMemo/useCallback that might use it)
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin');

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  const allPeriods = useMemo(() => {
    return calculateAllPeriods(selectedYear, payPeriod);
  }, [selectedYear, payPeriod]);

  const currentPeriod = useMemo(() => allPeriods[selectedPeriodIndex] || allPeriods[0], [allPeriods, selectedPeriodIndex]);

  const sortedCities = useMemo(() => {
    if (!payrollData?.cities) return [];
    return [...payrollData.cities].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
  }, [payrollData?.cities]);

  const filteredStores = useMemo(() => {
    if (!payrollData?.stores) return [];
    let filtered = payrollData.stores.filter(s => s.status !== 'inactive');
    if (selectedCityId && selectedCityId !== 'all') {
      filtered = filtered.filter(s => s.city_id === selectedCityId);
    }
    return sortStores(filtered);
  }, [payrollData?.stores, selectedCityId]);

  const sortedDrivers = useMemo(() => {
    if (!payrollData?.drivers) return [];
    return sortUsers(payrollData.drivers.filter(d => d && d.status === 'active'));
  }, [payrollData?.drivers]);

  const availablePayCycles = useMemo(() => {
    if (!payrollData?.appUsers) return [];
    const cycles = new Set();
    payrollData.appUsers.forEach(au => {
      if (au.pay_cycle_type && au.status === 'active') {
        cycles.add(au.pay_cycle_type);
      }
    });
    const order = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
    return order.filter(c => cycles.has(c));
  }, [payrollData?.appUsers]);

  const driversInPayCycle = useMemo(() => {
    if (!payrollData?.appUsers || !payrollData?.drivers) {
      console.log('⚠️ [driversInPayCycle] Missing appUsers or drivers', {
        appUsers: payrollData?.appUsers?.length || 0,
        drivers: payrollData?.drivers?.length || 0
      });
      return [];
    }
    
    // CRITICAL: Ensure deliveries is always an array
    const deliveries = Array.isArray(payrollData?.deliveries) ? payrollData.deliveries : [];

    // CRITICAL: Show all active drivers (ignore pay cycle requirement for dropdown)
    // This ensures drivers are visible even if they don't have deliveries for this cycle
    const driverIdsToShow = new Set();

    payrollData.appUsers.forEach(au => {
      if (au.status === 'active') {
        driverIdsToShow.add(au.user_id);
      }
    });

    // CRITICAL: Always include the currently selected driver to prevent dropdown mismatch during transitions
    if (selectedDriverId !== 'all') {
      driverIdsToShow.add(selectedDriverId);
    }

    const result = sortUsers(
      payrollData.drivers.filter(d => {
        if (!d || d.status !== 'active') return false;
        const driverId = d.user_id || d.id;
        return driverIdsToShow.has(driverId);
      })
    );
    
    console.log(`📋 [driversInPayCycle] Showing ${result.length} active drivers for pay period: ${payPeriod}`);
    return result;
  }, [payrollData?.appUsers, payrollData?.drivers, payPeriod, selectedDriverId]);

  // Calculate available pay cycles and their counts for the selected city/year
  const payCycleInfo = useMemo(() => {
        if (!payrollData?.appUsers) return { cycles: ['weekly', 'biweekly', 'semimonthly', 'monthly'], mostCommon: 'monthly', disabled: false };

        // Filter appUsers to drivers only
        let filteredAppUsers = payrollData.appUsers.filter(au => 
          au.status === 'active' && au.app_roles && au.app_roles.includes('driver')
        );

    // If no drivers found, allow all cycle types
    if (filteredAppUsers.length === 0) {
      console.log(`📊 [payCycleInfo] No active drivers found, allowing all cycles`);
      return { cycles: ['weekly', 'biweekly', 'semimonthly', 'monthly'], mostCommon: 'monthly', disabled: false, cycleCounts: {} };
    }

    // Count drivers by pay cycle type
    const cycleCounts = {};
    filteredAppUsers.forEach(au => {
      if (au.pay_cycle_type) {
        cycleCounts[au.pay_cycle_type] = (cycleCounts[au.pay_cycle_type] || 0) + 1;
      }
    });

    const cycles = Object.keys(cycleCounts);
    const order = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
    const sortedCycles = order.filter(c => cycles.includes(c));

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
    if (selectedCityId !== 'all') {
      const cityStoreIds = new Set(filteredStores.map(s => s.id));
      filtered = filtered.filter(d => d && cityStoreIds.has(d.store_id));
    }
    
    // CRITICAL: Filter by selected pay period date range
    // All year data is loaded; the grid/summary need only the current period's deliveries
    if (currentPeriod) {
      const periodStart = currentPeriod.start.toISOString().split('T')[0];
      const periodEnd = currentPeriod.end.toISOString().split('T')[0];
      filtered = filtered.filter(d => d && d.delivery_date >= periodStart && d.delivery_date <= periodEnd);
    }
    
    return filtered;
  }, [payrollData?.deliveries, selectedCityId, filteredStores, currentPeriod]);

  const handlePayPeriodChange = useCallback((newPayPeriod) => {
    isManualChangeRef.current = true;
    
    // Batch all state updates together in a single synchronous block
    React.startTransition(() => {
      setPayPeriod(newPayPeriod);
      
      // Reset selected driver to 'all' to force refresh with new pay cycle filter
      if (selectedDriverId !== 'all') {
        setSelectedDriverId('all');
      }
      
      setPayrollData(prev => {
        if (selectedDriverId && selectedDriverId !== 'all' && prev?.appUsers) {
          const driverAppUser = prev.appUsers.find(au => au.user_id === selectedDriverId);
          if (driverAppUser) {
            base44.entities.AppUser.update(driverAppUser.id, {
              pay_cycle_type: newPayPeriod
            }).catch(error => console.error('Failed to save pay cycle type:', error));
            return {
              ...prev,
              appUsers: prev.appUsers.map(au => au.id === driverAppUser.id ? { ...au, pay_cycle_type: newPayPeriod } : au)
            };
          }
        }
        return prev;
      });
    });
    
    setTimeout(() => { isManualChangeRef.current = false; }, 200);
  }, [selectedDriverId]);

  const refreshPayrollRecords = useCallback(async () => {
    if (!currentPeriod) return;
    
    // CRITICAL: Just filter existing year data - no API calls
    // All year data is already loaded in fetchPayroll from getAdminMetricsAndPayrollData
    const periodStart = currentPeriod.start.toISOString().split('T')[0];
    const periodEnd = currentPeriod.end.toISOString().split('T')[0];
    
    const filtered = payrollData?.payrollRecords?.filter(r => 
      r.pay_period_start === periodStart && r.pay_period_end === periodEnd
    ) || [];
    
    console.log(`📊 [DriverPayroll] Filtered payroll records: ${filtered.length} for period ${currentPeriod.label}`);
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
      selectTriggers.forEach(el => {
        el.style.display = 'none';
      });

      // Hide any buttons within the content
      const buttons = contentRef.current.querySelectorAll('button');
      buttons.forEach(el => {
        el.style.display = 'none';
      });

      // Hide App Fee % rows
      const appFeeRows = document.querySelectorAll('[data-app-fee-row="true"]');
      appFeeRows.forEach(row => {
        row.style.display = 'none';
      });

      // Small delay to ensure UI updates
      await new Promise(resolve => setTimeout(resolve, 100));

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

      selectTriggers.forEach(el => {
        el.style.display = '';
      });

      buttons.forEach(el => {
        el.style.display = '';
      });

      // Show App Fee % rows again
      appFeeRows.forEach(row => {
        row.style.display = '';
      });

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

  const fullYearPayrollDataRef = useRef(null);

  const fetchPayroll = useCallback(async (isAutoRefresh = false, forceFresh = false) => {
    if (!currentUser) return;
    if (!isAutoRefresh) setIsLoadingPayroll(true);

    if (isAutoRefresh && setSmartRefreshActivity) {
      setSmartRefreshActivity({ active: true, updatedEntities: ['Payroll', 'Delivery'] });
    }

    try {
      // Use cached full-year data unless forced fresh
      if (fullYearPayrollDataRef.current && !forceFresh) {
        console.log(`📊 [DriverPayroll] Using cached full-year data`);
        setPayrollData(fullYearPayrollDataRef.current);
        return;
      }

      console.log(`📥 [DriverPayroll] Fetching FULL YEAR payroll data - Year: ${selectedYear}`);
      const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
        payrollYear: selectedYear,
        payrollCityId: null, // Backend returns all cities; frontend filters
        payrollDriverId: null,
        payrollStartDate: `${selectedYear}-01-01`,
        payrollEndDate: `${selectedYear}-12-31`
      });
      const data = response?.data?.payrollData || response?.payrollData;

      // Cache full-year data
      fullYearPayrollDataRef.current = data;

      console.log(`✅ [DriverPayroll] Loaded:`, {
        deliveries: data?.deliveries?.length || 0,
        drivers: data?.drivers?.length || 0,
        payrollRecords: data?.payrollRecords?.length || 0
      });

      setPayrollData(data);

      if (data?.payrollRecords?.length > 0) {
        setPayrollRecords(data.payrollRecords);
      }
    } catch (error) {
      console.error('Failed to fetch payroll data:', error);
      toast.error('Failed to refresh payroll data');
    } finally {
      if (!isAutoRefresh) setIsLoadingPayroll(false);
      if (isAutoRefresh && setSmartRefreshActivity) {
        setSmartRefreshActivity({ active: false, updatedEntities: [] });
      }
    }
  }, [selectedYear, currentUser, setSmartRefreshActivity]);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    console.log('🔄 [DriverPayroll] Manual refresh triggered');
    await fetchPayroll(false, true);
    await refreshPayrollRecords();
    setIsRefreshing(false);
    toast.success('Payroll data refreshed');
  }, [fetchPayroll, refreshPayrollRecords]);

  // Navigation handlers - must be useCallback
  const goToPrevPeriod = useCallback(() => {
    if (selectedPeriodIndex > 0) {
      isManualChangeRef.current = false; // Allow manual navigation
      setSelectedPeriodIndex(selectedPeriodIndex - 1);
    }
  }, [selectedPeriodIndex]);

  const goToNextPeriod = useCallback(() => {
    if (selectedPeriodIndex < allPeriods.length - 1) {
      isManualChangeRef.current = false; // Allow manual navigation
      setSelectedPeriodIndex(selectedPeriodIndex + 1);
    }
  }, [selectedPeriodIndex, allPeriods.length]);

  // Trigger fetch when filters change (after initialization)
  useEffect(() => {
    if (hasInitialized) {
      fetchPayroll(false, false);
    }
  }, [selectedYear, selectedCityId, hasInitialized, fetchPayroll]);

  // Initialize defaults based on user role - runs ONCE on mount
  useEffect(() => {
    if (!currentUser || hasInitialized) return;

    if (currentUser.city_id && !isDriver) {
      setSelectedCityId(currentUser.city_id);
    }

    if (isDriver) {
      setSelectedDriverId(currentUser.id);
      setPayPeriod('monthly');
    } else {
      setSelectedDriverId('all');
      setPayPeriod('semimonthly');
    }
    setHasInitialized(true);
    
    // Immediately fetch payroll data after initialization
    fetchPayroll(false, false);
  }, [currentUser, isDriver, hasInitialized, fetchPayroll]);



  // Load driver's pay cycle ONCE when data first loads
  useEffect(() => {
    if (!payrollData?.appUsers || hasLoadedInitialDataRef.current || isManualChangeRef.current) return;
    
    // For drivers viewing their own payroll, select their pay cycle
    if (isDriver && selectedDriverId !== 'all') {
      const driverAppUser = payrollData.appUsers.find(au => au.user_id === selectedDriverId);
      if (driverAppUser?.pay_cycle_type) {
        setPayPeriod(driverAppUser.pay_cycle_type);
      }
    }
    // For admins, select the most common pay cycle type among available drivers
    else if (!isDriver && selectedDriverId === 'all' && payCycleInfo.mostCommon) {
      setPayPeriod(payCycleInfo.mostCommon);
    }
    
    hasLoadedInitialDataRef.current = true;
  }, [payrollData?.appUsers, selectedDriverId, isDriver, payCycleInfo.mostCommon]);

  // Reset period index when pay period or year changes - ONLY on initial load
  const initialPeriodSetRef = useRef(false);
  
  useEffect(() => {
    // CRITICAL: Wait for all data to be loaded BEFORE setting initial period
    if (!hasInitialized || !payrollData || allPeriods.length === 0) {
      return;
    }
    
    // CRITICAL: Only auto-select on INITIAL load or when year/pay period changes
    if (initialPeriodSetRef.current && !isManualChangeRef.current) {
      return;
    }

    const today = new Date();
    
    // PRIORITY 1: Find earliest PAST/CURRENT cycle with incomplete finalization (any driver missing driver_finalized_at OR admin_finalized_at)
    console.log(`🔍 [DriverPayroll] Looking for earliest incomplete cycle - Total periods: ${allPeriods.length}, Payroll records: ${payrollRecords.length}`);
    
    // First find today's period index to limit search to past/current periods only
    let todayPeriodIdx = -1;
    for (let i = 0; i < allPeriods.length; i++) {
      if (today >= allPeriods[i].start && today <= allPeriods[i].end) {
        todayPeriodIdx = i;
        break;
      }
    }
    
    let earliestIncompleteCycleIdx = -1;
    const searchLimit = todayPeriodIdx !== -1 ? todayPeriodIdx : allPeriods.length - 1;
    
    // Search from earliest to current period only (don't check future periods)
    for (let i = 0; i <= searchLimit; i++) {
      const period = allPeriods[i];
      const startStr = period.start.toISOString().split('T')[0];
      const endStr = period.end.toISOString().split('T')[0];
      
      const recordsForPeriod = payrollRecords.filter(r => 
        r.pay_period_start === startStr && r.pay_period_end === endStr
      );
      
      if (recordsForPeriod.length === 0) continue;
      
      // Check if ANY record has missing driver_finalized_at OR admin_finalized_at
      const hasIncompleteRecord = recordsForPeriod.some(r => 
        !r.driver_finalized_at || !r.admin_finalized_at
      );
      
      console.log(`🔍 [Period ${i}] ${period.label} (${startStr} to ${endStr}):`, {
        totalRecords: recordsForPeriod.length,
        hasIncomplete: hasIncompleteRecord,
        details: recordsForPeriod.map(r => ({
          driver: r.driver_id?.slice(-4),
          driver_finalized_at: r.driver_finalized_at ? '✓' : '✗ MISSING',
          admin_finalized_at: r.admin_finalized_at ? '✓' : '✗ MISSING',
          status: r.status
        }))
      });
      
      if (hasIncompleteRecord) {
        earliestIncompleteCycleIdx = i;
        console.log(`✅ [DriverPayroll] Found earliest incomplete cycle: ${period.label} (index ${i})`);
        break;
      }
    }
    
    // Select earliest incomplete cycle, or today's period as fallback
    const selectedIdx = earliestIncompleteCycleIdx !== -1 ? earliestIncompleteCycleIdx : (todayPeriodIdx !== -1 ? todayPeriodIdx : 0);
    console.log(`🔍 [DriverPayroll] Today's cycle: ${todayPeriodIdx !== -1 ? allPeriods[todayPeriodIdx].label : 'Not found'} (index ${todayPeriodIdx})`);
    
    console.log(`✅ [DriverPayroll] Initial period selected: ${allPeriods[selectedIdx].label} (index ${selectedIdx}) - ${earliestIncompleteCycleIdx !== -1 ? 'Earliest incomplete cycle' : 'Today\'s period'}`);
    setSelectedPeriodIndex(selectedIdx);
    
    // Mark that initial period has been set
    initialPeriodSetRef.current = true;
  }, [payPeriod, selectedYear, allPeriods, hasInitialized, payrollRecords, payrollData]);

  // Subscribe to real-time websocket updates
  useEffect(() => {
    if (!hasInitialized) return;

    const unsubscribers = [];

    // Subscribe to Payroll changes only - refetch entire year on change
    try {
      const unsubPayroll = base44.entities.Payroll.subscribe((event) => {
        console.log(`📡 [DriverPayroll] Payroll ${event.type}:`, event.id);
        // Force fresh fetch on payroll changes to get latest records
        fetchPayroll(true, true);
      });
      unsubscribers.push(unsubPayroll);
    } catch (e) {
      console.warn('Failed to subscribe to Payroll updates:', e);
    }

    // Cleanup subscriptions on unmount
    return () => {
      unsubscribers.forEach(unsub => {
        try {
          unsub();
        } catch (e) {
          console.warn('Failed to unsubscribe:', e);
        }
      });
    };
  }, [hasInitialized, fetchPayroll]);

  // Filter payroll records when period changes (don't re-fetch since all year data is loaded)
  // CRITICAL: Uses refs to avoid redundant updates
  const lastFilteredPeriodRef = useRef(null);
  
  useEffect(() => {
    if (!currentPeriod || !hasInitialized || !payrollRecords.length) return;
    
    // CRITICAL: Skip if we've already filtered for this exact period
    const periodKey = `${currentPeriod.start}-${currentPeriod.end}`;
    if (lastFilteredPeriodRef.current === periodKey) return;
    
    lastFilteredPeriodRef.current = periodKey;
    console.log(`🔄 [DriverPayroll] Filtering records for period: ${currentPeriod.label}`);

    // CRITICAL: Just filter, don't invalidate or re-fetch
    refreshPayrollRecords();
  }, [currentPeriod?.label, hasInitialized, payrollRecords.length]);

  // Auto-select previous period if current has no data
  useEffect(() => {
    if (!hasInitialized || payrollRecords.length > 0) return;
    if (selectedPeriodIndex === 0) return; // Can't go back further
    if (triedPreviousPeriodRef.current) return; // Already tried going back
    
    console.log(`⚠️ [DriverPayroll] No payroll data for current period, switching to previous...`);
    triedPreviousPeriodRef.current = true;
    setSelectedPeriodIndex(selectedPeriodIndex - 1);
  }, [payrollRecords, hasInitialized, selectedPeriodIndex]);

  // Reset the flag when period is manually changed
  useEffect(() => {
    triedPreviousPeriodRef.current = false;
  }, [selectedYear, payPeriod]);

  // Conditional rendering without early return to maintain hook order
  return !currentUser ? (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
      <span className="text-lg text-slate-600">Please log in to view payroll</span>
    </div>
  ) : isLoadingPayroll ? (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
      <span className="ml-3 text-lg text-slate-600">Loading payroll data...</span>
    </div>
  ) : (
    <div className="p-4 md:p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto" ref={contentRef}>
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
          {/* Row 1 (Mobile) / Left section (Desktop) */}
          <div className="flex items-center gap-3 justify-between w-full lg:w-auto">
            <div className="flex items-center gap-3">
              <DollarSign className="w-8 h-8 text-emerald-600" />
              <h1 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Driver Payroll</h1>
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
                style={{ color: 'var(--text-slate-900)' }}
              >
                <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                onClick={handleCaptureScreenshot}
                disabled={isCapturingScreenshot}
                size="sm"
                variant="ghost"
                className="p-2 h-auto border border-slate-900 dark:border-white"
                title="Capture and share screenshot"
                style={{ color: 'var(--text-slate-900)' }}
              >
                {isCapturingScreenshot ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Share2 className="w-5 h-5" />
                )}
              </Button>
            </div>
          </div>
          
          {/* Row 2 (Mobile centered) / Middle section (Desktop) */}
          <div className="flex flex-row items-center gap-2 justify-center w-full lg:w-auto">
            {/* City, Year, Driver Dropdowns */}
            <div className="flex items-center gap-2">
              {/* City Filter */}
              <Select value={selectedCityId} onValueChange={(v) => {
                React.startTransition(() => {
                  setSelectedCityId(v);
                });
              }} disabled={isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="City" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Cities</SelectItem>
                  {sortedCities.map(city => (
                    <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>
                      {city.name}
                    </SelectItem>
                  ))}
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
                  {years.map(year => (
                    <SelectItem key={year} value={String(year)} style={{ color: 'var(--text-slate-900)' }}>
                      {year}
                    </SelectItem>
                  ))}
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
                    const driverAppUser = payrollData?.appUsers?.find(au => au.user_id === v);
                    if (driverAppUser?.pay_cycle_type) {
                      setPayPeriod(driverAppUser.pay_cycle_type);
                    }
                  }
                });

                setTimeout(() => { isManualChangeRef.current = false; }, 200); 
              }} disabled={isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="Driver" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers ({driversInPayCycle.length})</SelectItem>
                  {driversInPayCycle.map(driver => (
                    <SelectItem key={driver.user_id} value={driver.user_id} style={{ color: 'var(--text-slate-900)' }}>
                      {getDriverDisplayName(driver)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Pay Cycle Selector - 4th position dropdown */}
              <Select value={payPeriod} onValueChange={handlePayPeriodChange} disabled={payCycleInfo.disabled || isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="Cycle" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  {payCycleInfo.cycles.map(cycle => (
                    <SelectItem key={cycle} value={cycle} style={{ color: 'var(--text-slate-900)' }}>
                      {cycle.charAt(0).toUpperCase() + cycle.slice(1)}
                    </SelectItem>
                  ))}
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
                style={{ color: 'var(--text-slate-900)' }}
              >
                <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                onClick={handleCaptureScreenshot}
                disabled={isCapturingScreenshot}
                size="sm"
                variant="ghost"
                className="p-2 h-auto"
                title="Capture and share screenshot"
                style={{ color: 'var(--text-slate-900)' }}
              >
                {isCapturingScreenshot ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Share2 className="w-5 h-5" />
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Content Area for Screenshot */}
        <div>
          {/* Grid */}
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
          />

          {/* Payroll Summary */}
          <PayrollSummaryCard
            deliveries={cityFilteredDeliveries}
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
            }}
            payrollRecords={payrollRecords}
            refreshPayrollRecords={refreshPayrollRecords}
          />
        </div>
        
        {/* Screenshot Share Modal */}
        <ScreenshotShareModal
          isOpen={showScreenshotModal}
          onClose={() => setShowScreenshotModal(false)}
          imageDataUrl={screenshotDataUrl}
          filename={`driver-payroll-${selectedYear}.png`}
        />
      </div>
    </div>
  );
}