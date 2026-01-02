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

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

export default function AdminMetrics() {
  const [currentUser, setCurrentUser] = useState(null);
  const [hasAccess, setHasAccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false); // For year changes (doesn't hide content)
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [selectedMonth, setSelectedMonth] = useState(null); // null = all year, 1-12 = specific month
  const [metricsData, setMetricsData] = useState(null);
  const [error, setError] = useState(null);

  const availableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  // Check access
  useEffect(() => {
    const checkAccess = async () => {
      try {
        const user = await getEffectiveUser();
        setCurrentUser(user);
        setHasAccess(isAppOwner(user));
      } catch (error) {
        console.error('Access check failed:', error);
        setHasAccess(false);
      }
    };
    checkAccess();
  }, []);

  // Fetch metrics from backend - only when year changes or on initial load
  const fetchMetrics = useCallback(async (year, isInitial = false) => {
    if (!hasAccess) return;
    
    // Only show full loading screen on initial load
    if (isInitial) {
      setIsLoading(true);
    } else {
      setIsFetching(true);
    }
    setError(null);
    
    try {
      const response = await base44.functions.invoke('getAdminMetrics', { year: parseInt(year) });
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

  // Initial load
  useEffect(() => {
    if (hasAccess) {
      fetchMetrics(selectedYear, true); // isInitial = true
    }
  }, [hasAccess]); // Only on hasAccess change, not selectedYear

  // Handle year change without full refresh
  const handleYearChange = (newYear) => {
    setSelectedYear(newYear);
    fetchMetrics(newYear, false); // isInitial = false - keeps content visible
  };

  // Filter data based on selected month (client-side filtering)
  const filteredData = useMemo(() => {
    if (!metricsData) return null;
    if (!selectedMonth) return metricsData; // No month selected, return all year data

    // Filter store data for selected month
    const monthStoreData = metricsData.storeDataByMonth?.[selectedMonth] || metricsData.storeData;
    
    // Get month-specific fees
    const monthFees = metricsData.storeFeeTotals?.monthlyFees?.[selectedMonth - 1] || 0;

    return {
      ...metricsData,
      storeData: monthStoreData,
      displayedFees: monthFees
    };
  }, [metricsData, selectedMonth]);

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
            <Button variant="outline" onClick={() => fetchMetrics(selectedYear, false)} disabled={isFetching}>
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
                  <p className="text-sm text-slate-500">{selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'Year'} Completed</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {(selectedMonth 
                      ? metricsData.monthlyData?.[selectedMonth - 1]?.completed 
                      : metricsData.yearTotals?.completed
                    )?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-blue-100 rounded-lg">
                  <TrendingUp className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">{selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'Year'} Failed</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {(selectedMonth 
                      ? metricsData.monthlyData?.[selectedMonth - 1]?.failed 
                      : metricsData.yearTotals?.failed
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
                  <p className="text-sm text-amber-700">{selectedMonth ? MONTH_NAMES[selectedMonth - 1] : selectedYear} Fees</p>
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
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Monthly Deliveries Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5" />
                Monthly Deliveries ({selectedYear})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart 
                    data={metricsData.monthlyData}
                    onClick={(data) => {
                      if (data && data.activePayload && data.activePayload.length > 0) {
                        const clickedMonth = data.activePayload[0].payload.monthNum;
                        setSelectedMonth(prev => prev === clickedMonth ? null : clickedMonth);
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                    <Tooltip 
                      contentStyle={{ 
                        background: 'white', 
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px'
                      }}
                    />
                    <Legend />
                    <Bar dataKey="completed" fill="#10b981" name="Completed" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="failed" fill="#ef4444" name="Failed" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-slate-500 text-center mt-2">
                Click on a month to filter charts below • Currently viewing: <span className="font-semibold text-emerald-600">{selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'All Year'}</span>
              </p>
            </CardContent>
          </Card>

          {/* Store Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Store className="w-5 h-5" />
                Store Breakdown ({selectedMonth ? MONTH_NAMES[selectedMonth - 1] : 'All'} {selectedYear})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={filteredData?.storeData || metricsData.storeData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis 
                      dataKey="abbreviation" 
                      tick={{ fill: '#64748b', fontSize: 11 }}
                      interval={0}
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
                        const store = metricsData.storeData?.find(s => s.abbreviation === label);
                        return store?.name || label;
                      }}
                    />
                    <Legend />
                    <Bar dataKey="completed" fill="#10b981" name="Completed" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="failed" fill="#ef4444" name="Failed" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          </div>

          {/* Driver Performance Chart - 12 Month View OR Daily View when month selected */}
          <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Driver Performance {selectedMonth ? `- ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear} (Daily)` : `by Month (${selectedYear})`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[350px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart 
                  data={selectedMonth ? metricsData.driverDailyByMonth?.[selectedMonth] : metricsData.driverMonthlyData} 
                  barCategoryGap="15%"
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis 
                    dataKey={selectedMonth ? "day" : "month"} 
                    tick={{ fill: '#64748b', fontSize: 12 }} 
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
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  {metricsData.driverNames?.map((driverName, index) => (
                    <Bar 
                      key={driverName}
                      dataKey={driverName} 
                      fill={COLORS[index % COLORS.length]} 
                      name={driverName}
                      radius={[2, 2, 0, 0]}
                      barSize={selectedMonth ? 8 : 20}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
          </Card>

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