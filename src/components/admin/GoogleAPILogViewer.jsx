import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, RefreshCw, MapPin, Navigation, Search, Info } from 'lucide-react';
import { format } from 'date-fns';

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

  const loadLogs = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      // Fetch logs sorted by timestamp (newest first), limit to 500 most recent
      const allLogs = await base44.entities.GoogleAPILog.filter({}, '-timestamp', 500);
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
    } catch (error) {
      console.error('Failed to load Google API logs:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Daily cleanup - delete logs older than today
  const performDailyCleanup = async () => {
    const CLEANUP_KEY = 'googleApiLog_lastCleanup';
    const today = format(new Date(), 'yyyy-MM-dd');
    const lastCleanup = localStorage.getItem(CLEANUP_KEY);
    
    if (lastCleanup === today) return; // Already cleaned today
    
    try {
      const allLogs = await base44.entities.GoogleAPILog.filter({}, '-timestamp', 1000);
      const logsToDelete = allLogs.filter(log => {
        const logDate = format(new Date(log.timestamp), 'yyyy-MM-dd');
        return logDate !== today;
      });
      
      if (logsToDelete.length > 0) {
        console.log(`[GoogleAPILogViewer] Cleaning up ${logsToDelete.length} old logs...`);
        for (const log of logsToDelete) {
          await base44.entities.GoogleAPILog.delete(log.id);
          await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit
        }
        console.log(`[GoogleAPILogViewer] Cleanup complete.`);
      }
      
      localStorage.setItem(CLEANUP_KEY, today);
    } catch (error) {
      console.error('[GoogleAPILogViewer] Daily cleanup failed:', error);
    }
  };

  useEffect(() => {
    loadLogs();
    performDailyCleanup(); // Run daily cleanup on component mount
    
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
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-2xl font-bold text-slate-900">Google API Call Log</CardTitle>
            <p className="text-sm text-slate-600 mt-1">
              Monitor all Google Maps API calls made by the application
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={loadLogs}
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
              Clear All Logs
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {/* Stats Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-slate-50 rounded-lg p-4">
            <div className="text-sm text-slate-600 mb-1">Total API Calls</div>
            <div className="text-2xl font-bold text-slate-900">{stats.total}</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="text-sm text-blue-600 mb-1">Calls Today</div>
            <div className="text-2xl font-bold text-blue-900">{stats.today}</div>
          </div>
          {Object.entries(stats.byType).map(([type, count]) => (
            <div key={type} className="bg-slate-50 rounded-lg p-4">
              <div className="text-sm text-slate-600 mb-1">{type}</div>
              <div className="text-2xl font-bold text-slate-900">{count}</div>
            </div>
          ))}
        </div>

        {/* Logs Table */}
        {isLoading ? (
          <div className="text-center py-8 text-slate-500">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
            Loading logs...
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            No API calls logged yet.
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
                  {logs.map((log, index) => {
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

        {logs.length > 0 && (
          <div className="mt-4 text-sm text-slate-500 text-center">
            Showing {logs.length} most recent API calls
          </div>
        )}
      </CardContent>
    </Card>
  );
}