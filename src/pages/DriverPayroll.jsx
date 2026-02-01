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
import PayrollSummaryCard from '../components/payroll/PayrollSummaryCard';
import { smartRefreshManager } from '../components/utils/smartRefreshManager';
import { invalidate } from '../components/utils/dataManager';
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
  for (let i = 0; i < periods.length; i++) {
    if (today >= periods[i].start && today <= periods[i].end) {
      return i;
    }
  }
  // If not found, return closest past period
  for (let i = periods.length - 1; i >= 0; i--) {
    if (today > periods[i].end) return i;
  }
  return 0;
};

export default function DriverPayroll() {
   const { currentUser } = useUser();
   const { smartRefreshActivity, setSmartRefreshActivity } = useAppData();
   const [payrollData, setPayrollData] = useState(null);
   const [isLoadingPayroll, setIsLoadingPayroll] = useState(true);
   const [payrollRecords, setPayrollRecords] = useState([]);
   const [isRefreshing, setIsRefreshing] = useState(false);
   const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
   const [screenshotDataUrl, setScreenshotDataUrl] = useState(null);
   const [showScreenshotModal, setShowScreenshotModal] = useState(false);
   const contentRef = useRef(null);
  
  const currentDate = new Date();
  const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear());
  const [selectedCityId, setSelectedCityId] = useState('all');
  const [selectedDriverId, setSelectedDriverId] = useState('all');
  const [payPeriod, setPayPeriod] = useState('monthly');
  const [selectedPeriodIndex, setSelectedPeriodIndex] = useState(0);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Determine if current user is a driver (not admin)
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin');

  // CRITICAL: Declare ALL hooks BEFORE any early returns
  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  const allPeriods = useMemo(() => {
    return calculateAllPeriods(selectedYear, payPeriod);
  }, [selectedYear, payPeriod]);

  const currentPeriod = allPeriods[selectedPeriodIndex] || allPeriods[0];

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
    if (!payrollData?.appUsers || !payrollData?.drivers) return [];
    const driverIdsInCycle = new Set(
      payrollData.appUsers
        .filter(au => au.pay_cycle_type === payPeriod && au.status === 'active')
        .map(au => au.user_id)
    );
    return sortUsers(
      payrollData.drivers.filter(d => {
        if (!d || d.status !== 'active') return false;
        const driverId = d.user_id || d.id;
        return driverIdsInCycle.has(driverId);
      })
    );
  }, [payrollData?.appUsers, payrollData?.drivers, payPeriod]);

  const cityFilteredDeliveries = useMemo(() => {
    if (!payrollData?.deliveries) return [];
    let filtered = payrollData.deliveries;
    if (selectedCityId !== 'all') {
      const cityStoreIds = new Set(filteredStores.map(s => s.id));
      filtered = filtered.filter(d => d && cityStoreIds.has(d.store_id));
    }
    return filtered;
  }, [payrollData?.deliveries, selectedCityId, filteredStores]);

  // Save pay cycle type to driver's AppUser when changed
  const handlePayPeriodChange = useCallback(async (newPayPeriod) => {
    setPayPeriod(newPayPeriod);

    // Use functional update to access latest payrollData without adding to dependencies
    setPayrollData(prev => {
      if (selectedDriverId && selectedDriverId !== 'all' && prev?.appUsers) {
        const driverAppUser = prev.appUsers.find(au => au.user_id === selectedDriverId);
        if (driverAppUser) {
          // Update in background
          base44.entities.AppUser.update(driverAppUser.id, {
            pay_cycle_type: newPayPeriod
          }).catch(error => console.error('Failed to save pay cycle type:', error));

          // Update local state
          return {
            ...prev,
            appUsers: prev.appUsers.map(au => au.id === driverAppUser.id ? { ...au, pay_cycle_type: newPayPeriod } : au)
          };
        }
      }
      return prev;
    });
  }, [selectedDriverId]);

  const handleCaptureScreenshot = async () => {
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
  };

  // Manual refresh handler
  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    console.log('🔄 [DriverPayroll] Manual refresh triggered');
    
    // Invalidate caches
    invalidate('Delivery');
    invalidate('Patient');
    invalidate('Payroll');
    
    // Force fresh fetch
    await fetchPayroll(false, true);
    
    setIsRefreshing(false);
    toast.success('Payroll data refreshed');
  };

  // Fetch payroll data - only refetch when year or city changes, NOT when driver changes
  const fetchPayroll = useCallback(async (isAutoRefresh = false, forceFresh = false) => {
    if (!currentUser) return;
    if (!isAutoRefresh) setIsLoadingPayroll(true);

    // Show refresh spinner during fetch
    if (isAutoRefresh && setSmartRefreshActivity) {
      setSmartRefreshActivity({ active: true, updatedEntities: ['Payroll', 'Delivery'] });
    }

    try {
      // CRITICAL: Invalidate caches before fetching to ensure fresh data
      if (forceFresh) {
        console.log('🔄 [DriverPayroll] Invalidating caches before fetch');
        invalidate('Delivery');
        invalidate('Patient');
        invalidate('Payroll');
      }

      console.log(`📥 [DriverPayroll] Fetching payroll data - Year: ${selectedYear}, City: ${selectedCityId}, Force: ${forceFresh}`);
      const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
        payrollYear: selectedYear,
        payrollCityId: selectedCityId === 'all' ? null : selectedCityId,
        payrollDriverId: null // Always fetch all drivers, filter locally
      });
      const data = response?.data?.payrollData || response?.payrollData;
      console.log(`✅ [DriverPayroll] Received payroll data:`, {
        deliveries: data?.deliveries?.length || 0,
        drivers: data?.drivers?.length || 0,
        stores: data?.stores?.length || 0,
        appUsers: data?.appUsers?.length || 0,
        patients: data?.patients?.length || 0
      });
      setPayrollData(data);
    } catch (error) {
      console.error('Failed to fetch payroll data:', error);
      toast.error('Failed to refresh payroll data');
    } finally {
      if (!isAutoRefresh) setIsLoadingPayroll(false);
      // Hide refresh spinner after fetch
      if (isAutoRefresh && setSmartRefreshActivity) {
        setSmartRefreshActivity({ active: false, updatedEntities: [] });
      }
    }
  }, [selectedYear, selectedCityId, currentUser, setSmartRefreshActivity]);

  useEffect(() => {
    if (hasInitialized) {
      fetchPayroll(false, false);
    }
  }, [selectedYear, selectedCityId, hasInitialized, fetchPayroll]);

  // Initialize defaults based on user role - runs ONCE on mount
  useEffect(() => {
    if (!currentUser || hasInitialized) return;

    // Set city to user's assigned city if available
    if (currentUser.city_id && !isDriver) {
      setSelectedCityId(currentUser.city_id);
    }

    if (isDriver) {
      // Drivers default to viewing their own payroll
      setSelectedDriverId(currentUser.id);
      setPayPeriod('monthly'); // Default, will be overwritten when payrollData loads
    } else {
      // Admins default to Semi-Monthly view with All Drivers
      setSelectedDriverId('all');
      setPayPeriod('semimonthly');
    }
    setHasInitialized(true);
  }, [currentUser, isDriver, hasInitialized]);

  // Update pay period when payrollData loads (for drivers)
  useEffect(() => {
    if (!hasInitialized || !payrollData?.appUsers || selectedDriverId === 'all') return;
    
    const driverAppUser = payrollData.appUsers.find(au => au.user_id === selectedDriverId);
    if (driverAppUser?.pay_cycle_type) {
      setPayPeriod(driverAppUser.pay_cycle_type);
    }
  }, [payrollData?.appUsers, selectedDriverId, hasInitialized]);

  // Auto-select pay cycle type when driver selection changes
  // Only run when driver actually changes (not when payrollData updates)
  const prevDriverIdRef = React.useRef(selectedDriverId);
  useEffect(() => {
    if (!hasInitialized) return;
    // Only update pay period if driver actually changed
    if (prevDriverIdRef.current === selectedDriverId) return;
    prevDriverIdRef.current = selectedDriverId;

    if (selectedDriverId === 'all') {
      // Default to semi-monthly when "All Drivers" is selected
      setPayPeriod('semimonthly');
    } else {
      // Load the selected driver's pay cycle type
      const driverAppUser = payrollData?.appUsers?.find(au => au.user_id === selectedDriverId);
      if (driverAppUser?.pay_cycle_type) {
        setPayPeriod(driverAppUser.pay_cycle_type);
      }
      // Don't change pay period if driver doesn't have one set - keep current
    }
  }, [selectedDriverId, payrollData?.appUsers, hasInitialized]);

  // Auto-select current period when pay period type or year changes
  // Track previous values to only reset when necessary
  const prevPayPeriodRef = React.useRef(payPeriod);
  const prevYearRef = React.useRef(selectedYear);
  useEffect(() => {
    // Only reset period index if payPeriod or year actually changed
    if (prevPayPeriodRef.current === payPeriod && prevYearRef.current === selectedYear) return;
    prevPayPeriodRef.current = payPeriod;
    prevYearRef.current = selectedYear;

    const today = new Date();
    if (selectedYear === today.getFullYear()) {
      const idx = findCurrentPeriodIndex(allPeriods, today);
      setSelectedPeriodIndex(idx);
    } else {
      // If viewing past year, default to last period
      setSelectedPeriodIndex(allPeriods.length - 1);
    }
  }, [payPeriod, selectedYear, allPeriods]);

  // Navigation handlers
  const goToPrevPeriod = () => {
    if (selectedPeriodIndex > 0) {
      setSelectedPeriodIndex(selectedPeriodIndex - 1);
    }
  };

  const goToNextPeriod = () => {
    if (selectedPeriodIndex < allPeriods.length - 1) {
      setSelectedPeriodIndex(selectedPeriodIndex + 1);
    }
  };

  // Function to refresh payroll records (called after finalization)
  const refreshPayrollRecords = useCallback(async () => {
    if (!currentPeriod) return;
    const periodStartStr = currentPeriod.start.toISOString().split('T')[0];
    const periodEndStr = currentPeriod.end.toISOString().split('T')[0];
    console.log(`📥 [DriverPayroll] Fetching payroll records for ${periodStartStr} to ${periodEndStr}`);
    try {
      const records = await base44.entities.Payroll.filter({
        pay_period_start: periodStartStr,
        pay_period_end: periodEndStr
      });
      console.log(`✅ [DriverPayroll] Found ${records?.length || 0} payroll records`);
      setPayrollRecords(records || []);
    } catch (error) {
      console.error('Failed to refresh payroll records:', error);
    }
  }, [currentPeriod]);

  // Load payroll records when period changes (initial load and period navigation)
  useEffect(() => {
    if (!currentPeriod || !hasInitialized) return;
    console.log(`🔄 [DriverPayroll] Period changed, loading payroll records...`);
    refreshPayrollRecords();
  }, [currentPeriod, hasInitialized, refreshPayrollRecords]);

  // Subscribe to Payroll entity changes for real-time updates
  useEffect(() => {
    if (!currentPeriod) return;

    const unsubscribe = base44.entities.Payroll.subscribe((event) => {
      console.log(`🔔 [DriverPayroll] Payroll entity ${event.type}:`, event.id);
      // Refresh records when any payroll record is created or updated
      if (event.type === 'create' || event.type === 'update') {
        refreshPayrollRecords();
      }
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [currentPeriod, refreshPayrollRecords]);

  // Smart refresh for payroll data - auto-refresh every 60 seconds to get latest deductions, bonuses, app fee %
  useEffect(() => {
    if (!currentPeriod || !hasInitialized || !currentUser) return;

    const refreshPayrollData = async () => {
      console.log('🔄 [DriverPayroll] Auto-refresh cycle starting');

      // Notify UI that refresh is active
      if (setSmartRefreshActivity) {
        setSmartRefreshActivity({ active: true, updatedEntities: ['Payroll', 'Delivery'] });
      }

      try {
        // CRITICAL: Invalidate caches before auto-refresh to get latest data
        invalidate('Delivery');
        invalidate('Patient');
        invalidate('Payroll');

        // Fetch fresh payroll data including updated deductions, bonuses, and app fees
        const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
          payrollYear: selectedYear,
          payrollCityId: selectedCityId === 'all' ? null : selectedCityId,
          payrollDriverId: null
        });

        const freshData = response?.data?.payrollData || response?.payrollData;
        if (freshData) {
          setPayrollData(freshData);
          console.log('✅ [DriverPayroll] Payroll data refreshed');
        }

        // Also refresh payroll records for the current period
        const periodStartStr = currentPeriod.start.toISOString().split('T')[0];
        const periodEndStr = currentPeriod.end.toISOString().split('T')[0];
        const records = await base44.entities.Payroll.filter({
          pay_period_start: periodStartStr,
          pay_period_end: periodEndStr
        });
        setPayrollRecords(records || []);
      } catch (error) {
        console.error('Failed during auto-refresh:', error);
      } finally {
        // Notify UI that refresh is complete
        if (setSmartRefreshActivity) {
          setSmartRefreshActivity({ active: false, updatedEntities: [] });
        }
      }
    };

    const refreshInterval = setInterval(refreshPayrollData, 60000); // 60 seconds

    return () => clearInterval(refreshInterval);
  }, [currentPeriod, hasInitialized, currentUser, selectedYear, selectedCityId, setSmartRefreshActivity]);

  // Listen for delivery/patient imports and refresh data immediately
  useEffect(() => {
    const handleImportComplete = async () => {
      console.log('📥 [DriverPayroll] Import detected - invalidating caches and refreshing');
      
      // CRITICAL: Invalidate ALL relevant caches before fetching
      invalidate('Delivery');
      invalidate('Patient');
      invalidate('Payroll');
      
      // Force fresh fetch of payroll data
      await fetchPayroll(true, true);
      
      // Also refresh payroll records if period is available
      if (currentPeriod) {
        const periodStartStr = currentPeriod.start.toISOString().split('T')[0];
        const periodEndStr = currentPeriod.end.toISOString().split('T')[0];
        const records = await base44.entities.Payroll.filter({
          pay_period_start: periodStartStr,
          pay_period_end: periodEndStr
        });
        setPayrollRecords(records || []);
      }
      
      toast.success('Payroll data updated');
    };

    window.addEventListener('deliveriesImported', handleImportComplete);
    window.addEventListener('patientsUpdated', handleImportComplete);

    return () => {
      window.removeEventListener('deliveriesImported', handleImportComplete);
      window.removeEventListener('patientsUpdated', handleImportComplete);
    };
  }, [fetchPayroll, currentPeriod]);

  // Guard clause AFTER all hooks have been declared
  if (isLoadingPayroll) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
        <span className="ml-3 text-lg text-slate-600">Loading payroll data...</span>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto" ref={contentRef}>
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <DollarSign className="w-8 h-8 text-emerald-600" />
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Driver Payroll</h1>
          </div>
          
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div id="payroll-controls" className="flex items-center gap-2">
              <Button
                 onClick={handleManualRefresh}
                 disabled={isRefreshing || isLoadingPayroll}
                 size="sm"
                 variant="outline"
                 className="gap-2"
                 style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
               >
                 <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                 <span className="hidden sm:inline">{isRefreshing ? 'Refreshing...' : 'Refresh'}</span>
               </Button>
               <Button
                 onClick={handleCaptureScreenshot}
                 disabled={isCapturingScreenshot}
                 size="sm"
                 variant="outline"
                 className="gap-2"
                 style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
               >
                 {isCapturingScreenshot ? (
                   <Loader2 className="w-4 h-4 animate-spin" />
                 ) : (
                   <Share2 className="w-4 h-4" />
                 )}
                 <span className="hidden sm:inline">{isCapturingScreenshot ? 'Capturing...' : 'Share'}</span>
               </Button>
            </div>
            {/* City Filter */}
            <Select value={selectedCityId} onValueChange={setSelectedCityId} disabled={isDriver}>
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
            <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
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
             <Select value={selectedDriverId} onValueChange={setSelectedDriverId} disabled={isDriver}>
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