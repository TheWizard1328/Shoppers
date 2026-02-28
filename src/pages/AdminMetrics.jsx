import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart3, DollarSign, Store, Package, RefreshCw, TrendingUp, Users, Truck, Share2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { getEffectiveUser } from '@/components/utils/auth';
import { isAppOwner, userHasRole } from '../components/utils/userRoles';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import MonthlyStoreMetricsGrid from '../components/admin/MonthlyStoreMetricsGrid';
import DayByDayStoreMetricsGrid from '../components/admin/DayByDayStoreMetricsGrid';

const MONTH_NAMES = [
'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];


const COLORS = {
  billable: '#10b981', // Green
  nonBillable: '#f97316' // Orange
};

export default function AdminMetrics() {
  const [currentUser, setCurrentUser] = useState(null);
  const [hasAccess, setHasAccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false); // For year changes (doesn't hide content)
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [selectedMonth, setSelectedMonth] = useState(null); // null = all year, 1-12 = specific month
  const [selectedStoreMonth, setSelectedStoreMonth] = useState(null); // { month, storeId, storeAbbr } for day-by-day breakdown
  const [metricsViewMode, setMetricsViewMode] = useState('deliveries'); // 'deliveries' or 'fees'
  const [showEnvelopeAdjustedTotals, setShowEnvelopeAdjustedTotals] = useState(false);
  const [selectedCityId, setSelectedCityId] = useState(null); // Will be set to user's city
  const [cities, setCities] = useState([]);
  const [metricsData, setMetricsData] = useState(null);
  
  // Unified fee totals (supports both admin metrics and store metrics shapes)
  const feeTotals = useMemo(() => {
    const totals = metricsData?.storeFeeTotals || metricsData?.totals || {};
    return totals || {};
  }, [metricsData]);
  const [error, setError] = useState(null);
  const [initialCitySet, setInitialCitySet] = useState(false);
  const [showDayByDay, setShowDayByDay] = useState(false); // Toggle for day-by-day view
  const [selectedDriverId, setSelectedDriverId] = useState('all'); // Filter by driver

  const availableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  // Check access and load cities
  useEffect(() => {
    const checkAccess = async () => {
      try {
        const user = await getEffectiveUser();
        setCurrentUser(user);
        setHasAccess(isAppOwner(user) || userHasRole(user, 'admin'));

        // Load cities for filter
        const citiesData = await base44.entities.City.list();
        const sortedCities = citiesData.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        setCities(sortedCities);

        // Default to user's city_id, or first city if not set
        const defaultCityId = user?.city_id || sortedCities[0]?.id || null;
        if (defaultCityId) {
          setSelectedCityId(defaultCityId);
          setInitialCitySet(true);
        }
      } catch (error) {
        console.error('Access check failed:', error);
        setHasAccess(false);
      }
    };
    checkAccess();
  }, []);

  // Fetch metrics from backend - only when year or city changes or on initial load
  const fetchMetrics = useCallback(async (year, cityId, isInitial = false) => {
    if (!hasAccess) return;

    // Only show full loading screen on initial load
    if (isInitial) {
      setIsLoading(true);
    } else {
      setIsFetching(true);
    }
    setError(null);

    try {
      const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
        adminMetricsYear: parseInt(year),
        adminMetricsCityId: cityId === 'all' ? null : cityId,
        // CRITICAL: Don't fetch payroll data on AdminMetrics page (not needed here)
        payrollYear: null,
        payrollCityId: null,
        payrollDriverId: null
      });
      const data = response?.data?.adminMetrics || response?.adminMetrics;

      if (data?.error) {
        throw new Error(data.error);
      }

      setMetricsData(data);
      setSelectedMonth(null); // Reset month selection when year changes
    } catch (err) {
      console.error('Failed to fetch metrics:', err);
      setError(err.message || 'Failed to load metrics');
    } finally {
      setIsLoading(false);
      setIsFetching(false);
    }
  }, [hasAccess]);

  // Initial load - wait for city to be set
  useEffect(() => {
    if (hasAccess && initialCitySet && selectedCityId) {
      fetchMetrics(selectedYear, selectedCityId, true); // isInitial = true
    }
  }, [hasAccess, initialCitySet, selectedCityId]); // Wait for city selection

  // Listen for delivery updates from smart refresh and refresh metrics
  useEffect(() => {
    const handleDeliveriesUpdated = () => {
      // Only refresh if currently viewing this page and viewing current year
      const currentYear = new Date().getFullYear();
      if (selectedYear === currentYear.toString() && hasAccess && selectedCityId) {
        console.log('📊 [AdminMetrics] Deliveries updated - refreshing metrics');
        fetchMetrics(selectedYear, selectedCityId, false);
      }
    };

    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdated);
    window.addEventListener('deliveriesImported', handleDeliveriesUpdated);
    window.addEventListener('refreshDeliveryStats', handleDeliveriesUpdated);

    return () => {
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
      window.removeEventListener('deliveriesImported', handleDeliveriesUpdated);
      window.removeEventListener('refreshDeliveryStats', handleDeliveriesUpdated);
    };
  }, [selectedYear, hasAccess, selectedCityId, fetchMetrics]);

  // Handle year change without full refresh
  const handleYearChange = (newYear) => {
    setSelectedYear(newYear);
    fetchMetrics(newYear, selectedCityId, false); // isInitial = false - keeps content visible
  };

  // Handle city change
  const handleCityChange = (newCityId) => {
    setSelectedCityId(newCityId);
    fetchMetrics(selectedYear, newCityId, false);
  };

  // Filter data based on selected month, store, and driver (client-side filtering)
  const filteredData = useMemo(() => {
    if (!metricsData) return null;

    // Store + Month selected: show day-by-day breakdown for that store
    if (selectedStoreMonth) {
      // Build day-by-day data for the selected store in selected month
      const dailyData = metricsData.dailyStoreData?.[selectedStoreMonth.month]?.[selectedStoreMonth.storeId] || [];

      // Get app fee rate and calculate fees per day based on billable deliveries
      const appFeeRate = metricsData.storeFeeTotals?.app_fee_rate || 0;

      // Add fees to each day (fees = billable deliveries * rate)
      // Billable = completed + afterHours for stores paying fees
      const dailyDataWithFees = dailyData.map((day) => ({
        ...day,
        fees: ((day.completed || 0) + (day.afterHours || 0)) * appFeeRate
      }));

      return {
        ...metricsData,
        storeData: dailyDataWithFees, // Daily breakdown for the store with fees
        isDailyBreakdown: true
      };
    }

    // Only month selected: filter all graphs by month
    if (selectedMonth) {
      // For fees mode, use monthlyStoreData which has pre-calculated fees per store
      // For deliveries mode, use storeDataByMonth which has completed/failed counts
      const monthStoreData = metricsData.storeDataByMonth?.[selectedMonth] || metricsData.storeData;
      const monthStoreDataWithFees = metricsData.monthlyStoreData?.[selectedMonth] || metricsData.monthlyStoreFees?.[selectedMonth] || [];
      const monthFees = (feeTotals?.monthly_fees?.[selectedMonth - 1] ?? feeTotals?.monthlyFees?.[selectedMonth - 1] ?? 0);

      // Merge fees from monthlyStoreData into storeData
      const mergedStoreData = (monthStoreData || []).map((store) => {
        const feeData = monthStoreDataWithFees.find((s) => (s.abbreviation === store.abbreviation) || (s.storeAbbr === store.abbreviation));
        return {
          ...store,
          fees: (feeData?.fees ?? feeData?.total_fees ?? 0)
        };
      });

      return {
        ...metricsData,
        storeData: mergedStoreData,
        displayedFees: monthFees,
        isDailyBreakdown: false
      };
    }

    // Nothing selected: return all year data with fees merged
    // Aggregate fees across all months per store for full year view
    const allMonthsStoreFees = {};
    for (let m = 1; m <= 12; m++) {
      const monthData = metricsData.monthlyStoreData?.[m] || metricsData.monthlyStoreFees?.[m] || [];
      monthData.forEach((s) => {
        const abbr = s.abbreviation || s.storeAbbr;
        if (!abbr) return;
        if (!allMonthsStoreFees[abbr]) {
          allMonthsStoreFees[abbr] = 0;
        }
        allMonthsStoreFees[abbr] += (s.fees ?? s.total_fees ?? 0);
      });
    }

    const storeDataWithFees = (metricsData.storeData || []).map((store) => ({
      ...store,
      fees: allMonthsStoreFees[store.abbreviation] || 0
    }));

    return {
      ...metricsData,
      storeData: storeDataWithFees
    };
  }, [metricsData, selectedMonth, selectedStoreMonth, selectedDriverId]);

  // Filter driver data based on selected driver
  const getFilteredDriverData = useCallback((driverData) => {
    if (selectedDriverId === 'all' || !driverData) return driverData;
    return driverData.filter((d) => d.driverId === selectedDriverId);
  }, [selectedDriverId]);

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount || 0);
  };

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Card className="p-8 text-center" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
          <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-slate-900)' }}>Access Denied</h2>
          <p style={{ color: 'var(--text-slate-600)' }}>Only app owners can access this page.</p>
        </Card>
      </div>);

  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
        <span className="ml-3 text-lg" style={{ color: 'var(--text-slate-600)' }}>Loading metrics...</span>
      </div>);

  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Card className="p-8 text-center" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
          <h2 className="text-xl font-bold mb-2" style={{ color: '#ef4444' }}>Error Loading Metrics</h2>
          <p style={{ color: 'var(--text-slate-600)', marginBottom: '1rem' }}>{error}</p>
          <Button onClick={fetchMetrics}>Retry</Button>
        </Card>
      </div>);

  }

  if (!metricsData) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <p style={{ color: 'var(--text-slate-600)' }}>No metrics data available.</p>
      </div>);

  }

  return (
    <div className="h-screen p-4 md:p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto h-full flex flex-col gap-6">
        {/* Header */}
        <div className="shrink-0 space-y-6">
          <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
              Admin Metrics
            </h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={selectedCityId || ''} onValueChange={handleCityChange}>
              <SelectTrigger className="w-[120px] md:w-[140px]">
                <SelectValue placeholder="Select City" />
              </SelectTrigger>
              <SelectContent>
                {cities.map((city) =>
                <SelectItem key={city.id} value={city.id}>{city.name}</SelectItem>
                )}
              </SelectContent>
            </Select>

            <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
              <SelectTrigger className="w-[140px] md:w-[160px]">
                <SelectValue placeholder="All Drivers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Drivers</SelectItem>
                {metricsData?.driverData?.slice().sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)).map((driver) =>
                <SelectItem key={driver.driverId} value={driver.driverId}>{driver.name}</SelectItem>
                )}
              </SelectContent>
            </Select>

            <Select value={selectedYear} onValueChange={handleYearChange}>
              <SelectTrigger className="w-[120px] md:w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map((year) =>
                <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                )}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={() => fetchMetrics(selectedYear, selectedCityId, false)} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="outline" size="icon">
              <Share2 className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm mb-2" style={{ color: 'var(--text-slate-500)' }}>{selectedMonth ? `${MONTH_NAMES[selectedMonth - 1]} Billable`: `${selectedYear} Deliveries`}</p>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg" style={{ background: '#d1fae5' }}>
                  <Package className="w-5 h-5" style={{ color: '#059669' }} />
                </div>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                  {(selectedMonth ?
                  showEnvelopeAdjustedTotals && metricsData.envelopeMetrics ?
                  metricsData.envelopeMetrics.yearTotals.adjustedDeliveries / 12 :
                  metricsData.monthlyData?.[selectedMonth - 1]?.billable :

                  showEnvelopeAdjustedTotals && metricsData.envelopeMetrics ?
                  metricsData.envelopeMetrics.yearTotals.adjustedDeliveries :
                  metricsData.yearTotals?.billable)?.

                  toLocaleString() || 0}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm mb-2" style={{ color: 'var(--text-slate-500)' }}>{selectedMonth ? `${MONTH_NAMES[selectedMonth - 1]} Non-Billable`: `${selectedYear} Non-Billable`}</p>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg" style={{ background: '#fed7aa' }}>
                  <TrendingUp className="w-5 h-5" style={{ color: '#b45309' }} />
                </div>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                  {(selectedMonth ?
                  metricsData.monthlyData?.[selectedMonth - 1]?.nonBillable :
                  metricsData.yearTotals?.nonBillable)?.
                  toLocaleString() || 0}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm mb-2" style={{ color: 'var(--text-slate-500)' }}>Active Drivers</p>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg" style={{ background: '#e9d5ff' }}>
                  <Truck className="w-5 h-5" style={{ color: '#7e22ce' }} />
                </div>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{metricsData.yearTotals?.activeDrivers || 0}</p>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm mb-2" style={{ color: 'var(--text-slate-500)' }}>Stores Paying</p>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg" style={{ background: '#dbeafe' }}>
                  <Store className="w-5 h-5" style={{ color: '#1e40af' }} />
                </div>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                  {feeTotals?.stores_paying_fees || 0} / {(feeTotals?.total_stores || feeTotals?.active_stores || feeTotals?.totalStores || 0)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm mb-2" style={{ color: 'var(--text-slate-500)' }}>Fee Rate</p>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg" style={{ background: 'var(--bg-slate-200)' }}>
                  <DollarSign className="w-5 h-5" style={{ color: 'var(--text-slate-600)' }} />
                </div>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                  {formatCurrency(feeTotals?.app_fee_rate || 0)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: '#fef3c7', borderColor: '#fcd34d' }}>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm mb-2" style={{ color: '#b45309' }}>{selectedMonth ? MONTH_NAMES[selectedMonth - 1] : selectedYear} Fees</p>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg" style={{ background: '#f59e0b' }}>
                  <DollarSign className="w-5 h-5" style={{ color: 'white' }} />
                </div>
                <p className="text-2xl font-bold" style={{ color: '#78350f' }}>
                  {formatCurrency(
                    selectedMonth ?
                    (feeTotals?.monthly_fees?.[selectedMonth - 1] ?? feeTotals?.monthlyFees?.[selectedMonth - 1] ?? 0) :
                    (feeTotals?.total_fees_owed ?? feeTotals?.totalFeesOwed ?? 0)
                  )}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex-1 overflow-auto pr-1 md:pr-2 pb-4">
        {/* Row 1: Monthly Store App Fees */}
        <div>
          <MonthlyStoreMetricsGrid
            metricsData={metricsData}
            selectedYear={selectedYear}
            selectedMonth={selectedMonth}
            selectedStoreMonth={selectedStoreMonth}
            metricsViewMode={metricsViewMode}
            showEnvelopeAdjustedTotals={showEnvelopeAdjustedTotals}
            onMonthClick={(month) => {
              if (selectedMonth === month && !selectedStoreMonth) {
                setSelectedMonth(null);
                setShowDayByDay(false);
              } else {
                setSelectedMonth(month);
                setSelectedStoreMonth(null);
                setShowDayByDay(true); // Default to Day by Day when a month is clicked
              }
            }}
            onStoreMonthClick={(month, storeId, storeAbbr, storeName) => {
              setSelectedStoreMonth({ month, storeId, storeAbbr, storeName });
              setSelectedMonth(month); // Also set month filter
            }}
            onResetView={() => {
              setSelectedStoreMonth(null);
              setSelectedMonth(null);
            }}
            onViewModeChange={(mode) => setMetricsViewMode(mode)}
            onEnvelopeToggleChange={setShowEnvelopeAdjustedTotals} />

        </div>

        {/* Row 2: Store Breakdown or Day-by-Day Breakdown */}
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Store className="w-5 h-5" />
              {selectedStoreMonth ?
              `${selectedStoreMonth.storeName || selectedStoreMonth.storeAbbr} - ${MONTH_NAMES[selectedStoreMonth.month - 1]} ${selectedYear} (Day-by-Day)` :
              `Store ${metricsViewMode === 'fees' ? 'App Fees' : 'Breakdown'} (${selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'All'} ${selectedYear})`
              }
            </CardTitle>

            {/* View Mode Toggle Buttons - show only when a month is selected */}
            {selectedMonth && (
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => setShowDayByDay(true)}
                  variant={showDayByDay ? "default" : "outline"}
                  size="sm"
                  className="whitespace-nowrap">
                  Day by Day
                </Button>
                <Button
                  onClick={() => setShowDayByDay(false)}
                  variant={!showDayByDay ? "default" : "outline"}
                  size="sm"
                  className="whitespace-nowrap">
                  By Store
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="px-1 py-3">
            {showDayByDay && selectedMonth && !selectedStoreMonth ?
            // Day-by-Day Grid View - Use dailyDeliveryData billable/non-billable values
            <DayByDayStoreMetricsGrid
              metricsData={{
                ...metricsData,
                dailyDeliveryData: metricsData.dailyDeliveryData // Pass the already-calculated daily data
              }}
              selectedMonth={selectedMonth}
              selectedYear={selectedYear}
              selectedCityId={selectedCityId} /> :


            // Bar Chart View
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={(() => {
                  // For daily breakdown (store+month selected), use daily data directly
                  if (filteredData?.isDailyBreakdown) {
                    // Get days in the selected month for the selected year
                    const daysInMonth = new Date(parseInt(selectedYear), selectedStoreMonth.month, 0).getDate();
                    const rawDailyData = filteredData.storeData || [];

                    // Create a map of existing data
                    const dataByDay = new Map(rawDailyData.map((d) => [d.day, d]));

                    // Fill in all days of the month, sorted 1 to N
                    const fullDailyData = [];
                    for (let day = 1; day <= daysInMonth; day++) {
                      const existing = dataByDay.get(day);
                      fullDailyData.push({
                        day,
                        // Completed (Green) = Completed Deliveries + After Hours Pickups
                        totalCompleted: (existing?.completed || 0) + (existing?.afterHours || 0),
                        // Failed (Red) = Failed Deliveries only
                        totalFailed: existing?.failed || 0,
                        envelopeCount: 0,
                        fees: existing?.fees || 0
                      });
                    }
                    return fullDailyData;
                  }

                  // For store breakdown (year or month view)
                  return (filteredData?.storeData || metricsData.storeData || []).
                  slice().
                  filter((item) => {
                    // Only show stores with data
                    const total = (item.completed || 0) + (item.failed || 0) + (item.afterHours || 0);
                    return total > 0 || (item.fees || 0) > 0;
                  }).
                  sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)).
                  map((item) => {
                    // Get envelope data for this store - aggregate across all months if no specific month selected
                    let envelopeValue = 0;
                    if (showEnvelopeAdjustedTotals && metricsData.envelopeMetrics?.byStoreAndMonth?.[item.storeId]) {
                      if (selectedMonth) {
                        // Specific month selected
                        envelopeValue = metricsData.envelopeMetrics.byStoreAndMonth[item.storeId][selectedMonth]?.totalEnvelopeValue || 0;
                      } else {
                        // All year - sum across all months for this store
                        const storeMonthData = metricsData.envelopeMetrics.byStoreAndMonth[item.storeId];
                        for (const month in storeMonthData) {
                          envelopeValue += storeMonthData[month]?.totalEnvelopeValue || 0;
                        }
                      }
                    }
                    // Completed (Green) = Completed Deliveries + After Hours Pickups
                    const baseCompleted = (item.completed || 0) + (item.afterHours || 0);

                    return {
                      ...item,
                      totalCompleted: baseCompleted,
                      envelopeCount: envelopeValue,
                      // Failed (Red) = Failed Deliveries only
                      totalFailed: item.failed || 0,
                      fees: item.fees || 0
                    };
                  });
                })()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey={selectedStoreMonth ? "day" : "abbreviation"}
                    tick={selectedStoreMonth ? { fill: 'var(--text-slate-600)', fontSize: 11 } : (props) => {
                      const { x, y, payload } = props;
                      const storeData = (filteredData?.storeData || metricsData.storeData)?.find((s) => s.abbreviation === payload.value);
                      // Total = Completed Deliveries + After Hours + Failed
                      const totalDeliveries = storeData ? (storeData.completed || 0) + (storeData.afterHours || 0) + (storeData.failed || 0) : 0;
                      const displayValue = metricsViewMode === 'fees' ?
                      `$${(storeData?.fees || 0).toFixed(0)}` :
                      totalDeliveries;
                      return (
                        <g transform={`translate(${x},${y})`}>
                          <text x={0} y={0} dy={12} textAnchor="middle" fill="var(--text-slate-600)" fontSize={11}>
                            {payload.value}
                          </text>
                          <text x={0} y={0} dy={26} textAnchor="middle" fill={metricsViewMode === 'fees' ? '#f59e0b' : '#10b981'} fontSize={10} fontWeight="600">
                            {displayValue}
                          </text>
                        </g>);

                    }}
                    interval={0}
                    height={50} />

                  <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-white)',
                      border: '1px solid var(--border-slate-200)',
                      borderRadius: '8px',
                      color: 'var(--text-slate-900)'
                    }}
                    formatter={(value, name) => [metricsViewMode === 'fees' ? `$${value.toFixed(2)}` : value, name]}
                    labelFormatter={(label) => {
                      if (selectedStoreMonth) {
                        return `Day ${label}`;
                      }
                      const store = metricsData.storeData?.find((s) => s.abbreviation === label);
                      return store?.name || label;
                    }} />

                  <Legend />
                  {metricsViewMode === 'fees' ?
                  <Bar dataKey="fees" fill="#f59e0b" name="App Fees" radius={[4, 4, 0, 0]} /> :

                  <>
                      <Bar dataKey="totalCompleted" stackId="completed" fill="#10b981" name="Completed" radius={showEnvelopeAdjustedTotals ? [0, 0, 0, 0] : [4, 4, 0, 0]} />
                      {showEnvelopeAdjustedTotals &&
                    <Bar dataKey="envelopeCount" stackId="completed" fill="#3b82f6" name="Envelope" radius={[4, 4, 0, 0]} />
                    }
                      <Bar dataKey="totalFailed" fill="#ef4444" name="Failed" radius={[4, 4, 0, 0]} />
                    </>
                  }
                </BarChart>
              </ResponsiveContainer>
            </div>
            }
          </CardContent>
        </Card>

        {/* Row 3: Monthly Deliveries + Driver Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Monthly Deliveries Chart - Shows daily breakdown when month selected */}
          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
                <BarChart3 className="w-5 h-5" />
                {selectedMonth ?
                `Daily Deliveries - ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}${selectedDriverId !== 'all' ? ` - ${metricsData.driverData?.find(d => d.driverId === selectedDriverId)?.name}` : ''}` :
                `Monthly Deliveries (${selectedYear})${selectedDriverId !== 'all' ? ` - ${metricsData.driverData?.find(d => d.driverId === selectedDriverId)?.name}` : ''}`
                }
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(() => {
                    if (!selectedMonth) {
                      // Filter monthly data by driver
                      if (selectedDriverId === 'all') return metricsData.monthlyData;
                      return metricsData.dailyDeliveryData ? 
                        Object.values(metricsData.dailyDeliveryData).flat().filter(d => d.driverId === selectedDriverId).reduce((acc, entry) => {
                          const existing = acc[entry.month - 1];
                          if (existing) {
                            existing.billable += entry.billable;
                            existing.nonBillable += entry.nonBillable;
                          } else {
                            acc[entry.month - 1] = { billable: entry.billable, nonBillable: entry.nonBillable, month: entry.month };
                          }
                          return acc;
                        }, Array(12).fill(null).map((_, i) => ({ billable: 0, nonBillable: 0, month: i + 1 }))) 
                        : metricsData.monthlyData;
                    }

                    // Get days in the selected month for the selected year
                    const daysInMonth = new Date(parseInt(selectedYear), selectedMonth, 0).getDate();
                    let rawDailyData = metricsData.dailyDeliveryData?.[selectedMonth] || [];

                    // Filter by selected driver if not 'all'
                    if (selectedDriverId !== 'all') {
                      rawDailyData = rawDailyData.filter(d => d.driverId === selectedDriverId);
                    }

                    // Create a map of existing data
                    const dataByDay = new Map(rawDailyData.map((d) => [d.day, d]));

                    // Fill in all days of the month, sorted 1 to N
                    const fullDailyData = [];
                    for (let day = 1; day <= daysInMonth; day++) {
                      const existing = dataByDay.get(day);
                      fullDailyData.push({
                        day,
                        billable: existing?.billable || 0,
                        nonBillable: existing?.nonBillable || 0,
                        adjustedDeliveries: existing?.adjustedDeliveries || 0
                      });
                    }
                    return fullDailyData;
                  })()}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-slate-200)" />
                    <XAxis
                      dataKey={selectedMonth ? "day" : "month"}
                      tick={selectedMonth ? (props) => {
                        const { x, y, payload } = props;
                        const dayData = metricsData.dailyDeliveryData?.[selectedMonth]?.find((d) => d.day === payload.value);
                        const total = (dayData?.billable || 0) + (dayData?.nonBillable || 0);
                        return (
                          <g transform={`translate(${x},${y})`}>
                            <text x={0} y={0} dy={12} textAnchor="middle" fill="var(--text-slate-600)" fontSize={10}>
                              {payload.value}
                            </text>
                            <text x={0} y={0} dy={24} textAnchor="middle" fill="#10b981" fontSize={9} fontWeight="600">
                              {total > 0 ? total : ''}
                            </text>
                          </g>);

                      } : { fill: 'var(--text-slate-600)', fontSize: 12 }}
                      interval={selectedMonth ? 0 : 0}
                      height={selectedMonth ? 40 : 30} />

                    <YAxis tick={{ fill: 'var(--text-slate-600)', fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{
                        background: 'white',
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px'
                      }}
                      labelFormatter={(label) => selectedMonth ? `Day ${label}` : label} />

                    <Legend />
                    {metricsViewMode === 'deliveries' && showEnvelopeAdjustedTotals ?
                    <Bar dataKey="adjustedDeliveries" fill="#10b981" name="Adjusted Deliveries" radius={[4, 4, 0, 0]} /> :

                    <Bar dataKey="billable" fill={COLORS.billable} name="Billable" radius={[4, 4, 0, 0]} />
                    }
                    <Bar dataKey="nonBillable" fill={COLORS.nonBillable} name="Non-Billable" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Driver Performance Chart - Breakdown by Driver */}
          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
                <Users className="w-5 h-5" />
                Driver Breakdown 
                {selectedStoreMonth ?
                ` - ${selectedStoreMonth.storeName || selectedStoreMonth.storeAbbr}` :
                selectedMonth ?
                ` (${MONTH_NAMES[selectedMonth - 1]} ${selectedYear})` :
                ` (All ${selectedYear})`
                }
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={
                    getFilteredDriverData(
                      (selectedStoreMonth ?
                      Object.values(metricsData.dailyDriverData?.[selectedStoreMonth.month] || {}).
                      flat().
                      reduce((acc, entry) => {
                        const existing = acc.find((d) => d.driverId === entry.driverId);
                        if (existing) {
                          existing.billable += entry.billable;
                          existing.nonBillable += entry.nonBillable;
                        } else {
                          acc.push({ ...entry });
                        }
                        return acc;
                      }, []) :
                      selectedMonth ?
                      Object.values(metricsData.dailyDriverData?.[selectedMonth] || {}).
                      flat().
                      reduce((acc, entry) => {
                        const existing = acc.find((d) => d.driverId === entry.driverId);
                        if (existing) {
                          existing.billable += entry.billable;
                          existing.nonBillable += entry.nonBillable;
                        } else {
                          acc.push({ ...entry });
                        }
                        return acc;
                      }, []) :
                      metricsData.driverData) || []
                    )?.
                    slice().
                    filter((driver) => (driver.billable || 0) + (driver.nonBillable || 0) > 0).
                    sort((a, b) => (b.billable || 0) + (b.nonBillable || 0) - ((a.billable || 0) + (a.nonBillable || 0)))
                    }
                    barCategoryGap="15%">

                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-slate-200)" />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: 'var(--text-slate-600)', fontSize: 11 }}
                      interval={0}
                      angle={-45}
                      textAnchor="end"
                      height={80} />

                    <YAxis tick={{ fill: 'var(--text-slate-600)', fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{
                        background: 'white',
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px'
                      }} />

                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <Bar dataKey="billable" fill={COLORS.billable} name="Billable" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="nonBillable" fill={COLORS.nonBillable} name="Non-Billable" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>


      </div>
      </div>
    </div>);

}