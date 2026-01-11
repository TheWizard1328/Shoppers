import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart3, DollarSign, Store, Package, RefreshCw, Loader2, TrendingUp, Users, Truck } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { getEffectiveUser } from '@/components/utils/auth';
import { isAppOwner } from '../components/utils/userRoles';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';
import MonthlyStoreMetricsGrid from '../components/admin/MonthlyStoreMetricsGrid';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const COLORS = {
  billable: '#10b981',    // Green
  nonBillable: '#f97316'  // Orange
};

export default function AdminMetrics() {
  const [currentUser, setCurrentUser] = useState(null);
  const [hasAccess, setHasAccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false); // For year changes (doesn't hide content)
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [selectedMonth, setSelectedMonth] = useState(null); // null = all year, 1-12 = specific month
  const [selectedStoreMonth, setSelectedStoreMonth] = useState(null); // { month, storeId, storeAbbr } for day-by-day breakdown
  const [selectedCityId, setSelectedCityId] = useState(null); // Will be set to user's city
  const [cities, setCities] = useState([]);
  const [metricsData, setMetricsData] = useState(null);
  const [error, setError] = useState(null);
  const [initialCitySet, setInitialCitySet] = useState(false);

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
        setHasAccess(isAppOwner(user));
        
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
      const response = await base44.functions.invoke('getAdminMetrics', { 
        year: parseInt(year),
        cityId: cityId === 'all' ? null : cityId
      });
      const data = response?.data || response;
      
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

  // Filter data based on selected month and store (client-side filtering)
  const filteredData = useMemo(() => {
    if (!metricsData) return null;
    
    // Store + Month selected: show day-by-day breakdown for that store
    if (selectedStoreMonth) {
      // Build day-by-day data for the selected store in selected month
      const dailyData = metricsData.dailyStoreData?.[selectedStoreMonth.month]?.[selectedStoreMonth.storeId] || [];
      
      return {
        ...metricsData,
        storeData: dailyData, // Daily breakdown for the store
        isDailyBreakdown: true
      };
    }
    
    // Only month selected: filter all graphs by month
    if (selectedMonth) {
      const monthStoreData = metricsData.storeDataByMonth?.[selectedMonth] || metricsData.storeData;
      const monthFees = metricsData.storeFeeTotals?.monthlyFees?.[selectedMonth - 1] || 0;

      return {
        ...metricsData,
        storeData: monthStoreData,
        displayedFees: monthFees,
        isDailyBreakdown: false
      };
    }
    
    // Nothing selected: return all year data
    return metricsData;
  }, [metricsData, selectedMonth, selectedStoreMonth]);

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount || 0);
  };

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Card className="p-8 text-center">
          <h2 className="text-xl font-bold mb-2">Access Denied</h2>
          <p className="text-slate-600">Only app owners can access this page.</p>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        <span className="ml-3 text-lg text-slate-600">Loading metrics...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Card className="p-8 text-center">
          <h2 className="text-xl font-bold mb-2 text-red-600">Error Loading Metrics</h2>
          <p className="text-slate-600 mb-4">{error}</p>
          <Button onClick={fetchMetrics}>Retry</Button>
        </Card>
      </div>
    );
  }

  if (!metricsData) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <p className="text-slate-600">No metrics data available.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <SmartRefreshIndicator inline={true} />
            <h1 className="text-2xl md:text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
              Admin Metrics
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <Select value={selectedCityId || ''} onValueChange={handleCityChange}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Select City" />
              </SelectTrigger>
              <SelectContent>
                {cities.map(city => (
                  <SelectItem key={city.id} value={city.id}>{city.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedYear} onValueChange={handleYearChange}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map(year => (
                  <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => fetchMetrics(selectedYear, selectedCityId, false)} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-emerald-100 rounded-lg">
                  <Package className="w-6 h-6 text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">{selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'Year'} Billable</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {(selectedMonth 
                      ? metricsData.monthlyData?.[selectedMonth - 1]?.billable 
                      : metricsData.yearTotals?.billable
                    )?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-orange-100 rounded-lg">
                  <TrendingUp className="w-6 h-6 text-orange-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">{selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'Year'} Non-Billable</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {(selectedMonth 
                      ? metricsData.monthlyData?.[selectedMonth - 1]?.nonBillable 
                      : metricsData.yearTotals?.nonBillable
                    )?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-purple-100 rounded-lg">
                  <Truck className="w-6 h-6 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Active Drivers</p>
                  <p className="text-2xl font-bold text-slate-900">{metricsData.yearTotals?.activeDrivers || 0}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-amber-50 border-amber-200">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-amber-500 rounded-lg">
                  <DollarSign className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-amber-700">{selectedYear} Total Fees</p>
                  <p className="text-2xl font-bold text-amber-900">
                    {formatCurrency(metricsData.storeFeeTotals?.total_fees_owed || 0)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Row 1: Monthly Store App Fees */}
        <MonthlyStoreMetricsGrid 
          metricsData={metricsData} 
          selectedYear={selectedYear}
          selectedMonth={selectedMonth}
          selectedStoreMonth={selectedStoreMonth}
          onMonthClick={(month) => {
            setSelectedMonth(prev => prev === month ? null : month);
            setSelectedStoreMonth(null); // Clear store selection when month changes
          }}
          onStoreMonthClick={(month, storeId, storeAbbr, storeName) => {
            setSelectedStoreMonth({ month, storeId, storeAbbr, storeName });
            setSelectedMonth(month); // Also set month filter
          }}
        />

        {/* Row 2: Store Breakdown or Day-by-Day Breakdown */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Store className="w-5 h-5" />
              {selectedStoreMonth 
                ? `${selectedStoreMonth.storeName || selectedStoreMonth.storeAbbr} - ${MONTH_NAMES[selectedStoreMonth.month - 1]} ${selectedYear} (Day-by-Day)`
                : `Store Breakdown (${selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'All'} ${selectedYear})`
              }
            </CardTitle>
            {selectedStoreMonth && (
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setSelectedStoreMonth(null)}
                className="text-xs"
              >
                ← Back to Month View
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={(filteredData?.storeData || metricsData.storeData)?.map(item => ({
                  ...item,
                  totalCompleted: (item.completed || 0) + (item.afterHours || 0),
                  totalFailed: (item.failed || 0) + (item.cancelled || 0)
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis 
                    dataKey={selectedStoreMonth ? "day" : "abbreviation"} 
                    tick={selectedStoreMonth ? { fill: '#64748b', fontSize: 11 } : (props) => {
                      const { x, y, payload } = props;
                      const storeData = (filteredData?.storeData || metricsData.storeData)?.find(s => s.abbreviation === payload.value);
                      const total = storeData ? (storeData.completed || 0) + (storeData.failed || 0) + (storeData.afterHours || 0) + (storeData.cancelled || 0) : 0;
                      return (
                        <g transform={`translate(${x},${y})`}>
                          <text x={0} y={0} dy={12} textAnchor="middle" fill="#64748b" fontSize={11}>
                            {payload.value}
                          </text>
                          <text x={0} y={0} dy={26} textAnchor="middle" fill="#10b981" fontSize={10} fontWeight="600">
                            {total}
                          </text>
                        </g>
                      );
                    }}
                    interval={0}
                    height={50}
                  />
                  <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                  <Tooltip 
                    contentStyle={{ 
                      background: 'white', 
                      border: '1px solid #e2e8f0',
                      borderRadius: '8px'
                    }}
                    formatter={(value, name) => [value, name]}
                    labelFormatter={(label) => {
                      if (selectedStoreMonth) {
                        return `Day ${label}`;
                      }
                      const store = metricsData.storeData?.find(s => s.abbreviation === label);
                      return store?.name || label;
                    }}
                  />
                  <Legend />
                  <Bar dataKey="totalCompleted" fill="#10b981" name="Completed" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="totalFailed" fill="#ef4444" name="Failed" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Row 3: Monthly Deliveries + Driver Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Monthly Deliveries Chart - Shows daily breakdown when month selected */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5" />
                {selectedMonth 
                  ? `Daily Deliveries - ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`
                  : `Monthly Deliveries (${selectedYear})`
                }
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={selectedMonth ? metricsData.dailyDeliveryData?.[selectedMonth] : metricsData.monthlyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis 
                      dataKey={selectedMonth ? "day" : "month"} 
                      tick={{ fill: '#64748b', fontSize: selectedMonth ? 10 : 12 }} 
                      interval={selectedMonth ? 'preserveStartEnd' : 0}
                    />
                    <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                    <Tooltip 
                      contentStyle={{ 
                        background: 'white', 
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px'
                      }}
                      labelFormatter={(label) => selectedMonth ? `Day ${label}` : label}
                    />
                    <Legend />
                    <Bar dataKey="billable" fill={COLORS.billable} name="Billable" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="nonBillable" fill={COLORS.nonBillable} name="Non-Billable" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Driver Performance Chart - Breakdown by Driver */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5" />
                Driver Breakdown 
                {selectedStoreMonth 
                  ? ` - ${selectedStoreMonth.storeName || selectedStoreMonth.storeAbbr}`
                  : selectedMonth 
                    ? ` (${MONTH_NAMES[selectedMonth - 1]} ${selectedYear})`
                    : ` (All ${selectedYear})`
                }
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart 
                    data={
                      selectedStoreMonth 
                        ? metricsData.driverDataByStore?.[selectedStoreMonth.storeId]
                        : selectedMonth 
                          ? metricsData.driverDataByMonth?.[selectedMonth] 
                          : metricsData.driverData
                    } 
                    barCategoryGap="15%"
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis 
                      dataKey="name" 
                      tick={{ fill: '#64748b', fontSize: 11 }} 
                      interval={0}
                      angle={-45}
                      textAnchor="end"
                      height={80}
                    />
                    <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                    <Tooltip 
                      contentStyle={{ 
                        background: 'white', 
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px'
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <Bar dataKey="billable" fill={COLORS.billable} name="Billable" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="nonBillable" fill={COLORS.nonBillable} name="Non-Billable" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* App Fees Summary */}
        {metricsData.storeFeeTotals && (
          <Card className="border-amber-200 bg-amber-50/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-900">
                <DollarSign className="w-5 h-5" />
                App Fees Summary ({selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'All'} {selectedYear})
              </CardTitle>
              <CardDescription>
                Stores with "Pays App Fees" enabled - {metricsData.storeFeeTotals?.stores_paying_fees || 0} of {metricsData.storeFeeTotals?.total_stores || 0} stores
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-white rounded-lg border">
                  <p className="text-sm text-slate-500">Billable Deliveries</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {metricsData.storeFeeTotals?.total_billable_while_paying?.toLocaleString() || 0}
                  </p>
                </div>
                <div className="p-4 bg-white rounded-lg border">
                  <p className="text-sm text-slate-500">Fee Rate</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {formatCurrency(metricsData.storeFeeTotals?.app_fee_rate || 0)}
                  </p>
                </div>
                <div className="p-4 bg-white rounded-lg border">
                  <p className="text-sm text-slate-500">Stores Paying</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {metricsData.storeFeeTotals?.stores_paying_fees || 0}
                  </p>
                </div>
                <div className="p-4 bg-amber-100 rounded-lg border border-amber-300">
                  <p className="text-sm text-amber-700">{selectedMonth ? 'Month' : 'Total'} Fees Owed</p>
                  <p className="text-2xl font-bold text-amber-900">
                    {formatCurrency(
                      selectedMonth 
                        ? (metricsData.storeFeeTotals?.monthlyFees?.[selectedMonth - 1] || 0)
                        : (metricsData.storeFeeTotals?.total_fees_owed || 0)
                    )}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}