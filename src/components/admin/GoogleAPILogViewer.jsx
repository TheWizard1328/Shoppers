import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, RefreshCw, MapPin, Navigation, Search, Info, AlertTriangle, TrendingUp, Clock, Filter, X } from 'lucide-react';
import { format, subDays, isWithinInterval, startOfDay, endOfDay } from 'date-fns';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';

const apiTypeIcons = {
  'Directions': Navigation,
  'Distance Matrix': MapPin,
  'Places Autocomplete': Search,
  'Place Details': Info,
  'Geocoding': MapPin
};

const apiTypeColors = {
  'Directions': 'bg-blue-100 text-blue-800',
  'Distance Matrix': 'bg-purple-100 text-purple-800',
  'Places Autocomplete': 'bg-green-100 text-green-800',
  'Place Details': 'bg-yellow-100 text-yellow-800',
  'Geocoding': 'bg-orange-100 text-orange-800'
};

export default function GoogleAPILogViewer() {
  const [logs, setLogs] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [stats, setStats] = useState({
    total: 0,
    today: 0,
    byType: {}
  });
  
  // Filters
  const [dateFilter, setDateFilter] = useState('today');
  const [customDateStart, setCustomDateStart] = useState('');
  const [customDateEnd, setCustomDateEnd] = useState('');
  const [apiTypeFilter, setApiTypeFilter] = useState('all');
  const [userFilter, setUserFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  
  // Alerts
  const [alerts, setAlerts] = useState([]);
  const SPIKE_THRESHOLD = 50; // Alert if more than 50 calls in last 5 minutes
  const ERROR_RATE_THRESHOLD = 0.1; // Alert if error rate > 10%

  const loadLogs = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      // Fetch logs sorted by timestamp (newest first), limit to 1000 most recent
      const allLogs = await base44.entities.GoogleAPILog.filter({}, '-timestamp', 1000);
      setLogs(allLogs);

      // Calculate stats
      const today = format(new Date(), 'yyyy-MM-dd');
      const todayLogs = allLogs.filter(log => {
        const logDate = format(new Date(log.timestamp), 'yyyy-MM-dd');
        return logDate === today;
      });

      const byType = {};
      allLogs.forEach(log => {
        byType[log.api_type] = (byType[log.api_type] || 0) + 1;
      });

      setStats({
        total: allLogs.length,
        today: todayLogs.length,
        byType
      });
      
      // Check for alerts
      checkForAlerts(allLogs);
    } catch (error) {
      console.error('Failed to load Google API logs:', error);
    } finally {
      setIsLoading(false);
    }
  };
  
  // Check for unusual activity
  const checkForAlerts = (allLogs) => {
    const newAlerts = [];
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    
    // Check for spike in last 5 minutes
    const recentLogs = allLogs.filter(log => new Date(log.timestamp) >= fiveMinutesAgo);
    if (recentLogs.length > SPIKE_THRESHOLD) {
      newAlerts.push({
        type: 'spike',
        message: `High API call volume: ${recentLogs.length} calls in last 5 minutes`,
        severity: 'warning'
      });
    }
    
    // Check for errors (if metadata contains error info)
    const errorLogs = allLogs.filter(log => log.metadata?.error);
    if (allLogs.length > 0 && errorLogs.length / allLogs.length > ERROR_RATE_THRESHOLD) {
      newAlerts.push({
        type: 'error',
        message: `High error rate: ${Math.round(errorLogs.length / allLogs.length * 100)}%`,
        severity: 'error'
      });
    }
    
    setAlerts(newAlerts);
  };
  
  // Get unique users from logs
  const uniqueUsers = useMemo(() => {
    const users = new Set();
    logs.forEach(log => {
      if (log.user_name) users.add(log.user_name);
    });
    return Array.from(users).sort();
  }, [logs]);
  
  // Filter logs based on current filters
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // Date filter
      const logDate = new Date(log.timestamp);
      let passesDateFilter = true;
      
      if (dateFilter === 'today') {
        passesDateFilter = format(logDate, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
      } else if (dateFilter === 'yesterday') {
        passesDateFilter = format(logDate, 'yyyy-MM-dd') === format(subDays(new Date(), 1), 'yyyy-MM-dd');
      } else if (dateFilter === 'week') {
        passesDateFilter = isWithinInterval(logDate, {
          start: startOfDay(subDays(new Date(), 7)),
          end: endOfDay(new Date())
        });
      } else if (dateFilter === 'custom' && customDateStart && customDateEnd) {
        passesDateFilter = isWithinInterval(logDate, {
          start: startOfDay(new Date(customDateStart)),
          end: endOfDay(new Date(customDateEnd))
        });
      }
      
      // API type filter
      const passesTypeFilter = apiTypeFilter === 'all' || log.api_type === apiTypeFilter;
      
      // User filter
      const passesUserFilter = !userFilter || (log.user_name && log.user_name.toLowerCase().includes(userFilter.toLowerCase()));
      
      return passesDateFilter && passesTypeFilter && passesUserFilter;
    });
  }, [logs, dateFilter, customDateStart, customDateEnd, apiTypeFilter, userFilter]);
  
  // User colors for multi-line chart
  const userColors = [
    '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'
  ];
  
  // Calculate chart data based on date filter and user filter
  const hourlyChartData = useMemo(() => {
    const isAllUsers = !userFilter;
    
    if (dateFilter === 'today' || dateFilter === 'yesterday') {
      // HOURLY VIEW: 00:00 to 23:00 for single day
      const targetDate = dateFilter === 'today' ? new Date() : subDays(new Date(), 1);
      const targetDateStr = format(targetDate, 'yyyy-MM-dd');
      
      const hourlyMap = {};
      // Initialize all 24 hours
      for (let i = 0; i < 24; i++) {
        const hourKey = `${String(i).padStart(2, '0')}:00`;
        hourlyMap[hourKey] = { hour: hourKey, calls: 0 };
        
        // If showing all users, add keys for each user
        if (isAllUsers) {
          uniqueUsers.forEach(user => {
            hourlyMap[hourKey][user] = 0;
          });
        }
      }
      
      // Count calls per hour
      filteredLogs.forEach(log => {
        const logDate = format(new Date(log.timestamp), 'yyyy-MM-dd');
        if (logDate !== targetDateStr) return;
        
        const logHour = format(new Date(log.timestamp), 'HH:00');
        if (hourlyMap[logHour]) {
          hourlyMap[logHour].calls++;
          if (isAllUsers && log.user_name) {
            hourlyMap[logHour][log.user_name] = (hourlyMap[logHour][log.user_name] || 0) + 1;
          }
        }
      });
      
      return Object.values(hourlyMap);
    } else if (dateFilter === 'week') {
      // 6-HOUR DIVISIONS for last 7 days
      const periodMap = {};
      
      // Generate 6-hour periods for last 7 days
      for (let d = 6; d >= 0; d--) {
        const day = subDays(new Date(), d);
        const dayStr = format(day, 'MMM dd');
        
        ['00-06', '06-12', '12-18', '18-24'].forEach(period => {
          const key = `${dayStr} ${period}`;
          periodMap[key] = { hour: key, calls: 0 };
          
          if (isAllUsers) {
            uniqueUsers.forEach(user => {
              periodMap[key][user] = 0;
            });
          }
        });
      }
      
      // Count calls per period
      filteredLogs.forEach(log => {
        const logDate = new Date(log.timestamp);
        const dayStr = format(logDate, 'MMM dd');
        const hour = logDate.getHours();
        
        let period;
        if (hour < 6) period = '00-06';
        else if (hour < 12) period = '06-12';
        else if (hour < 18) period = '12-18';
        else period = '18-24';
        
        const key = `${dayStr} ${period}`;
        if (periodMap[key]) {
          periodMap[key].calls++;
          if (isAllUsers && log.user_name) {
            periodMap[key][log.user_name] = (periodMap[key][log.user_name] || 0) + 1;
          }
        }
      });
      
      return Object.values(periodMap);
    } else {
      // Default: group by day for "all" or custom range
      const dailyMap = {};
      
      filteredLogs.forEach(log => {
        const dayKey = format(new Date(log.timestamp), 'MMM dd');
        if (!dailyMap[dayKey]) {
          dailyMap[dayKey] = { hour: dayKey, calls: 0 };
          if (isAllUsers) {
            uniqueUsers.forEach(user => {
              dailyMap[dayKey][user] = 0;
            });
          }
        }
        dailyMap[dayKey].calls++;
        if (isAllUsers && log.user_name) {
          dailyMap[dayKey][log.user_name] = (dailyMap[dayKey][log.user_name] || 0) + 1;
        }
      });
      
      // Sort by date
      const sortedData = Object.values(dailyMap).sort((a, b) => {
        const dateA = new Date(a.hour + ', 2026');
        const dateB = new Date(b.hour + ', 2026');
        return dateA - dateB;
      });
      
      return sortedData;
    }
  }, [filteredLogs, dateFilter, userFilter, uniqueUsers]);
  
  // Calculate API type distribution for bar chart
  const apiTypeChartData = useMemo(() => {
    const typeMap = {};
    filteredLogs.forEach(log => {
      typeMap[log.api_type] = (typeMap[log.api_type] || 0) + 1;
    });
    return Object.entries(typeMap).map(([name, value]) => ({ name, value }));
  }, [filteredLogs]);
  
  const clearFilters = () => {
    setDateFilter('today');
    setCustomDateStart('');
    setCustomDateEnd('');
    setApiTypeFilter('all');
    setUserFilter('');
  };

  useEffect(() => {
    loadLogs();
    
    // Auto-refresh every 10 seconds to show new API calls in real-time
    const interval = setInterval(() => loadLogs(true), 10000);
    return () => clearInterval(interval);
  }, []);

  const handleClearLogs = async () => {
    if (!window.confirm('Are you sure you want to clear all Google API logs? This cannot be undone.')) {
      return;
    }

    setIsClearing(true);
    try {
      // Delete all logs one at a time with delays to avoid rate limits
      const allLogs = await base44.entities.GoogleAPILog.filter({});
      
      for (let i = 0; i < allLogs.length; i++) {
        await base44.entities.GoogleAPILog.delete(allLogs[i].id);
        // Wait 1 second between each delete to respect rate limits
        if (i < allLogs.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // Reload logs
      await loadLogs();
      alert('All Google API logs have been cleared.');
    } catch (error) {
      console.error('Failed to clear logs:', error);
      alert('Failed to clear logs: ' + (error.message || 'Please try again.'));
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <CardTitle className="text-2xl font-bold text-slate-900">Google API Call Log</CardTitle>
            <p className="text-sm text-slate-600 mt-1">
              Real-time monitoring of Google Maps API calls
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={() => setShowFilters(!showFilters)}
              variant="outline"
              className="gap-2"
            >
              <Filter className="w-4 h-4" />
              Filters
              {(dateFilter !== 'today' || apiTypeFilter !== 'all' || userFilter) && (
                <Badge className="ml-1 bg-blue-500 text-white">Active</Badge>
              )}
            </Button>
            <Button
              onClick={() => loadLogs()}
              disabled={isLoading}
              variant="outline"
              className="gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              onClick={handleClearLogs}
              disabled={isClearing || logs.length === 0}
              variant="destructive"
              className="gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Clear All
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {/* Alerts Banner */}
        {alerts.length > 0 && (
          <div className="mb-6 space-y-2">
            {alerts.map((alert, idx) => (
              <div
                key={idx}
                className={`flex items-center gap-3 p-3 rounded-lg ${
                  alert.severity === 'error' ? 'bg-red-50 border border-red-200' : 'bg-amber-50 border border-amber-200'
                }`}
              >
                <AlertTriangle className={`w-5 h-5 ${alert.severity === 'error' ? 'text-red-600' : 'text-amber-600'}`} />
                <span className={`text-sm font-medium ${alert.severity === 'error' ? 'text-red-800' : 'text-amber-800'}`}>
                  {alert.message}
                </span>
              </div>
            ))}
          </div>
        )}
        
        {/* Filters Panel */}
        {showFilters && (
          <div className="mb-6 p-4 bg-slate-50 rounded-lg border">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-900">Filters</h3>
              <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1 text-slate-600">
                <X className="w-4 h-4" /> Clear All
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">Date Range</label>
                <Select value={dateFilter} onValueChange={setDateFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="yesterday">Yesterday</SelectItem>
                    <SelectItem value="week">Last 7 Days</SelectItem>
                    <SelectItem value="all">All Time</SelectItem>
                    <SelectItem value="custom">Custom Range</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {dateFilter === 'custom' && (
                <>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">Start Date</label>
                    <Input
                      type="date"
                      value={customDateStart}
                      onChange={(e) => setCustomDateStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">End Date</label>
                    <Input
                      type="date"
                      value={customDateEnd}
                      onChange={(e) => setCustomDateEnd(e.target.value)}
                    />
                  </div>
                </>
              )}
              
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">API Type</label>
                <Select value={apiTypeFilter} onValueChange={setApiTypeFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="Directions">Directions</SelectItem>
                    <SelectItem value="Distance Matrix">Distance Matrix</SelectItem>
                    <SelectItem value="Places Autocomplete">Places Autocomplete</SelectItem>
                    <SelectItem value="Place Details">Place Details</SelectItem>
                    <SelectItem value="Geocoding">Geocoding</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">User</label>
                <Select value={userFilter || 'all'} onValueChange={(v) => setUserFilter(v === 'all' ? '' : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Users" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Users</SelectItem>
                    {uniqueUsers.map(user => (
                      <SelectItem key={user} value={user}>{user}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}
        
        {/* Key Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-slate-50 rounded-lg p-4">
            <div className="flex items-center gap-2 text-sm text-slate-600 mb-1">
              <TrendingUp className="w-4 h-4" />
              Total Calls
            </div>
            <div className="text-2xl font-bold text-slate-900">{stats.total}</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="flex items-center gap-2 text-sm text-blue-600 mb-1">
              <Clock className="w-4 h-4" />
              Calls Today
            </div>
            <div className="text-2xl font-bold text-blue-900">{stats.today}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-4">
            <div className="text-sm text-green-600 mb-1">Filtered Results</div>
            <div className="text-2xl font-bold text-green-900">{filteredLogs.length}</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-4">
            <div className="text-sm text-purple-600 mb-1">Unique Users</div>
            <div className="text-2xl font-bold text-purple-900">{uniqueUsers.length}</div>
          </div>
        </div>
        
        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Hourly Call Volume */}
          <div className="bg-white border rounded-lg p-4">
            <h3 className="font-semibold text-slate-900 mb-4">
              {dateFilter === 'today' ? 'Today\'s Call Volume (00:00-23:59)' :
               dateFilter === 'yesterday' ? 'Yesterday\'s Call Volume (00:00-23:59)' :
               dateFilter === 'week' ? 'Last 7 Days Call Volume (6-hour periods)' :
               'Call Volume by Day'}
            </h3>
            <ResponsiveContainer width="100%" height={!userFilter && uniqueUsers.length > 1 ? 280 : 200}>
              <LineChart data={hourlyChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis 
                  dataKey="hour" 
                  tick={{ fontSize: dateFilter === 'week' ? 9 : 11 }} 
                  stroke="#64748b"
                  angle={dateFilter === 'week' ? -45 : 0}
                  textAnchor={dateFilter === 'week' ? 'end' : 'middle'}
                  height={dateFilter === 'week' ? 60 : 30}
                />
                <YAxis tick={{ fontSize: 11 }} stroke="#64748b" />
                <Tooltip
                  contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px' }}
                />
                {/* Show multiple lines for each user when "All Users" is selected */}
                {!userFilter && uniqueUsers.length > 1 ? (
                  <>
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    {/* Total line (thicker, dashed) */}
                    <Line 
                      type="monotone" 
                      dataKey="calls" 
                      name="Total" 
                      stroke="#1e293b" 
                      strokeWidth={3} 
                      strokeDasharray="5 5"
                      dot={false} 
                    />
                    {/* Individual user lines */}
                    {uniqueUsers.slice(0, 10).map((user, idx) => (
                      <Line
                        key={user}
                        type="monotone"
                        dataKey={user}
                        name={user}
                        stroke={userColors[idx % userColors.length]}
                        strokeWidth={2}
                        dot={false}
                      />
                    ))}
                  </>
                ) : (
                  <Line type="monotone" dataKey="calls" stroke="#3b82f6" strokeWidth={2} dot={false} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          
          {/* API Type Distribution */}
          <div className="bg-white border rounded-lg p-4">
            <h3 className="font-semibold text-slate-900 mb-4">Calls by API Type</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={apiTypeChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="#64748b" angle={-20} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} stroke="#64748b" />
                <Tooltip
                  contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px' }}
                />
                <Bar dataKey="value" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        
        {/* API Type Breakdown */}
        <div className="flex flex-wrap gap-2 mb-6">
          {Object.entries(stats.byType).map(([type, count]) => (
            <Badge key={type} className={`${apiTypeColors[type] || 'bg-gray-100 text-gray-800'} px-3 py-1`}>
              {type}: {count}
            </Badge>
          ))}
        </div>

        {/* Logs Table */}
        {isLoading ? (
          <div className="text-center py-8 text-slate-500">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
            Loading logs...
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            {logs.length === 0 ? 'No API calls logged yet.' : 'No logs match the current filters.'}
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Timestamp</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">API Type</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Function</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">User</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((log, index) => {
                    const Icon = apiTypeIcons[log.api_type] || MapPin;
                    return (
                      <tr key={log.id} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                        <td className="p-3 text-sm text-slate-700">
                          {format(new Date(log.timestamp), 'MMM dd, yyyy HH:mm:ss')}
                        </td>
                        <td className="p-3">
                          <Badge className={`${apiTypeColors[log.api_type] || 'bg-gray-100 text-gray-800'} gap-1`}>
                            <Icon className="w-3 h-3" />
                            {log.api_type}
                          </Badge>
                        </td>
                        <td className="p-3 text-sm text-slate-700 max-w-xs truncate" title={log.purpose}>
                          {log.purpose}
                        </td>
                        <td className="p-3 text-xs text-slate-500 font-mono">
                          {log.function_name}
                        </td>
                        <td className="p-3 text-sm text-slate-700">
                          {log.user_name || 'Unknown'}
                        </td>
                        <td className="p-3 text-xs text-slate-600">
                          {log.metadata?.driver_id && (
                            <div>Driver: {log.metadata.driver_id.substring(0, 8)}...</div>
                          )}
                          {log.metadata?.stops_count && (
                            <div>Stops: {log.metadata.stops_count}</div>
                          )}
                          {log.metadata?.route_changed !== undefined && (
                            <div>Changed: {log.metadata.route_changed ? 'Yes' : 'No'}</div>
                          )}
                          {log.metadata?.input && (
                            <div>Search: "{log.metadata.input.substring(0, 30)}..."</div>
                          )}
                          {log.metadata?.place_id && (
                            <div>PlaceID: {log.metadata.place_id.substring(0, 15)}...</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {filteredLogs.length > 0 && (
          <div className="mt-4 text-sm text-slate-500 text-center">
            Showing {filteredLogs.length} of {logs.length} API calls
          </div>
        )}
      </CardContent>
    </Card>
  );
}