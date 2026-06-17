import React, { useState, useEffect, useRef, useCallback } from 'react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Trash2, Settings } from 'lucide-react';
import { ColumnVisibilityControl, ResizableColumnHeader } from './AdminTableControls';

const USER_SETTINGS_COLUMNS = [
  { id: 'user_name', label: 'User', defaultVisible: true, alwaysVisible: true },
  { id: 'device_type', label: 'Device Type', defaultVisible: true },
  { id: 'selected_driver', label: 'Selected Driver', defaultVisible: true },
  { id: 'selected_date', label: 'Selected Date', defaultVisible: true },
  { id: 'show_all_markers', label: 'Show All Markers', defaultVisible: true },
  { id: 'sidebar_width', label: 'Sidebar Width', defaultVisible: true },
  { id: 'theme', label: 'Theme', defaultVisible: true },
  { id: 'created', label: 'Created', defaultVisible: false },
  { id: 'updated', label: 'Updated', defaultVisible: false },
  { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true },
];

const useColumnVisibility = () => {
  const storageKey = 'admin_columns_userSettings';
  const [visibleColumns, setVisibleColumns] = useState(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) { try { return JSON.parse(saved); } catch {} }
    return USER_SETTINGS_COLUMNS.filter(c => c.defaultVisible || c.alwaysVisible).map(c => c.id);
  });
  const toggleColumn = useCallback((columnId) => {
    setVisibleColumns(prev => {
      const next = prev.includes(columnId) ? prev.filter(id => id !== columnId) : [...prev, columnId];
      localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }, []);
  return { visibleColumns, toggleColumn, config: USER_SETTINGS_COLUMNS };
};

export default function UserSettingsTable({ appUsers, mergedUsers }) {
  const [userSettings, setUserSettings] = useState([]);
  const [localUserSettings, setLocalUserSettings] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState('cloud');
  const refreshIntervalRef = useRef(null);
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('userSettings');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_usersettings_column_widths');
    return saved ? JSON.parse(saved) : {
      user_name: 180, device_type: 120, selected_driver: 150, selected_date: 120,
      show_all_markers: 130, sidebar_width: 120, theme: 100, created: 160, updated: 160, actions: 100
    };
  });

  const updateColumnWidth = useCallback((columnId, width) => {
    setColumnWidths((prev) => {
      const newWidths = { ...prev, [columnId]: width };
      localStorage.setItem('admin_usersettings_column_widths', JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const settings = await base44.entities.UserSettings.list();
      setUserSettings(settings || []);
      const { offlineManager } = await import('../../components/utils/offlineManager');
      const localSettings = await offlineManager.getAllCachedUserSettings();
      setLocalUserSettings(localSettings || []);
      return settings || [];
    } catch (error) {
      setUserSettings([]);
      setLocalUserSettings([]);
      return [];
    }
  }, []);

  useEffect(() => {
    const init = async () => { setIsLoading(true); await loadSettings(); setIsLoading(false); };
    init();
  }, [loadSettings]);

  useEffect(() => {
    if (isLoading) return;
    const initialTimeout = setTimeout(async () => {
      const freshSettings = await base44.entities.UserSettings.list().catch(() => null);
      if (freshSettings && freshSettings.length !== userSettings.length) setUserSettings(freshSettings);
    }, 2000);
    refreshIntervalRef.current = setInterval(async () => {
      const freshSettings = await base44.entities.UserSettings.list().catch(() => null);
      if (freshSettings && freshSettings.length !== userSettings.length) setUserSettings(freshSettings);
    }, 15000);
    return () => { clearTimeout(initialTimeout); if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current); };
  }, [isLoading, userSettings]);

  const getUserName = (userId) => {
    if (!userId) return 'Unknown';
    const appUser = appUsers.find((au) => au && au.user_id === userId);
    if (appUser) return appUser.user_name || 'Unknown';
    const user = mergedUsers.find((u) => u && u.id === userId);
    if (user) return user.user_name || 'Unknown';
    return userId.substring(0, 8) + '...';
  };

  const handleDeleteSetting = async (settingId) => {
    if (!window.confirm(`Are you sure you want to delete this ${viewMode === 'cloud' ? 'cloud' : 'local cached'} user setting?`)) return;
    try {
      if (viewMode === 'cloud') {
        await base44.entities.UserSettings.delete(settingId);
        setUserSettings((prev) => prev.filter((s) => s.id !== settingId));
      } else {
        const setting = localUserSettings.find((s) => s.id === settingId || s._cacheId === settingId);
        if (!setting) { alert('Setting not found in local cache.'); return; }
        const { offlineManager } = await import('../../components/utils/offlineManager');
        const cacheId = setting._cacheId || settingId;
        const deleted = await offlineManager.deleteCachedUserSettings(cacheId);
        if (deleted) setLocalUserSettings((prev) => prev.filter((s) => (s._cacheId || s.id) !== cacheId));
        else alert('Failed to delete from local cache.');
      }
    } catch (error) { alert('Failed to delete setting: ' + error.message); }
  };

  const displayedSettings = viewMode === 'cloud' ? userSettings : localUserSettings;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-slate-900)' }}>
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            User Settings
            <Badge variant={viewMode === 'cloud' ? 'default' : 'secondary'}>
              {viewMode === 'cloud' ? 'Cloud' : 'Local'} ({displayedSettings.length})
            </Badge>
          </div>
          <div className="flex gap-2">
            <Button variant={viewMode === 'cloud' ? 'default' : 'outline'} size="sm" onClick={() => setViewMode('cloud')} style={viewMode !== 'cloud' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' } : {}}>Cloud ({userSettings.length})</Button>
            <Button variant={viewMode === 'local' ? 'default' : 'outline'} size="sm" onClick={() => setViewMode('local')} style={viewMode !== 'local' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' } : {}}>Local ({localUserSettings.length})</Button>
            <ColumnVisibilityControl config={config} visibleColumns={visibleColumns} onToggle={toggleColumn} />
          </div>
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-slate-500)' }}>View and manage per-user, per-device settings. Toggle between Cloud (backend) and Local (IndexedDB) storage.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center items-center h-40"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /><span className="ml-2" style={{ color: 'var(--text-slate-600)' }}>Loading user settings...</span></div>
        ) : displayedSettings.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--text-slate-500)' }}>No {viewMode} user settings found.</div>
        ) : (
          <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm table-fixed">
                <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)' }}>
                  <tr>
                    {visibleColumns.includes('user_name') && <ResizableColumnHeader width={columnWidths.user_name} onResize={(w) => updateColumnWidth('user_name', w)}><span className="font-semibold">User</span></ResizableColumnHeader>}
                    {visibleColumns.includes('device_type') && <ResizableColumnHeader width={columnWidths.device_type} onResize={(w) => updateColumnWidth('device_type', w)}><span className="font-semibold">Device Type</span></ResizableColumnHeader>}
                    {visibleColumns.includes('selected_driver') && <ResizableColumnHeader width={columnWidths.selected_driver} onResize={(w) => updateColumnWidth('selected_driver', w)}><span className="font-semibold">Selected Driver</span></ResizableColumnHeader>}
                    {visibleColumns.includes('selected_date') && <ResizableColumnHeader width={columnWidths.selected_date} onResize={(w) => updateColumnWidth('selected_date', w)}><span className="font-semibold">Selected Date</span></ResizableColumnHeader>}
                    {visibleColumns.includes('show_all_markers') && <ResizableColumnHeader width={columnWidths.show_all_markers} onResize={(w) => updateColumnWidth('show_all_markers', w)}><span className="font-semibold">Show All Markers</span></ResizableColumnHeader>}
                    {visibleColumns.includes('sidebar_width') && <ResizableColumnHeader width={columnWidths.sidebar_width} onResize={(w) => updateColumnWidth('sidebar_width', w)}><span className="font-semibold">Sidebar Width</span></ResizableColumnHeader>}
                    {visibleColumns.includes('theme') && <ResizableColumnHeader width={columnWidths.theme} onResize={(w) => updateColumnWidth('theme', w)}><span className="font-semibold">Theme</span></ResizableColumnHeader>}
                    {visibleColumns.includes('created') && <ResizableColumnHeader width={columnWidths.created} onResize={(w) => updateColumnWidth('created', w)}><span className="font-semibold">Created</span></ResizableColumnHeader>}
                    {visibleColumns.includes('updated') && <ResizableColumnHeader width={columnWidths.updated} onResize={(w) => updateColumnWidth('updated', w)}><span className="font-semibold">Updated</span></ResizableColumnHeader>}
                    {visibleColumns.includes('actions') && <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}><span className="font-semibold">Actions</span></ResizableColumnHeader>}
                  </tr>
                </thead>
                <tbody>
                  {[...displayedSettings].sort((a, b) => {
                    const aUpdated = a.updated ? new Date(a.updated).getTime() : 0;
                    const bUpdated = b.updated ? new Date(b.updated).getTime() : 0;
                    if (aUpdated !== bUpdated) return bUpdated - aUpdated;
                    return (b.created ? new Date(b.created).getTime() : 0) - (a.created ? new Date(a.created).getTime() : 0);
                  }).map((setting) => {
                    const selectedDriverName = setting.selected_driver_id ? (setting.selected_driver_id === 'all' ? 'All Drivers' : getUserName(setting.selected_driver_id)) : '-';
                    return (
                      <tr key={setting.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                        {visibleColumns.includes('user_name') && <td className="p-3 font-medium" style={{ color: 'var(--text-slate-900)' }}>{getUserName(setting.user_id)}</td>}
                        {visibleColumns.includes('device_type') && <td className="p-3"><Badge variant={setting.device_type === 'Mobile' ? 'default' : 'secondary'}>{setting.device_type || 'Unknown'}</Badge></td>}
                        {visibleColumns.includes('selected_driver') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{selectedDriverName}</td>}
                        {visibleColumns.includes('selected_date') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{setting.selected_date || '-'}</td>}
                        {visibleColumns.includes('show_all_markers') && <td className="p-3"><Badge variant={setting.show_all_driver_markers ? 'default' : 'secondary'}>{setting.show_all_driver_markers ? '✓ Enabled' : 'Disabled'}</Badge></td>}
                        {visibleColumns.includes('sidebar_width') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{setting.sidebar_width || 240}px</td>}
                        {visibleColumns.includes('theme') && <td className="p-3"><Badge variant="secondary">{setting.theme_preference || 'auto'}</Badge></td>}
                        {visibleColumns.includes('created') && <td className="p-3 text-xs" style={{ color: 'var(--text-slate-600)' }}>{setting.created ? format(new Date(setting.created), 'MMM d, yyyy h:mm a') : '-'}</td>}
                        {visibleColumns.includes('updated') && <td className="p-3 text-xs" style={{ color: 'var(--text-slate-600)' }}>{setting.updated ? format(new Date(setting.updated), 'MMM d, yyyy h:mm a') : '-'}</td>}
                        {visibleColumns.includes('actions') && <td className="p-3"><Button variant="destructive" size="sm" onClick={() => handleDeleteSetting(setting.id)}><Trash2 className="w-4 h-4" /></Button></td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}