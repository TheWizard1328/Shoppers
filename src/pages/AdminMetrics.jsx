import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { base44 } from '@/api/base44Client';
import { BarChart3, Package, Truck, DollarSign, TrendingUp, RefreshCw } from 'lucide-react';
import { useAppData } from '@/components/utils/AppDataContext';

export default function AdminMetrics() {
  const { stores, deliveries, drivers } = useAppData();
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [selectedMonth, setSelectedMonth] = useState((new Date().getMonth() + 1).toString());
  const [metrics, setMetrics] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const years = ['2024', '2025', '2026'];
  const months = [
    { value: '1', label: 'January' },
    { value: '2', label: 'February' },
    { value: '3', label: 'March' },
    { value: '4', label: 'April' },
    { value: '5', label: 'May' },
    { value: '6', label: 'June' },
    { value: '7', label: 'July' },
    { value: '8', label: 'August' },
    { value: '9', label: 'September' },
    { value: '10', label: 'October' },
    { value: '11', label: 'November' },
    { value: '12', label: 'December' }
  ];

  useEffect(() => {
    fetchMetrics();
  }, [selectedYear, selectedMonth]);

  const fetchMetrics = async () => {
    try {
      setIsLoading(true);
      const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
        year: parseInt(selectedYear),
        month: parseInt(selectedMonth)
      });
      setMetrics(response.data || response);
    } catch (error) {
      console.error('Failed to fetch metrics:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen p-6" style={{ background: 'var(--bg-slate-50)' }}>
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
          </div>
        </div>
      </div>
    );
  }

  const MetricCard = ({ title, value, icon: Icon, trend, color = 'slate' }) => (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-slate-600)' }}>
          {title}
        </CardTitle>
        <Icon className={`w-4 h-4 text-${color}-600`} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
          {value}
        </div>
        {trend && (
          <p className="text-xs text-slate-500 flex items-center gap-1 mt-1">
            <TrendingUp className="w-3 h-3" />
            {trend}
          </p>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-slate-700" />
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
              Admin Metrics
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Month" />
              </SelectTrigger>
              <SelectContent>
                {months.map((month) => (
                  <SelectItem key={month.value} value={month.value}>
                    {month.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger className="w-24">
                <SelectValue placeholder="Year" />
              </SelectTrigger>
              <SelectContent>
                {years.map((year) => (
                  <SelectItem key={year} value={year}>
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button onClick={fetchMetrics} variant="outline" size="icon">
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Metrics Grid */}
        {metrics && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Total Deliveries"
              value={metrics.totalDeliveries || 0}
              icon={Package}
              color="emerald"
            />
            <MetricCard
              title="Active Drivers"
              value={metrics.activeDrivers || 0}
              icon={Truck}
              color="blue"
            />
            <MetricCard
              title="Total Revenue"
              value={`$${(metrics.totalRevenue || 0).toFixed(2)}`}
              icon={DollarSign}
              color="purple"
            />
            <MetricCard
              title="Avg per Delivery"
              value={`$${(metrics.avgPerDelivery || 0).toFixed(2)}`}
              icon={TrendingUp}
              color="slate"
            />
          </div>
        )}

        {/* Additional Metrics */}
        {metrics && (
          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-slate-900)' }}>Monthly Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text-slate-600)' }}>
                      Completed Deliveries
                    </div>
                    <div className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                      {metrics.completedDeliveries || 0}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text-slate-600)' }}>
                      Failed Deliveries
                    </div>
                    <div className="text-2xl font-bold text-red-600">
                      {metrics.failedDeliveries || 0}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}