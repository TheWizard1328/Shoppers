import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart3, DollarSign, Store, Package, RefreshCw, Loader2, TrendingUp, Users, Truck, Calendar } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { format, subMonths, startOfMonth, endOfMonth } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { useAppData } from '../components/utils/AppDataContext';
import { getEffectiveUser } from '@/components/utils/auth';
import { isAppOwner } from '../components/utils/userRoles';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

export default function AdminMetrics() {
  const { stores, drivers, deliveries, isDataLoaded } = useAppData();
  const [currentUser, setCurrentUser] = useState(null);
  const [hasAccess, setHasAccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [metricsData, setMetricsData] = useState(null);
  const [storeMetrics, setStoreMetrics] = useState(null);

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

  // Calculate metrics from deliveries
  const calculateMetrics = useCallback(async () => {
    if (!hasAccess) return;
    
    setIsLoading(true);
    try {
      const year = parseInt(selectedYear);
      
      // CRITICAL: Fetch stores directly from backend to ensure we have them
      const allStores = await base44.entities.Store.list();
      
      // CRITICAL: Fetch full year deliveries from backend in chunks to avoid limits
      // Fetch all months in parallel to get around any query limits
      const monthPromises = [];
      for (let month = 1; month <= 12; month++) {
        const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
        const monthEndDate = new Date(year, month, 0);
        const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(monthEndDate.getDate()).padStart(2, '0')}`;
        
        monthPromises.push(
          base44.entities.Delivery.filter({
            delivery_date: { $gte: monthStart, $lte: monthEnd }
          })
        );
      }
      
      const monthResults = await Promise.all(monthPromises);
      const yearDeliveries = monthResults.flat();
      
      // Monthly delivery counts - split by store fee status
      const monthlyData = [];
      for (let month = 1; month <= 12; month++) {
        const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
        const monthEnd = new Date(year, month, 0);
        const monthEndStr = monthEnd.toISOString().split('T')[0];
        
        const monthDeliveries = yearDeliveries.filter(d => {
          if (!d?.delivery_date) return false;
          return d.delivery_date >= monthStart && d.delivery_date <= monthEndStr;
        });
        
        // Billable deliveries: completed patient deliveries + failed + after-hours pickups (completed/cancelled)
        const billableDeliveries = monthDeliveries.filter(d => {
          if (!d) return false;
          // Patient deliveries (completed or failed)
          if (d.patient_id && (d.status === 'completed' || d.status === 'failed')) return true;
          // After-hours pickups (completed or cancelled)
          if (!d.patient_id && d.after_hours_pickup && (d.status === 'completed' || d.status === 'cancelled')) return true;
          return false;
        });
        
        // Split billable deliveries by store fee status
        let payingStoresCount = 0;
        let notPayingStoresCount = 0;
        
        billableDeliveries.forEach(d => {
          const deliveryStore = allStores.find(s => s?.id === d.store_id);
          if (!deliveryStore) {
            notPayingStoresCount++;
            return;
          }
          
          // Check if store was paying fees on this delivery date
          const deliveryDateStr = d.delivery_date;
          let wasPayingFees = false;
          
          // Check historical status if app_fee_history exists
          if (deliveryStore.app_fee_history && Array.isArray(deliveryStore.app_fee_history) && deliveryStore.app_fee_history.length > 0) {
            const sortedHistory = [...deliveryStore.app_fee_history].sort((a, b) => 
              new Date(a.effective_date) - new Date(b.effective_date)
            );
            
            // Find the applicable period for this delivery date
            for (const entry of sortedHistory) {
              if (entry.effective_date <= deliveryDateStr) {
                wasPayingFees = entry.pays_app_fees;
              } else {
                break;
              }
            }
          } else {
            // No history - use current pays_app_fees status
            wasPayingFees = deliveryStore.pays_app_fees || false;
          }
          
          if (wasPayingFees) {
            payingStoresCount++;
          } else {
            notPayingStoresCount++;
          }
        });
        
        monthlyData.push({
          month: MONTH_NAMES[month - 1],
          monthNum: month,
          payingStores: payingStoresCount,
          notPayingStores: notPayingStoresCount
        });
      }

      // Driver performance (current month)
      const currentMonth = new Date().getMonth() + 1;
      const currentMonthStart = `${year}-${String(currentMonth).padStart(2, '0')}-01`;
      const currentMonthEnd = new Date(year, currentMonth, 0).toISOString().split('T')[0];
      
      const currentMonthDeliveries = yearDeliveries.filter(d => {
        if (!d?.delivery_date) return false;
        return d.delivery_date >= currentMonthStart && d.delivery_date <= currentMonthEnd;
      });

      const driverStats = {};
      currentMonthDeliveries.forEach(d => {
        if (!d.driver_id || !d.patient_id) return;
        if (!driverStats[d.driver_id]) {
          const driver = drivers.find(dr => dr?.id === d.driver_id);
          driverStats[d.driver_id] = {
            name: driver?.user_name || d.driver_name || 'Unknown',
            completed: 0,
            failed: 0,
            total: 0
          };
        }
        if (d.status === 'completed') driverStats[d.driver_id].completed++;
        else if (d.status === 'failed') driverStats[d.driver_id].failed++;
        driverStats[d.driver_id].total++;
      });

      const driverData = Object.values(driverStats)
        .sort((a, b) => b.completed - a.completed)
        .slice(0, 8);

      // Store breakdown (current month)
      const storeStats = {};
      currentMonthDeliveries.forEach(d => {
        if (!d.store_id || !d.patient_id) return;
        if (!storeStats[d.store_id]) {
          const store = allStores.find(s => s?.id === d.store_id);
          storeStats[d.store_id] = {
            name: store?.name || 'Unknown',
            abbreviation: store?.abbreviation || '',
            sortOrder: store?.sort_order ?? Infinity,
            completed: 0,
            failed: 0,
            total: 0
          };
        }
        if (d.status === 'completed') storeStats[d.store_id].completed++;
        else if (d.status === 'failed') storeStats[d.store_id].failed++;
        storeStats[d.store_id].total++;
      });

      const storeData = Object.values(storeStats)
        .sort((a, b) => a.sortOrder - b.sortOrder);

      // Year totals
      const yearCompleted = yearDeliveries.filter(d => d.status === 'completed' && d.patient_id).length;
      const yearFailed = yearDeliveries.filter(d => d.status === 'failed').length;

      setMetricsData({
        monthlyData,
        driverData,
        storeData,
        yearTotals: {
          completed: yearCompleted,
          failed: yearFailed,
          total: yearCompleted + yearFailed
        },
        currentMonthTotals: {
          completed: currentMonthDeliveries.filter(d => d.status === 'completed' && d.patient_id).length,
          failed: currentMonthDeliveries.filter(d => d.status === 'failed').length,
          activeDrivers: Object.keys(driverStats).length
        }
      });

      // Load store fee metrics
      try {
        const response = await base44.functions.invoke('getStoreMetrics', {
          year: year,
          month: currentMonth
        });
        setStoreMetrics(response?.data || response);
      } catch (err) {
        console.warn('Failed to load store metrics:', err);
      }

    } catch (error) {
      console.error('Failed to calculate metrics:', error);
    } finally {
      setIsLoading(false);
    }
  }, [drivers, hasAccess, selectedYear]);

  useEffect(() => {
    if (hasAccess && isDataLoaded) {
      calculateMetrics();
    }
  }, [calculateMetrics, hasAccess, isDataLoaded]);

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

  if (isLoading || !metricsData) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        <span className="ml-3 text-lg text-slate-600">Loading metrics...</span>
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
            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map(year => (
                  <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={calculateMetrics} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
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
                  <p className="text-sm text-slate-500">Year Total</p>
                  <p className="text-2xl font-bold text-slate-900">{metricsData.yearTotals.completed.toLocaleString()}</p>
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
                  <p className="text-sm text-slate-500">This Month</p>
                  <p className="text-2xl font-bold text-slate-900">{metricsData.currentMonthTotals.completed.toLocaleString()}</p>
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
                  <p className="text-2xl font-bold text-slate-900">{metricsData.currentMonthTotals.activeDrivers}</p>
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
                  <p className="text-sm text-amber-700">Fees This Month</p>
                  <p className="text-2xl font-bold text-amber-900">
                    {formatCurrency(storeMetrics?.totals?.total_fees_owed || 0)}
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
                Billable Deliveries by Store Fee Status ({selectedYear})
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                Includes completed + failed patient deliveries, and after-hours pickups (completed/cancelled)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={metricsData.monthlyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                    <Tooltip 
                      contentStyle={{ 
                        background: 'white', 
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px'
                      }}
                      formatter={(value, name) => {
                        if (name === 'Paying App Fees') return [value, 'Stores Paying Fees'];
                        if (name === 'Not Paying Fees') return [value, 'Stores Not Paying Fees'];
                        return [value, name];
                      }}
                    />
                    <Legend />
                    <Bar dataKey="payingStores" fill="#10b981" name="Paying App Fees" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="notPayingStores" fill="#f59e0b" name="Not Paying Fees" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Driver Performance Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5" />
                Driver Performance (This Month)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={metricsData.driverData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis 
                      dataKey="name" 
                      type="category" 
                      tick={{ fill: '#64748b', fontSize: 11 }} 
                      width={80}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        background: 'white', 
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px'
                      }}
                    />
                    <Bar dataKey="completed" fill="#3b82f6" name="Completed" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Store Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Store className="w-5 h-5" />
              Store Breakdown (This Month)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[350px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={metricsData.storeData}>
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
                      const store = metricsData.storeData.find(s => s.abbreviation === label);
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

        {/* App Fees Summary */}
        {storeMetrics && (
          <Card className="border-amber-200 bg-amber-50/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-900">
                <DollarSign className="w-5 h-5" />
                App Fees Summary (This Month)
              </CardTitle>
              <CardDescription>
                Stores with "Pays App Fees" enabled - {storeMetrics.totals?.stores_paying_fees || 0} of {storeMetrics.totals?.total_stores || 0} stores
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-white rounded-lg border">
                  <p className="text-sm text-slate-500">Billable Deliveries</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {storeMetrics.totals?.total_billable_while_paying?.toLocaleString() || 0}
                  </p>
                </div>
                <div className="p-4 bg-white rounded-lg border">
                  <p className="text-sm text-slate-500">Fee Rate</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {formatCurrency(storeMetrics.totals?.app_fee_rate || 0)}
                  </p>
                </div>
                <div className="p-4 bg-white rounded-lg border">
                  <p className="text-sm text-slate-500">Stores Paying</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {storeMetrics.totals?.stores_paying_fees || 0}
                  </p>
                </div>
                <div className="p-4 bg-amber-100 rounded-lg border border-amber-300">
                  <p className="text-sm text-amber-700">Total Fees Owed</p>
                  <p className="text-2xl font-bold text-amber-900">
                    {formatCurrency(storeMetrics.totals?.total_fees_owed || 0)}
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