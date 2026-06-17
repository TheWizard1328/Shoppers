import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { getApiLogCallCount, getApiLogDisplayType, getApiLogProvider, sumApiLogCalls } from '@/components/utils/apiUsageLog';
import { sortStores, sortUsers } from '@/components/utils/sorting';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, RefreshCw, MapPin, Navigation, Search, Info, AlertTriangle, TrendingUp, Clock, Filter, X, Home } from 'lucide-react';
import { format, isWithinInterval, startOfDay, endOfDay, subDays, subHours } from 'date-fns';

const getDateRangeSummaryLabel = (dateFilter) => {
  if (dateFilter === 'hourly') return 'Calls Last Hour';
  if (dateFilter === 'today') return 'Calls Today';
  if (dateFilter === 'yesterday') return 'Calls Yesterday';
  if (dateFilter === 'week') return 'Calls Last 7 Days';
  if (dateFilter === 'custom') return 'Calls in Range';
  return 'Calls All Time';
};
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';

const apiTypeIcons = {
  'Google Directions': Navigation,
  'HERE Directions': Navigation,
  'Google Distance Matrix': MapPin,
  'HERE Distance Matrix': MapPin,
  'Google Places Autocomplete': Search,
  'Google Place Details': Info,
  'Google Geocoding': MapPin,
  'HERE Geocoding': MapPin,
  'HERE Map Tiles': MapPin
};

const apiTypeColors = {
  'Google Directions': 'bg-blue-100 text-blue-800',
  'HERE Directions': 'bg-indigo-100 text-indigo-800',
  'Google Distance Matrix': 'bg-purple-100 text-purple-800',
  'HERE Distance Matrix': 'bg-violet-100 text-violet-800',
  'Google Places Autocomplete': 'bg-green-100 text-green-800',
  'Google Place Details': 'bg-yellow-100 text-yellow-800',
  'Google Geocoding': 'bg-orange-100 text-orange-800',
  'HERE Geocoding': 'bg-cyan-100 text-cyan-800',
  'HERE Map Tiles': 'bg-teal-100 text-teal-800'
};

const renderStopOrderValue = (log) => {
  const stopOrders = log?.metadata?.stop_orders;
  const stopType = String(log?.metadata?.stop_type || '').toLowerCase();
  const includesHome = stopType === 'home' || stopOrders === 'home' || (Array.isArray(stopOrders) && stopOrders.some((value) => String(value).toLowerCase() === 'home'));

  if (includesHome) {
    return <Home className="w-4 h-4 text-slate-600" />;
  }

  if (Array.isArray(stopOrders) && stopOrders.length > 0) {
    return stopOrders.join(', ');
  }

  if (typeof stopOrders === 'number' || typeof stopOrders === 'string') {
    return String(stopOrders);
  }

  return '—';
};

const renderUserName = (log) => {
  const rawUserName = String(log?.user_name || '').trim();
  if (/^Service\s*\(.+\)$/i.test(rawUserName)) {
    return 'Service';
  }
  return rawUserName || 'Unknown';
};

export default function GoogleAPILogViewer() {
  const [logs, setLogs] = useState([]);
  const [users, setUsers] = useState([]);       // all AppUsers
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [stats, setStats] = useState({
    total: 0,
    today: 0,
    byType: {}
  });

  // Filters
  const [dateFilter, setDateFilter] = useState('hourly');
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
      const [allLogs, allUsers, allStores] = await Promise.all([
        base44.entities.GoogleAPILog.filter({}, '-timestamp', 1000),
        base44.entities.AppUser.list(),
        base44.entities.Store.list()
      ]);
      setLogs(allLogs);
      // Store ALL AppUsers (not just drivers) so we can use app_roles for classification
      setUsers(sortUsers(allUsers || []));
      setStores(sortStores(allStores || []));

      // Calculate stats
      const today = format(new Date(), 'yyyy-MM-dd');
      const todayLogs = allLogs.filter((log) => {
        const logDate = format(new Date(log.timestamp), 'yyyy-MM-dd');
        return logDate === today;
      });

      const byType = {};
      allLogs.forEach((log) => {
        const displayType = getApiLogDisplayType(log);
        byType[displayType] = (byType[displayType] || 0) + getApiLogCallCount(log);
      });

      setStats({
        total: sumApiLogCalls(allLogs),
        today: sumApiLogCalls(todayLogs),
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
    const recentLogs = allLogs.filter((log) => new Date(log.timestamp) >= fiveMinutesAgo);
    const recentCallCount = sumApiLogCalls(recentLogs);
    if (recentCallCount > SPIKE_THRESHOLD) {
      newAlerts.push({
        type: 'spike',
        message: `High API call volume: ${recentCallCount} calls in last 5 minutes`,
        severity: 'warning'
      });
    }

    // Check for errors (if metadata contains error info)
    const errorLogs = allLogs.filter((log) => log.metadata?.error);
    const totalCalls = sumApiLogCalls(allLogs);
    const errorCalls = sumApiLogCalls(errorLogs);
    if (totalCalls > 0 && errorCalls / totalCalls > ERROR_RATE_THRESHOLD) {
      newAlerts.push({
        type: 'error',
        message: `High error rate: ${Math.round(errorCalls / totalCalls * 100)}%`,
        severity: 'error'
      });
    }

    setAlerts(newAlerts);
  };

  // Filter logs based on current filters
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // Date filter
      const logDate = new Date(log.timestamp);
      let passesDateFilter = true;

      if (dateFilter === 'hourly') {
        // Last 1 hour from current time
        const oneHourAgo = subHours(new Date(), 1);
        passesDateFilter = logDate >= oneHourAgo;
      } else if (dateFilter === 'today') {
        // Today's calendar day
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
      const passesTypeFilter = apiTypeFilter === 'all' || getApiLogDisplayType(log) === apiTypeFilter;

      // User filter
      const passesUserFilter = !userFilter || log.user_name && log.user_name.toLowerCase().includes(userFilter.toLowerCase());

      return passesDateFilter && passesTypeFilter && passesUserFilter;
    });
  }, [logs, dateFilter, customDateStart, customDateEnd, apiTypeFilter, userFilter]);

  // Get unique users from filtered logs
  const uniqueUsers = useMemo(() => {
    const users = new Set();
    filteredLogs.forEach((log) => {
      if (log.user_name) users.add(log.user_name);
    });
    return Array.from(users).sort();
  }, [filteredLogs]);

  // User colors for multi-line chart
  const userColors = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'];

  // Maps user_name -> AppUser record for role lookups
  const userNameToAppUser = useMemo(() => {
    const map = new Map();
    users.forEach(u => { if (u.user_name) map.set(u.user_name, u); });
    return map;
  }, [users]);

  const legendDriverNames = useMemo(() => {
    const logUserNames = new Set(
      filteredLogs.map((log) => log.user_name).filter(Boolean)
    );
    // All AppUsers present in logs, sorted by sort_order via sortUsers
    const sortedAppUserNames = sortUsers(
      users.filter((user) => user.user_name && logUserNames.has(user.user_name))
    ).map((user) => user.user_name);
    const sortedSet = new Set(sortedAppUserNames);
    // Remaining names not matched to any AppUser (service accounts, etc.) — append alphabetically
    const rest = Array.from(logUserNames).filter(n => !sortedSet.has(n)).sort();
    return [...sortedAppUserNames, ...rest];
  }, [filteredLogs, users]);

  const storeLegendNames = useMemo(() => {
    const logStoreNames = new Set(
      filteredLogs
        .map((log) => log.metadata?.store_name)
        .filter(Boolean)
    );

    return sortStores(
      stores.filter((store) => logStoreNames.has(store.name))
    ).map((store) => store.name);
  }, [filteredLogs, stores]);

  const legendRows = useMemo(() => {
    const firstRow = [
      { key: 'calls', label: 'Total', color: '#1e293b', dashed: true },
      ...legendDriverNames.map((name, idx) => ({
        key: name,
        label: name,
        color: userColors[idx % userColors.length]
      }))
    ];

    const secondRow = storeLegendNames.map((name) => ({
      key: `store-${name}`,
      label: name,
      color: '#94a3b8'
    }));

    return [firstRow, secondRow];
  }, [legendDriverNames, storeLegendNames]);

  // Classify a log into one of the 4 tracked categories
  const getLogCategory = (log) => {
    const apiType = String(log?.api_type || '');
    const t = getApiLogDisplayType(log);
    // Tiles: raw api_type contains "Map Tiles" or display type does
    if (apiType.includes('Map Tiles') || t.includes('Map Tiles')) return 'tiles';
    if (t === 'HERE Directions') return 'here';
    if (t === 'Google Place Details') return 'gpd';
    if (t === 'Google Places Autocomplete') return 'gpa';
    return null;
  };

  // Helper: shorten service user names for display
  const shortUserName = (name) => {
    if (!name) return 'Unknown';
    if (/^Service\s*\(.+\)$/i.test(String(name).trim())) return 'Service';
    return name;
  };

  // Calculate chart data based on date filter and user filter
  const hourlyChartData = useMemo(() => {
    const isAllUsers = !userFilter;

    const addLogToEntry = (entry, log) => {
      const callCount = getApiLogCallCount(log);
      entry.calls += callCount;
      if (isAllUsers && log.user_name) {
        const uName = log.user_name;
        entry[uName] = (entry[uName] || 0) + callCount;
        const cat = getLogCategory(log);
        if (cat) entry[`${uName}__${cat}`] = (entry[`${uName}__${cat}`] || 0) + callCount;
      }
    };

    if (dateFilter === 'hourly') {
      const now = new Date();
      const hourlyMap = {};
      for (let i = 59; i >= 0; i--) {
        const minuteDate = new Date(now.getTime() - i * 60 * 1000);
        const minuteKey = format(minuteDate, 'MMM dd HH:mm');
        hourlyMap[minuteKey] = { hour: format(minuteDate, 'HH:mm'), calls: 0, sortOrder: 59 - i };
        if (isAllUsers) uniqueUsers.forEach((u) => { hourlyMap[minuteKey][u] = 0; });
      }
      filteredLogs.forEach((log) => {
        const minuteKey = format(new Date(log.timestamp), 'MMM dd HH:mm');
        if (hourlyMap[minuteKey]) addLogToEntry(hourlyMap[minuteKey], log);
      });
      return Object.values(hourlyMap).sort((a, b) => a.sortOrder - b.sortOrder);

    } else if (dateFilter === 'today') {
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const hourlyMap = {};
      for (let i = 0; i < 24; i++) {
        const hourKey = `${String(i).padStart(2, '0')}:00`;
        hourlyMap[hourKey] = { hour: hourKey, calls: 0, sortOrder: i };
        if (isAllUsers) uniqueUsers.forEach((u) => { hourlyMap[hourKey][u] = 0; });
      }
      filteredLogs.forEach((log) => {
        const logDate = new Date(log.timestamp);
        if (format(logDate, 'yyyy-MM-dd') !== todayStr) return;
        const hourKey = format(logDate, 'HH:00');
        if (hourlyMap[hourKey]) addLogToEntry(hourlyMap[hourKey], log);
      });
      return Object.values(hourlyMap).sort((a, b) => a.sortOrder - b.sortOrder);

    } else if (dateFilter === 'yesterday') {
      const targetDateStr = format(subDays(new Date(), 1), 'yyyy-MM-dd');
      const hourlyMap = {};
      for (let i = 0; i < 24; i++) {
        const hourKey = `${String(i).padStart(2, '0')}:00`;
        hourlyMap[hourKey] = { hour: hourKey, calls: 0 };
        if (isAllUsers) uniqueUsers.forEach((u) => { hourlyMap[hourKey][u] = 0; });
      }
      filteredLogs.forEach((log) => {
        if (format(new Date(log.timestamp), 'yyyy-MM-dd') !== targetDateStr) return;
        const logHour = format(new Date(log.timestamp), 'HH:00');
        if (hourlyMap[logHour]) addLogToEntry(hourlyMap[logHour], log);
      });
      return Object.values(hourlyMap);

    } else if (dateFilter === 'week') {
      const periodMap = {};
      for (let d = 6; d >= 0; d--) {
        const day = subDays(new Date(), d);
        const dayStr = format(day, 'MMM dd');
        ['00-06', '06-12', '12-18', '18-24'].forEach((period) => {
          const key = `${dayStr} ${period}`;
          periodMap[key] = { hour: key, calls: 0 };
          if (isAllUsers) uniqueUsers.forEach((u) => { periodMap[key][u] = 0; });
        });
      }
      filteredLogs.forEach((log) => {
        const logDate = new Date(log.timestamp);
        const dayStr = format(logDate, 'MMM dd');
        const hour = logDate.getHours();
        const period = hour < 6 ? '00-06' : hour < 12 ? '06-12' : hour < 18 ? '12-18' : '18-24';
        const key = `${dayStr} ${period}`;
        if (periodMap[key]) addLogToEntry(periodMap[key], log);
      });
      return Object.values(periodMap);

    } else {
      const dailyMap = new Map();
      filteredLogs.forEach((log) => {
        const logDate = new Date(log.timestamp);
        const dayKey = format(logDate, 'MMM dd yyyy');
        if (!dailyMap.has(dayKey)) {
          dailyMap.set(dayKey, { hour: format(logDate, 'MMM dd'), calls: 0, sortDate: logDate });
          if (isAllUsers) uniqueUsers.forEach((u) => { dailyMap.get(dayKey)[u] = 0; });
        }
        addLogToEntry(dailyMap.get(dayKey), log);
      });
      return Array.from(dailyMap.values())
        .sort((a, b) => a.sortDate - b.sortDate)
        .map(({ sortDate, ...rest }) => rest);
    }
  }, [filteredLogs, dateFilter, userFilter, uniqueUsers]);

  // Calculate API type distribution for bar chart
  const apiTypeChartData = useMemo(() => {
    const typeMap = {};
    filteredLogs.forEach((log) => {
      const displayType = getApiLogDisplayType(log);
      typeMap[displayType] = (typeMap[displayType] || 0) + getApiLogCallCount(log);
    });
    return Object.entries(typeMap).map(([name, value]) => ({ name, value }));
  }, [filteredLogs]);

  const clearFilters = () => {
    setDateFilter('hourly');
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
    if (!window.confirm('Are you sure you want to clear all maps API logs? This cannot be undone.')) {
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
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Reload logs
      await loadLogs();
      alert('All maps API logs have been cleared.');
    } catch (error) {
      console.error('Failed to clear logs:', error);
      alert('Failed to clear logs: ' + (error.message || 'Please try again.'));
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Card className="mb-6 h-[calc(100vh-12rem)] max-h-[calc(100vh-12rem)] flex flex-col overflow-hidden">
      <CardHeader className="px-6 py-3 flex flex-col space-y-1.5 shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <CardTitle className="text-2xl font-bold text-slate-900">Maps API Usage Log</CardTitle>
            <p className="text-sm text-slate-600 mt-1">
              Real-time monitoring of Google and HERE API usage totals
            </p>
          </div>
          <div className="flex gap-2 flex-wrap items-end">
            <Button
              onClick={() => setShowFilters(!showFilters)}
              variant="outline"
              className="gap-2 md:hidden">
              
              <Filter className="w-4 h-4" />
              Filters
              {(dateFilter !== 'hourly' || apiTypeFilter !== 'all' || userFilter) &&
              <Badge className="ml-1 bg-blue-500 text-white">Active</Badge>
              }
            </Button>
            <div className="hidden md:flex items-end gap-2 flex-wrap">
              <div className="min-w-[170px]">
                <label className="text-xs font-medium text-slate-600 mb-1 block">Date Range</label>
                <Select value={dateFilter} onValueChange={setDateFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hourly">Last Hour</SelectItem>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="yesterday">Yesterday</SelectItem>
                    <SelectItem value="week">Last 7 Days</SelectItem>
                    <SelectItem value="all">All Time</SelectItem>
                    <SelectItem value="custom">Custom Range</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[180px]">
                <label className="text-xs font-medium text-slate-600 mb-1 block">API Type</label>
                <Select value={apiTypeFilter} onValueChange={setApiTypeFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="Google Directions">Google Directions</SelectItem>
                    <SelectItem value="HERE Directions">HERE Directions</SelectItem>
                    <SelectItem value="Google Distance Matrix">Google Distance Matrix</SelectItem>
                    <SelectItem value="HERE Distance Matrix">HERE Distance Matrix</SelectItem>
                    <SelectItem value="Google Places Autocomplete">Google Places Autocomplete</SelectItem>
                    <SelectItem value="Google Place Details">Google Place Details</SelectItem>
                    <SelectItem value="Google Geocoding">Google Geocoding</SelectItem>
                    <SelectItem value="HERE Geocoding">HERE Geocoding</SelectItem>
                    <SelectItem value="HERE Map Tiles">HERE Map Tiles</SelectItem>
                    </SelectContent>
                    </Select>
                    </div>
                    <div className="min-w-[180px]">
                    <label className="text-xs font-medium text-slate-600 mb-1 block">User</label>
                <Select value={userFilter || 'all'} onValueChange={(v) => setUserFilter(v === 'all' ? '' : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Users" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Users</SelectItem>
                    {uniqueUsers.map((user) =>
                    <SelectItem key={user} value={user}>{user}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              onClick={() => loadLogs()}
              disabled={isLoading}
              variant="outline"
              className="gap-2">
              
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              onClick={handleClearLogs}
              disabled={isClearing || logs.length === 0}
              variant="destructive"
              className="gap-2">
              
              <Trash2 className="w-4 h-4" />
              Clear All
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="shrink-0 space-y-6">
          {/* Alerts Banner */}
        {alerts.length > 0 &&
          <div className="mb-6 space-y-2">
            {alerts.map((alert, idx) =>
            <div
              key={idx}
              className={`flex items-center gap-3 p-3 rounded-lg ${
              alert.severity === 'error' ? 'bg-red-50 border border-red-200' : 'bg-amber-50 border border-amber-200'}`
              }>
              
                <AlertTriangle className={`w-5 h-5 ${alert.severity === 'error' ? 'text-red-600' : 'text-amber-600'}`} />
                <span className={`text-sm font-medium ${alert.severity === 'error' ? 'text-red-800' : 'text-amber-800'}`}>
                  {alert.message}
                </span>
              </div>
            )}
          </div>
          }
        
        {/* Filters Panel */}
        {showFilters &&
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
                    <SelectItem value="hourly">Last Hour</SelectItem>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="yesterday">Yesterday</SelectItem>
                    <SelectItem value="week">Last 7 Days</SelectItem>
                    <SelectItem value="all">All Time</SelectItem>
                    <SelectItem value="custom">Custom Range</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {dateFilter === 'custom' &&
              <>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">Start Date</label>
                    <Input
                    type="date"
                    value={customDateStart}
                    onChange={(e) => setCustomDateStart(e.target.value)} />
                  
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">End Date</label>
                    <Input
                    type="date"
                    value={customDateEnd}
                    onChange={(e) => setCustomDateEnd(e.target.value)} />
                  
                  </div>
                </>
              }
              
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1 block">API Type</label>
                <Select value={apiTypeFilter} onValueChange={setApiTypeFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="Google Directions">Google Directions</SelectItem>
                    <SelectItem value="HERE Directions">HERE Directions</SelectItem>
                    <SelectItem value="Google Distance Matrix">Google Distance Matrix</SelectItem>
                    <SelectItem value="HERE Distance Matrix">HERE Distance Matrix</SelectItem>
                    <SelectItem value="Google Places Autocomplete">Google Places Autocomplete</SelectItem>
                    <SelectItem value="Google Place Details">Google Place Details</SelectItem>
                    <SelectItem value="Google Geocoding">Google Geocoding</SelectItem>
                    <SelectItem value="HERE Geocoding">HERE Geocoding</SelectItem>
                    <SelectItem value="HERE Map Tiles">HERE Map Tiles</SelectItem>
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
                    {uniqueUsers.map((user) =>
                    <SelectItem key={user} value={user}>{user}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          }
        
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
              {getDateRangeSummaryLabel(dateFilter)}
            </div>
            <div className="text-2xl font-bold text-blue-900">{sumApiLogCalls(filteredLogs)}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-4">
            <div className="text-sm text-green-600 mb-1">Filtered Calls</div>
            <div className="text-2xl font-bold text-green-900">{sumApiLogCalls(filteredLogs)}</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-4">
            <div className="text-sm text-purple-600 mb-1">Unique Users</div>
            <div className="text-2xl font-bold text-purple-900">
              {new Set(filteredLogs.map(l => l.user_name).filter(Boolean)).size}
            </div>
          </div>
        </div>
        
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Hourly Call Volume */}
          <div className="bg-white border rounded-lg p-4">
            <h3 className="font-semibold text-slate-900 mb-4">
              {dateFilter === 'hourly' ? 'Last Hour Call Volume' :
                dateFilter === 'today' ? 'Today\'s Call Volume' :
                dateFilter === 'yesterday' ? 'Yesterday\'s Call Volume (00:00-23:59)' :
                dateFilter === 'week' ? 'Last 7 Days Call Volume (6-hour periods)' :
                'Call Volume by Day'}
            </h3>
            <div className="relative">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={hourlyChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="hour"
                  tick={{ fontSize: dateFilter === 'week' ? 9 : dateFilter === 'hourly' ? 10 : 11 }}
                  stroke="#64748b"
                  angle={dateFilter === 'week' ? -45 : dateFilter === 'hourly' ? -30 : 0}
                  textAnchor={dateFilter === 'week' || dateFilter === 'hourly' ? 'end' : 'middle'}
                  height={dateFilter === 'week' ? 60 : dateFilter === 'hourly' ? 45 : 30} />
                <YAxis tick={{ fontSize: 11 }} stroke="#64748b" />
                <Tooltip
                  wrapperStyle={{ zIndex: 9999, top: 190, left: '50%', transform: 'translateX(-50%)', width: 'max-content', position: 'absolute' }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null;
                    const dataPoint = payload[0]?.payload || {};
                    // Left = has 'driver' role (including admin+driver); Right = dispatchers/stores/service/unrecognized
                    const isDriver = (n) => {
                      const au = userNameToAppUser.get(n);
                      if (!au) return false;
                      return (au.app_roles || []).includes('driver');
                    };
                    const allUserNames = legendDriverNames.filter(n => dataPoint[n] !== undefined);
                    const leftNames = allUserNames.filter(n => isDriver(n));
                    const rightNames = allUserNames.filter(n => !isDriver(n));

                    const CAT_COLORS = { here: '#4f46e5', gpd: '#0891b2', gpa: '#059669', tiles: '#94a3b8' };
                    const colW = 34;
                    const gridStyle = { display: 'grid', gridTemplateColumns: `auto ${colW}px ${colW}px ${colW}px ${colW}px ${colW}px`, gap: '3px 6px', alignItems: 'center' };
                    const hdrCell = (txt, color) => (
                      <span style={{ fontSize: 10, color: color || '#94a3b8', fontWeight: 700, textAlign: 'center', display: 'block' }}>{txt}</span>
                    );
                    const valCell = (val, color) => (
                      <span style={{ fontSize: 11, fontWeight: 600, color, textAlign: 'center', display: 'block' }}>{val}</span>
                    );
                    const renderBlock = (names) => (
                      <div style={gridStyle}>
                        {/* header */}
                        <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700 }}>User</span>
                        {hdrCell('HERE', CAT_COLORS.here)}
                        {hdrCell('GPD',  CAT_COLORS.gpd)}
                        {hdrCell('GPA',  CAT_COLORS.gpa)}
                        {hdrCell('Tiles',CAT_COLORS.tiles)}
                        {hdrCell('Total','#475569')}
                        {/* rows */}
                        {names.map((name, idx) => {
                          const color = userColors[legendDriverNames.indexOf(name) % userColors.length];
                          const here  = dataPoint[`${name}__here`]  || 0;
                          const gpd   = dataPoint[`${name}__gpd`]   || 0;
                          const gpa   = dataPoint[`${name}__gpa`]   || 0;
                          const tiles = dataPoint[`${name}__tiles`] || 0;
                          const total = dataPoint[name] || 0;
                          return (
                            <React.Fragment key={name}>
                              <span style={{ color, fontWeight: 500, fontSize: 11, whiteSpace: 'nowrap' }}>{shortUserName(name)}</span>
                              {valCell(here,  CAT_COLORS.here)}
                              {valCell(gpd,   CAT_COLORS.gpd)}
                              {valCell(gpa,   CAT_COLORS.gpa)}
                              {valCell(tiles, CAT_COLORS.tiles)}
                              <span style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', textAlign: 'center', display: 'block' }}>{total}</span>
                            </React.Fragment>
                          );
                        })}
                      </div>
                    );

                    const grandTotal = dataPoint.calls || 0;
                    const hasUsers = leftNames.length > 0 || rightNames.length > 0;
                    return (
                      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px 12px', zIndex: 9999, boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 24 }}>
                          <span style={{ fontWeight: 700, fontSize: 12, color: '#0f172a' }}>{label}</span>
                          <span style={{ fontWeight: 600, fontSize: 12, color: '#0f172a' }}>Total: {grandTotal}</span>
                        </div>
                        {hasUsers && (
                          <div style={{ display: 'flex', gap: 14 }}>
                            {leftNames.length > 0 && renderBlock(leftNames)}
                            {leftNames.length > 0 && rightNames.length > 0 && <div style={{ width: 1, background: '#e2e8f0', flexShrink: 0 }} />}
                            {rightNames.length > 0 && renderBlock(rightNames)}
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {/* One line per user */}
                {uniqueUsers.length > 1 ? (
                  <>
                    <Line type="monotone" dataKey="calls" name="Total" stroke="#1e293b" strokeWidth={3} strokeDasharray="5 5" dot={false} />
                    {uniqueUsers.slice(0, 10).map((user, idx) => (
                      <Line
                        key={user}
                        type="monotone"
                        dataKey={user}
                        name={user}
                        stroke={userColors[idx % userColors.length]}
                        strokeWidth={2}
                        dot={false} />
                    ))}
                  </>
                ) : (
                  <Line type="monotone" dataKey="calls" stroke="#3b82f6" strokeWidth={2} dot={false} />
                )}
              </LineChart>
            </ResponsiveContainer>
            </div>{/* end relative wrapper */}

            {/* Legend — below the chart and X-axis */}
            {uniqueUsers.length > 0 && (() => {
              const isDriver = (n) => {
                const au = userNameToAppUser.get(n);
                if (!au) return false;
                return (au.app_roles || []).includes('driver');
              };
              const row1 = legendDriverNames.filter(n => isDriver(n));
              const row2 = legendDriverNames.filter(n => !isDriver(n));
              const renderItem = (name) => {
                const idx = legendDriverNames.indexOf(name);
                return (
                  <div key={name} className="flex items-center gap-1.5 min-w-0">
                    <span className="block h-0.5 w-5 flex-shrink-0 rounded-full" style={{ background: userColors[idx % userColors.length] }} />
                    <span className="truncate">{shortUserName(name)}</span>
                  </div>
                );
              };
              return (
                <div className="mt-2 space-y-1 text-xs text-slate-600">
                  {row1.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1">{row1.map(renderItem)}</div>}
                  {row2.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1">{row2.map(renderItem)}</div>}
                </div>
              );
            })()}

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
                    contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px' }} />
                  
                <Bar dataKey="value" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        
        {/* API Type Breakdown */}
        <div className="flex flex-wrap gap-2 mb-6">
          {apiTypeChartData.map(({ name, value }) =>
            <Badge key={name} className={`${apiTypeColors[name] || 'bg-gray-100 text-gray-800'} px-3 py-1`}>
              {name}: {value}
            </Badge>
            )}
        </div>

        {/* Logs Table */}
        {isLoading ?
          <div className="text-center py-8 text-slate-500">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
            Loading logs...
          </div> :
          filteredLogs.length === 0 ?
          <div className="text-center py-8 text-slate-500">
            {logs.length === 0 ? 'No API calls logged yet.' : 'No logs match the current filters.'}
          </div> :

          <div className="border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Timestamp</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">API Type</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Function</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">User</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Stop Order</th>
                    <th className="text-left p-3 text-sm font-semibold text-slate-700">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((log, index) => {
                    const displayType = getApiLogDisplayType(log);
                    const provider = getApiLogProvider(log);
                    const Icon = apiTypeIcons[displayType] || MapPin;
                    return (
                      <tr key={log.id} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                        <td className="p-3 text-sm text-slate-700">
                          {format(new Date(log.timestamp), 'MMM dd, yyyy HH:mm:ss')}
                        </td>
                        <td className="p-3">
                          <Badge className={`${apiTypeColors[displayType] || 'bg-gray-100 text-gray-800'} gap-1`}>
                            <Icon className="w-3 h-3" />
                            {displayType}
                          </Badge>
                        </td>
                        <td className="p-3 text-sm text-slate-700 max-w-xs truncate" title={log.purpose}>
                          {log.purpose}
                        </td>
                        <td className="p-3 text-xs text-slate-500 font-mono">
                          {log.function_name}
                        </td>
                        <td className="p-3 text-sm text-slate-700">
                          {renderUserName(log)}
                        </td>
                        <td className="p-3 text-sm text-slate-700">
                          <div className="flex items-center gap-2">
                            {renderStopOrderValue(log)}
                          </div>
                        </td>
                        <td className="p-3 text-xs text-slate-600">
                          <div>Provider: {provider === 'here' ? 'HERE' : 'Google'}</div>
                          <div>Calls: {getApiLogCallCount(log)}{typeof log.metadata?.stops_count === 'number' ? ` Stops: ${log.metadata.stops_count}` : ''}</div>
                        </td>
                      </tr>);

                  })}
                </tbody>
              </table>
            </div>
          </div>
          }

          {filteredLogs.length > 0 &&
          <div className="text-sm text-slate-500 text-center pb-1">
              Showing {filteredLogs.length} log entries totaling {sumApiLogCalls(filteredLogs)} API calls
            </div>
          }
        </div>
      </CardContent>
    </Card>);

}