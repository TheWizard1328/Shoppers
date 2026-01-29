import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { User } from '@/entities/User';
import { AppUser } from '@/entities/AppUser';
import { Delivery } from '@/entities/Delivery';
// import { ActiveDeliveries } from '@/entities/ActiveDeliveries'; // This entity doesn't exist
import { City } from '@/entities/City';
import { Store } from '@/entities/Store';
import { Patient } from '@/entities/Patient';
import { UserSettings } from '@/entities/UserSettings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { RefreshCw, Users, Loader2, AlertCircle, ArrowUpDown, Edit, Trash2, Database, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { getEffectiveUser } from '@/components/utils/auth';
import { isAppOwner, userHasRole } from '../components/utils/userRoles';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { mergeUsersWithAppUsers } from '../components/utils/driverUtils';
import { sortUsers } from '../components/utils/sorting';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parse, parseISO } from 'date-fns';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useAppData } from '../components/utils/AppDataContext';
import { findFuzzyMatch, normalizeText } from '../components/utils/fuzzyMatching';
import { smartRefreshManager } from '../components/utils/smartRefreshManager';
import { base44 } from '@/api/base44Client';
import AppSettingsPanel from '../components/admin/AppSettingsPanel';
import { loadUserSettings, saveSetting } from '../components/utils/userSettingsManager';
import DeliveryForm from '../components/deliveries/DeliveryForm';
import MessageRulesManager from '../components/admin/MessageRulesManager';
import PolylineViewer from '../components/admin/PolylineViewer';
import GoogleAPILogViewer from '../components/admin/GoogleAPILogViewer';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';
import StoreMetricsPanel from '../components/admin/StoreMetricsPanel';

// Custom Confirmation Dialog Component
const ConfirmationDialog = ({ open, onOpenChange, title, description, onConfirm, confirmText = "Delete", variant = "destructive" }) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-600" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-base pt-2">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant={variant}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// --- Updated RouteImport component with fuzzy matching ---
const RouteImport = ({ onImportComplete, onCancel, stores, drivers, allUsers, currentUser, allDeliveries }) => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [csvFile, setCSVFile] = useState(null);

  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (file) {
      setCSVFile(file);
      setStatus(`File selected: ${file.name}`);
    }
  };

  const handleImport = async () => {
    if (!csvFile) {
      alert('Please select a CSV file first');
      return;
    }

    setLoading(true);
    setStatus('Reading CSV file...');

    try {
      const text = await csvFile.text();
      const lines = text.split('\n').filter(line => line.trim());
      
      if (lines.length < 2) {
        throw new Error("CSV file is empty or only contains a header.");
      }

      setStatus(`Processing ${lines.length - 1} rows...`);
      
      const { offlineDB } = await import('../components/utils/offlineDatabase');
      const allPatients = await Patient.list();
      
      // CRITICAL: Extract unique delivery dates from CSV for purge/resync
      const uniqueDeliveryDates = new Set();
      for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',').map(cell => cell.trim());
        const deliveryDateStr = row[6]; // Assuming delivery_date is in column 7 (index 6)
        if (deliveryDateStr) {
          const parsedDate = parseFlexibleDate(deliveryDateStr);
          if (parsedDate) {
            uniqueDeliveryDates.add(format(parsedDate, 'yyyy-MM-dd'));
          }
        }
      }

      console.log(`🔍 [RouteImport] Unique delivery dates in CSV:`, Array.from(uniqueDeliveryDates));

      // CRITICAL: Daily Purge and Resync for ALL imported dates (not just mismatches)
      for (const dateStr of Array.from(uniqueDeliveryDates)) {
        setStatus(`Purging and resyncing ${dateStr}...`);
        
        // CRITICAL: Always purge and resync to ensure consistency, regardless of count match
        // This prevents stale/duplicate data from the importer from accumulating
        const deleteResult = await offlineDB.deleteDeliveriesByDate(dateStr);
        console.log(`[RouteImport] Delete result for ${dateStr}:`, deleteResult);

        // Fetch fresh data from online DB
        const onlineDeliveriesForDate = await Delivery.filter({ delivery_date: dateStr });
        console.log(`[RouteImport] Fetched ${onlineDeliveriesForDate.length} deliveries from online for ${dateStr}`);

        // Resync to offline DB
        const saveResult = await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, onlineDeliveriesForDate);
        console.log(`[RouteImport] Save result for ${dateStr}:`, saveResult);
        
        // Verify the resync worked
        const verifyOfflineCount = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
        console.log(`✅ [RouteImport] Verified ${verifyOfflineCount.length} deliveries in offline DB for ${dateStr}`);
      }
      
      let exactMatched = 0;
      let fuzzyMatched = 0;
      let skipped = 0;
      let errors = 0;

      for (let i = 1; i < lines.length; i++) { // i=1 skips header automatically, don't count it
        const row = lines[i].split(',').map(cell => cell.trim());
        
        if (row.length < 2) {
          console.warn(`Skipping row ${i} due to insufficient columns:`, lines[i]);
          errors++;
          continue;
        }

        const ampmIndicator = row[1];
        const ampm = ampmIndicator === '1' ? 'AM' : ampmIndicator === '2' ? 'PM' : null;
        
        if (!ampm) {
          console.warn(`Skipping row ${i} due to invalid AM/PM indicator:`, ampmIndicator);
          skipped++;
          continue;
        }
        
        try {
          const identifier = row[0];
          
          if (!identifier) {
            console.warn(`Skipping row ${i} due to missing identifier`);
            skipped++;
            continue;
          }
          
          // STEP 1: Try EXACT MATCH (use refreshed data from offline DB after purge/resync)
          const currentOfflineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
          const exactMatch = (currentOfflineDeliveries || []).find(d => 
            (d.stop_id && normalizeText(d.stop_id) === normalizeText(identifier)) || 
            (d.tracking_number && normalizeText(d.tracking_number) === normalizeText(identifier))
          );
          
          if (exactMatch) {
            const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
            await updateDeliveryLocal(exactMatch.id, { ampm_deliveries: ampm });
            exactMatched++;
            console.log(`✅ EXACT MATCH: Updated delivery ${identifier} with AM/PM: ${ampm}`);
            continue;
          }
          
          // STEP 2: Try FUZZY MATCHING
          const importedData = {
            stop_id: identifier,
            tracking_number: row[2] || null,
            patient_name: row[3] || null,
            address: row[4] || null,
            phone: row[5] || null,
            delivery_date: row[6] || null,
            actual_delivery_time: row[7] || null,
            store_id: row[8] || null,
            prescription_number: row[9] || null,
            driver_name: row[10] || null
          };
          
          let candidateDeliveries = currentOfflineDeliveries || [];
          if (importedData.delivery_date) {
            const parsedImportDate = parseFlexibleDate(importedData.delivery_date);
            if (parsedImportDate) {
              const formattedImportDate = format(parsedImportDate, 'yyyy-MM-dd');
              candidateDeliveries = candidateDeliveries.filter(d => 
                d.delivery_date && d.delivery_date === formattedImportDate
              );
            }
          }
          
          if (candidateDeliveries.length > 0 && (importedData.patient_name || importedData.address || importedData.phone)) {
            const fuzzyResult = findFuzzyMatch(importedData, candidateDeliveries, allPatients);
            
            if (fuzzyResult) {
              console.log(`🔍 FUZZY MATCH: Row ${i} - Score: ${fuzzyResult.score}, Tier: ${fuzzyResult.tier}`);
              console.log(`   Details: ${fuzzyResult.details.join(', ')}`);
            }
            
            if (fuzzyResult && (fuzzyResult.tier === 'strong' || fuzzyResult.tier === 'moderate')) {
              const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
              await updateDeliveryLocal(fuzzyResult.match.id, { ampm_deliveries: ampm });
              fuzzyMatched++;
              console.log(`✅ FUZZY MATCH (${fuzzyResult.tier.toUpperCase()}, score: ${fuzzyResult.score}): Updated delivery ${fuzzyResult.match.id} with AM/PM: ${ampm}`);
              continue;
            }
          }
          
          // STEP 3: No match found - Skip
           console.warn(`⚠️ NO MATCH: No suitable match for identifier ${identifier}`);
           skipped++;

          } catch (error) {
           console.error(`Error processing row ${i}:`, error);
           errors++;
          }
          }

      // Final deduplication after all imports are processed
      setStatus(`Running final deduplication...`);
      const deduplicateResult = await offlineDB.deduplicateDeliveries();
      if (deduplicateResult.success) {
        console.log(`✅ [RouteImport] Deduplication complete. Removed ${deduplicateResult.removed} duplicates.`);
        setStatus(`✅ Import complete! Exact: ${exactMatched}, Fuzzy: ${fuzzyMatched}, Skipped: ${skipped}, Errors: ${errors}. Deduplicated: ${deduplicateResult.removed}.`);
      } else {
        console.error('❌ [RouteImport] Deduplication failed:', deduplicateResult.error);
        setStatus(`✅ Import complete! Exact: ${exactMatched}, Fuzzy: ${fuzzyMatched}, Skipped: ${skipped}, Errors: ${errors}. Deduplication failed.`);
      }

      setLoading(false);
      
      setTimeout(() => {
        onImportComplete();
      }, 1500);
      
    } catch (error) {
      console.error('Import error:', error);
      setStatus(`❌ Import failed: ${error.message}`);
      setLoading(false);
    }
  };

  const parseFlexibleDate = (dateString) => {
    if (!dateString || typeof dateString !== 'string') return null;

    let date = parseISO(dateString);
    if (!isNaN(date.getTime())) return date;

    date = parse(dateString, 'M/d/yyyy', new Date());
    if (!isNaN(date.getTime())) return date;

    date = parse(dateString, 'MM/dd/yyyy', new Date());
    if (!isNaN(date.getTime())) return date;

    return null;
  };

  return (
    <Dialog open={true} onOpenChange={onCancel}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import AM/PM Designations</DialogTitle>
          <DialogDescription>
            Upload a CSV file to update delivery AM/PM designations. Uses exact matching (SID/TR#) and fuzzy matching when needed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            type="file"
            accept=".csv"
            onChange={handleFileUpload}
            disabled={loading}
          />
          <div className="text-xs text-slate-600 bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="font-semibold mb-1">CSV Format:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Column 1: Stop ID (SID) or Tracking Number (TR#)</li>
              <li>Column 2: AM/PM indicator (1 = AM, 2 = PM)</li>
              <li>First row is treated as header and will be skipped</li>
            </ul>
          </div>
          <p className="text-sm text-slate-600">
            {status || "Select a CSV file to begin import."}
          </p>
          {loading && <Loader2 className="h-6 w-6 animate-spin mx-auto text-emerald-500" />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={loading || !csvFile}>
            {loading ? 'Importing...' : 'Import AM/PM Data'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const COLUMN_CONFIGS = {
  deliveries: [
    { id: 'date', label: 'Date / Time', defaultVisible: true },
    { id: 'order', label: 'Order', defaultVisible: true },
    { id: 'sid_pid', label: 'SID / PID', defaultVisible: true },
    { id: 'tracking', label: 'TR#', defaultVisible: true },
    { id: 'delivery_to', label: 'Delivery To', defaultVisible: true },
    { id: 'driver', label: 'Driver', defaultVisible: true },
    { id: 'status', label: 'Status', defaultVisible: true },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true }
  ],
  patients: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'full_name', label: 'Full Name', defaultVisible: true },
    { id: 'patient_id', label: 'PID', defaultVisible: true },
    { id: 'phone', label: 'Phone', defaultVisible: true },
    { id: 'address', label: 'Address', defaultVisible: true },
    { id: 'unit', label: 'Unit', defaultVisible: false },
    { id: 'store', label: 'Store', defaultVisible: true },
    { id: 'last_delivery_date', label: 'Last Delivery', defaultVisible: true },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true }
  ],
  stores: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'name', label: 'Name', defaultVisible: true },
    { id: 'abbreviation', label: 'Abbr', defaultVisible: true },
    { id: 'address', label: 'Address', defaultVisible: true },
    { id: 'phone', label: 'Phone', defaultVisible: true },
    { id: 'city', label: 'City', defaultVisible: false },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true }
  ],
  users: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'user_name', label: 'User Name', defaultVisible: true },
    { id: 'phone', label: 'Phone', defaultVisible: true },
    { id: 'roles', label: 'Roles', defaultVisible: true },
    { id: 'status', label: 'Status', defaultVisible: true },
    { id: 'location_tracking', label: 'Location Tracking', defaultVisible: true },
    { id: 'home_coords', label: 'Home Coords', defaultVisible: false },
    { id: 'current_coords', label: 'Current Coords', defaultVisible: false },
    { id: 'city', label: 'City', defaultVisible: false },
    { id: 'stores', label: 'Stores', defaultVisible: false },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true }
  ],
  cities: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'name', label: 'Name', defaultVisible: true },
    { id: 'province', label: 'Province/State', defaultVisible: true },
    { id: 'country', label: 'Country', defaultVisible: true },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true }
  ],
  userSettings: [
    { id: 'user_name', label: 'User', defaultVisible: true, alwaysVisible: true },
    { id: 'device_type', label: 'Device Type', defaultVisible: true },
    { id: 'selected_driver', label: 'Selected Driver', defaultVisible: true },
    { id: 'selected_date', label: 'Selected Date', defaultVisible: true },
    { id: 'sidebar_width', label: 'Sidebar Width', defaultVisible: true },
    { id: 'theme', label: 'Theme', defaultVisible: true },
    { id: 'created', label: 'Created', defaultVisible: false },
    { id: 'updated', label: 'Updated', defaultVisible: false },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true }
  ]
};

const useColumnVisibility = (entityType) => {
  const storageKey = `admin_columns_${entityType}`;
  const config = COLUMN_CONFIGS[entityType] || [];

  const [visibleColumns, setVisibleColumns] = useState(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse column visibility from localStorage:', e);
      }
    }
    return config.filter(c => c.defaultVisible || c.alwaysVisible).map(c => c.id);
  });

  const toggleColumn = useCallback((columnId) => {
    setVisibleColumns(prev => {
      const newVisible = prev.includes(columnId)
        ? prev.filter(id => id !== columnId)
        : [...prev, columnId];
      localStorage.setItem(storageKey, JSON.stringify(newVisible));
      return newVisible;
    });
  }, [storageKey]);

  return { visibleColumns, toggleColumn, config };
};

const ResizableColumnHeader = ({ children, onResize, width, minWidth = 80 }) => {
  const [isResizing, setIsResizing] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startWidth, setStartWidth] = useState(width);

  const handleMouseDown = (e) => {
    e.preventDefault();
    setIsResizing(true);
    setStartX(e.clientX);
    setStartWidth(width);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(minWidth, startWidth + delta);
      onResize(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, startX, startWidth, minWidth, onResize]);

  return (
    <th className="relative p-2 text-left group" style={{ width: `${width}px`, minWidth: `${minWidth}px`, maxWidth: `${width}px` }}>
      {children}
      <div
        className="absolute right-0 top-0 bottom-0 w-1 bg-transparent hover:bg-emerald-300 transition-colors cursor-col-resize z-10"
        onMouseDown={handleMouseDown}
        style={{ userSelect: 'none' }}
      />
    </th>
  );
};

const ColumnVisibilityControl = ({ config, visibleColumns, onToggle }) => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          <Settings className="w-4 h-4" />
          Columns ({visibleColumns.length}/{config.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="end" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <div className="space-y-2">
          <h4 className="font-semibold text-sm mb-3 px-1" style={{ color: 'var(--text-slate-900)' }}>Toggle Columns</h4>
          {config.map(column => (
            <div key={column.id} className="flex items-center gap-2 p-1 rounded-sm" style={{ ':hover': { background: 'var(--bg-slate-50)' } }}>
              <Checkbox
                id={`column-${column.id}`}
                checked={visibleColumns.includes(column.id)}
                onCheckedChange={() => !column.alwaysVisible && onToggle(column.id)}
                disabled={column.alwaysVisible}
              />
              <label
                htmlFor={`column-${column.id}`}
                className="text-sm cursor-pointer"
                style={{ color: column.alwaysVisible ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}
              >
                {column.label}
                {column.alwaysVisible && ' (required)'}
              </label>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const getData = async (entityName, sortKey) => {
  let data = [];
  console.log(`📥 [getData] Fetching ${entityName}...`);
  try {
    switch (entityName) {
      case 'Patient':
        data = await Patient.list();
        break;
      case 'Store':
        data = await Store.list();
        break;
      case 'User':
        data = await User.list();
        break;
      case 'AppUser':
        data = await AppUser.list();
        break;
      case 'Delivery':
        console.log(`📥 [getData] Calling Delivery.list()...`);
        data = await Delivery.list();
        console.log(`📥 [getData] Delivery.list() returned ${data?.length || 0} records`);
        break;
      case 'City':
        data = await City.list();
        break;
      default:
        data = [];
    }
    console.log(`✅ [getData] ${entityName}: ${data?.length || 0} records fetched`);
  } catch (error) {
    console.error(`❌ [getData] Error fetching ${entityName} data:`, error);
    data = [];
  }

  if (!Array.isArray(data)) {
    console.warn(`[getData] ${entityName} data is not an array, returning empty array`);
    return [];
  }

  if (sortKey && data.length > 0) {
    const isDesc = sortKey.startsWith('-');
    const actualKey = isDesc ? sortKey.substring(1) : sortKey;
    data.sort((a, b) => {
      const aVal = a[actualKey];
      const bVal = b[actualKey];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return isDesc ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
      }
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return isDesc ? bVal - aVal : aVal - bVal;
      }
      return 0;
    });
  }
  return data;
};

const parseFlexibleDate = (dateString) => {
  if (!dateString || typeof dateString !== 'string') return null;

  let date = parseISO(dateString);
  if (!isNaN(date.getTime())) return date;

  date = parse(dateString, 'M/d/yyyy', new Date());
  if (!isNaN(date.getTime())) return date;

  date = parse(dateString, 'MM/dd/yyyy', new Date());
  if (!isNaN(date.getTime())) return date;

  return null;
};

const DeliveryDataTable = ({
  deliveries, patients, stores, drivers, onEdit, onDelete, onDeleteAll, onDeleteSelected,
  filterText, onFilterChange, sortColumn, sortDirection, onSortChange,
  isLoadingData,
  selectedYear, onYearChange, availableYears,
  selectedMonth, onMonthChange,
  selectedDriver, onDriverChange,
  onFindDuplicates,
  autoSelectIds = [],
  duplicateFilterMode = false,
  onAutoSelectProcessed,
  onClearDuplicateFilter
}) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('deliveries');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_delivery_column_widths');
    return saved ? JSON.parse(saved) : {
      checkbox: 50,
      date: 150,
      order: 80,
      sid_pid: 120,
      tracking: 100,
      delivery_to: 250,
      driver: 120,
      status: 120,
      actions: 150
    };
  });

  const [selectedDeliveries, setSelectedDeliveries] = useState(new Set());
  const [editingDriverId, setEditingDriverId] = useState(null);
  const [editingStatusId, setEditingStatusId] = useState(null);

  const updateColumnWidth = useCallback((columnId, width) => {
    setColumnWidths(prev => {
      const newWidths = { ...prev, [columnId]: width };
      localStorage.setItem('admin_delivery_column_widths', JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const handleStatusChange = async (delivery, newStatus) => {
    try {
      const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
      await updateDeliveryLocal(delivery.id, { status: newStatus });
      setEditingStatusId(null);
      await onSortChange(); // Trigger refresh
    } catch (error) {
      console.error('Failed to update status:', error);
      alert('Failed to update status: ' + error.message);
    }
  };

  const driversForDropdown = drivers || [];

  const handleDriverChange = async (delivery, newDriverId) => {
    try {
      const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
      const driver = driversForDropdown.find(d => d && d.id === newDriverId);
      const driverName = driver ? getDriverDisplayName(driver) : '';
      
      await updateDeliveryLocal(delivery.id, { 
        driver_id: newDriverId,
        driver_name: driverName
      });
      setEditingDriverId(null);
      await onSortChange(); // Trigger refresh
    } catch (error) {
      console.error('Failed to update driver:', error);
      alert('Failed to update driver: ' + error.message);
    }
  };

  const getSortIcon = (columnName) => {
    if (sortColumn === columnName) {
      return sortDirection === 'asc' ? <ArrowUpDown className="w-4 h-4 inline ml-1 transform rotate-180" /> : <ArrowUpDown className="w-4 h-4 inline ml-1" />;
    }
    return <ArrowUpDown className="w-4 h-4 inline ml-1 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />;
  };

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const getDriverName = (delivery) => {
    if (!delivery || !delivery.driver_name) return 'Unassigned';
    if (!drivers || !Array.isArray(drivers)) return delivery.driver_name.split(' ')[0];
    const driver = drivers.find(d => d && (d.full_name === delivery.driver_name || d.user_name === delivery.driver_name));
    if (driver) {
      return getDriverDisplayName(driver);
    }
    return delivery.driver_name.split(' ')[0];
  };

  const getDeliveryInfo = (delivery) => {
    if (!delivery || !delivery.patient_id) {
      const store = (stores || []).find(s => s && s.id === delivery?.store_id);
      return {
        name: 'Store Pickup',
        address: store?.address || 'Unknown Store',
        patientPID: null
      };
    }
    const patient = (patients || []).find(p => p && p.id === delivery.patient_id);
    const address = patient?.address || 'Unknown Address';
    const unitNumber = patient?.unit_number ? `, Unit: ${patient.unit_number}` : '';
    return {
      name: patient?.full_name || 'Unknown Patient',
      address: `${address}${unitNumber}`,
      patientPID: patient?.patient_id || null
    };
  };

  const getDeliveryDateTime = (delivery) => {
    let date = 'N/A';
    let time = 'Not completed';

    if (delivery.delivery_date && typeof delivery.delivery_date === 'string') {
      const dateParts = delivery.delivery_date.split('-');
      if (dateParts.length === 3) {
        const [year, month, day] = dateParts;
        const localDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        date = format(localDate, 'MMM d, yyyy');
      } else {
        date = delivery.delivery_date;
      }
    }

    if (delivery.actual_delivery_time && typeof delivery.actual_delivery_time === 'string') {
      const timeParts = delivery.actual_delivery_time.match(/(\d{2}):(\d{2})/);
      if (timeParts) {
        const hours = parseInt(timeParts[1]);
        const minutes = timeParts[2];
        const isPM = hours >= 12;
        const displayHours = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
        time = `${displayHours}:${minutes} ${isPM ? 'PM' : 'AM'}`;
      } else {
        try {
          const dateTime = new Date(delivery.actual_delivery_time);
          if (!isNaN(dateTime.getTime())) {
            time = dateTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          }
        } catch (e) {
          // Fallback
        }
      }
    } else if (delivery.delivery_time_eta && typeof delivery.delivery_time_eta === 'string') {
      time = `ETA: ${delivery.delivery_time_eta}`;
    }

    return { date, time };
  };



  const getStatusBadge = (delivery) => {
    const status = delivery.status;
    const isEditing = editingStatusId === delivery.id;

    if (isEditing) {
      return (
        <Select
          value={status}
          onValueChange={(newStatus) => handleStatusChange(delivery, newStatus)}
          onOpenChange={(open) => {
            if (!open) setEditingStatusId(null);
          }}
        >
          <SelectTrigger className="h-7 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[9999]">
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="Ready For Pickup">Ready For Pickup</SelectItem>
            <SelectItem value="in_transit">In Transit</SelectItem>
            <SelectItem value="en_route">En Route</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="returned">Returned</SelectItem>
          </SelectContent>
        </Select>
      );
    }

    return (
      <Badge 
        variant={
          status === 'completed' ? 'default' :
          status === 'failed' ? 'destructive' :
          'secondary'
        }
        className="cursor-pointer hover:opacity-80"
        onClick={() => setEditingStatusId(delivery.id)}
      >
        {status}
      </Badge>
    );
  };

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedDeliveries(new Set((displayDeliveries || []).map(d => d.id)));
    } else {
      setSelectedDeliveries(new Set());
    }
  };

  const handleSelectDelivery = (deliveryId, checked) => {
    setSelectedDeliveries(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(deliveryId);
      } else {
        newSet.delete(deliveryId);
      }
      return newSet;
    });
  };

  // Auto-select duplicates when they're identified
  useEffect(() => {
    if (autoSelectIds && autoSelectIds.length > 0) {
      const newSet = new Set(autoSelectIds);
      setSelectedDeliveries(newSet);
      if (onAutoSelectProcessed) {
        onAutoSelectProcessed();
      }
    }
  }, [autoSelectIds, onAutoSelectProcessed]);

  // Filter and sort deliveries when in duplicate filter mode
  const displayDeliveries = useMemo(() => {
    let result = deliveries;
    
    // Filter to only show duplicates when in duplicate filter mode
    if (duplicateFilterMode && autoSelectIds.length > 0) {
      // Get all delivery IDs that are part of duplicate groups (includes the ones we auto-selected AND the ones we kept)
      const duplicateGroups = new Map();
      deliveries.forEach(d => {
        if (!d || !d.stop_id || !d.delivery_date || !d.driver_id) return;
        const key = `${d.stop_id}|${d.delivery_date}|${d.driver_id}`;
        if (!duplicateGroups.has(key)) {
          duplicateGroups.set(key, []);
        }
        duplicateGroups.get(key).push(d);
      });
      
      // Get all IDs from groups that have duplicates (size > 1)
      const allDuplicateIds = [];
      duplicateGroups.forEach((group, key) => {
        if (group.length > 1) {
          group.forEach(d => allDuplicateIds.push(d.id));
        }
      });
      
      // Show ALL deliveries that are part of duplicate groups (not just the auto-selected ones)
      result = result.filter(d => allDuplicateIds.includes(d.id));
      
      // Sort by delivery_date, then driver_id, then stop_id
      result = result.sort((a, b) => {
        // First sort by delivery_date
        if (a.delivery_date !== b.delivery_date) {
          return a.delivery_date.localeCompare(b.delivery_date);
        }
        // Then sort by driver_id
        if ((a.driver_id || '') !== (b.driver_id || '')) {
          return (a.driver_id || '').localeCompare(b.driver_id || '');
        }
        // Finally sort by stop_id
        return (a.stop_id || '').localeCompare(b.stop_id || '');
      });
    }
    
    return result;
  }, [deliveries, duplicateFilterMode, autoSelectIds]);

  const handleDeleteSelected = () => {
    const selectedDeliveriesArray = (displayDeliveries || []).filter(d => selectedDeliveries.has(d.id));
    onDeleteSelected(selectedDeliveriesArray);
    setSelectedDeliveries(new Set());
  };

  const isAllSelected = (displayDeliveries || []).length > 0 && selectedDeliveries.size === (displayDeliveries || []).length;
  const isSomeSelected = selectedDeliveries.size > 0 && selectedDeliveries.size < (displayDeliveries || []).length;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-slate-900)' }}>
          <span>Deliveries</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl
              config={config}
              visibleColumns={visibleColumns}
              onToggle={toggleColumn}
            />
            {selectedDeliveries.size > 0 && (
               <>
                 <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteSelected}
                  disabled={isLoadingData}
                >
                  Delete Selected ({selectedDeliveries.size})
                </Button>
              </>
            )}
            {(deliveries || []).length > 0 && (
               <>
                 <Button
                   variant="outline"
                   size="sm"
                   onClick={() => onFindDuplicates(deliveries)}
                   disabled={isLoadingData}
                   className="text-orange-600 border-orange-300 hover:bg-orange-50"
                 >
                   Find Duplicates
                 </Button>
                 {duplicateFilterMode && (
                   <Button
                     variant="outline"
                     size="sm"
                     onClick={onClearDuplicateFilter}
                     disabled={isLoadingData}
                     className="bg-blue-50 border-blue-300"
                   >
                     Clear Filter
                   </Button>
                 )}
                {selectedDeliveries.size === 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={onDeleteAll}
                    disabled={isLoadingData}
                  >
                    Delete All Filtered ({(displayDeliveries || []).length})
                  </Button>
                )}
              </>
            )}
          </div>
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-slate-500)' }}>Filtered and sorted list of deliveries by year, month, and driver.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 mb-4">
          <Select value={selectedYear} onValueChange={onYearChange} disabled={isLoadingData}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Select year" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Years</SelectItem>
              {(availableYears || []).map(year => (
                <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={selectedMonth} onValueChange={onMonthChange} disabled={isLoadingData || selectedYear === 'all'}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Select month" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Months</SelectItem>
              {monthNames.map((month, index) => (
                <SelectItem key={index + 1} value={(index + 1).toString()}>{month}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={selectedDriver} onValueChange={onDriverChange} disabled={isLoadingData}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Select driver" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Drivers</SelectItem>
              {(drivers || [])
                .filter(d => d && d.user_name)
                .map(driver => (
                  <SelectItem key={driver.user_name} value={driver.user_name}>
                    {getDriverDisplayName(driver)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>

          <Input
            placeholder="Filter by name, address, SID, TR#, or status..."
            value={filterText}
            onChange={(e) => onFilterChange(e.target.value)}
            className="flex-1 min-w-[200px]"
            disabled={isLoadingData}
          />
        </div>

        <div className="mb-2 text-sm" style={{ color: 'var(--text-slate-600)' }}>
          {(() => {
            const pickups = (deliveries || []).filter(d => !d.patient_id).length;
            const patientDeliveries = (deliveries || []).filter(d => d.patient_id).length;
            const driverName = selectedDriver !== 'all' 
              ? ((drivers || []).find(d => d && d.user_name === selectedDriver) 
                ? getDriverDisplayName((drivers || []).find(d => d && d.user_name === selectedDriver)) 
                : (selectedDriver || '').split(' ')[0])
              : 'All Drivers';
            const yearLabel = selectedYear !== 'all' ? selectedYear : 'All Years';
            const monthLabel = selectedMonth !== 'all' ? monthNames[parseInt(selectedMonth) - 1] : 'All Months';
            
            return `Showing: Pickups: ${pickups} | Deliveries: ${patientDeliveries} for ${yearLabel} - ${monthLabel} - ${driverName}`;
          })()}
        </div>

        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
          {duplicateFilterMode && (
            <div className="px-4 py-2 bg-blue-50 border-b" style={{ borderColor: 'var(--border-slate-200)' }}>
              <p className="text-sm font-medium text-blue-900">
                📍 Duplicate Filter Active: Showing {displayDeliveries.length} duplicates sorted by Date → Driver → Stop ID
              </p>
            </div>
          )}
          <div className="overflow-x-auto" style={{ maxHeight: '600px' }}>
            <table className="w-full text-sm table-fixed">
              <thead className="border-b sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                <tr>
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}>
                    <Checkbox
                      checked={isAllSelected}
                      onCheckedChange={handleSelectAll}
                      className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''}
                    />
                  </ResizableColumnHeader>
                  {visibleColumns.includes('date') && (
                    <ResizableColumnHeader width={columnWidths.date} onResize={(w) => updateColumnWidth('date', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('delivery_date')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        Date / Time {getSortIcon('delivery_date')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('order') && (
                    <ResizableColumnHeader width={columnWidths.order} onResize={(w) => updateColumnWidth('order', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('stop_order')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        Order {getSortIcon('stop_order')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('sid_pid') && (
                    <ResizableColumnHeader width={columnWidths.sid_pid} onResize={(w) => updateColumnWidth('sid_pid', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('stop_id')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        SID / PID {getSortIcon('stop_id')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('tracking') && (
                    <ResizableColumnHeader width={columnWidths.tracking} onResize={(w) => updateColumnWidth('tracking', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('tracking_number')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        TR# {getSortIcon('tracking_number')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('delivery_to') && (
                    <ResizableColumnHeader width={columnWidths.delivery_to} onResize={(w) => updateColumnWidth('delivery_to', w)}>
                      <span className="font-semibold">Delivery To</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('driver') && (
                    <ResizableColumnHeader width={columnWidths.driver} onResize={(w) => updateColumnWidth('driver', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('driver_name')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        Driver {getSortIcon('driver_name')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('status') && (
                    <ResizableColumnHeader width={columnWidths.status} onResize={(w) => updateColumnWidth('status', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('status')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        Status {getSortIcon('status')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('actions') && (
                    <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}>
                      <span className="font-semibold">Actions</span>
                    </ResizableColumnHeader>
                  )}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading deliveries...</td></tr>
                ) : (displayDeliveries || []).length > 0 ? (
                  (displayDeliveries || []).map(delivery => {
                    const info = getDeliveryInfo(delivery);
                    const dateTime = getDeliveryDateTime(delivery);
                    const driverName = getDriverName(delivery);
                    return (
                      <tr key={delivery.id} className="border-b" style={{ borderColor: 'var(--border-slate-200)', ':hover': { background: 'var(--bg-slate-50)' } }}>
                        <td className="p-2">
                          <Checkbox
                            checked={selectedDeliveries.has(delivery.id)}
                            onCheckedChange={(checked) => handleSelectDelivery(delivery.id, checked)}
                          />
                        </td>
                        {visibleColumns.includes('date') && (
                          <td className="p-2">
                            <div className="flex flex-col">
                              <span className="font-medium" style={{ color: 'var(--text-slate-900)' }}>{dateTime.date}</span>
                              <span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>{dateTime.time}</span>
                            </div>
                          </td>
                        )}
                        {visibleColumns.includes('order') && (
                          <td className="p-2 font-mono text-sm">
                            <div className="flex flex-col">
                              <span className="font-semibold">
                                {delivery.stop_order !== null && delivery.stop_order !== undefined ? delivery.stop_order : '-'}
                              </span>
                              {delivery.ampm_deliveries && (
                                <span className="text-xs text-slate-600">{delivery.ampm_deliveries}</span>
                              )}
                            </div>
                          </td>
                        )}
                        {visibleColumns.includes('sid_pid') && (
                          <td className="p-2 font-mono text-xs">
                            <div className="flex flex-col">
                              {delivery.stop_id && <span className="font-semibold">{delivery.stop_id}</span>}
                              {info.patientPID && <span className="text-slate-600">{info.patientPID}</span>}
                              {!delivery.stop_id && !info.patientPID && <span>-</span>}
                            </div>
                          </td>
                        )}
                        {visibleColumns.includes('tracking') && (
                          <td className="p-2 font-mono text-xs">
                            <div className="flex flex-col">
                              <span>{delivery.tracking_number || '-'}</span>
                              {delivery.puid && (
                                <span className="text-slate-600 text-[10px]">{delivery.puid}</span>
                              )}
                            </div>
                          </td>
                        )}
                        {visibleColumns.includes('delivery_to') && (
                          <td className="p-2">
                            <div className="flex flex-col">
                              <span className="font-medium" style={{ color: 'var(--text-slate-900)' }}>{info.name}</span>
                              <span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>{info.address}</span>
                            </div>
                          </td>
                        )}
                        {visibleColumns.includes('driver') && (
                          <td className="p-2">
                            {editingDriverId === delivery.id ? (
                              <Select
                                value={delivery.driver_id || ''}
                                onValueChange={(newDriverId) => handleDriverChange(delivery, newDriverId)}
                                onOpenChange={(open) => {
                                  if (!open) setEditingDriverId(null);
                                }}
                              >
                                <SelectTrigger className="h-7 w-full text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="z-[9999]">
                                  {driversForDropdown.map((driver) => (
                                    <SelectItem key={driver.id} value={driver.id}>
                                      {getDriverDisplayName(driver)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <span 
                                className="cursor-pointer hover:bg-slate-100 px-2 py-1 rounded transition-colors inline-block"
                                onClick={() => setEditingDriverId(delivery.id)}
                              >
                                {driverName}
                              </span>
                            )}
                          </td>
                        )}
                        {visibleColumns.includes('status') && (
                          <td className="p-2">
                            {getStatusBadge(delivery)}
                          </td>
                        )}
                        {visibleColumns.includes('actions') && (
                          <td className="p-2 text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => onEdit(delivery)}
                              >
                                <Edit className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => onDelete(delivery)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                ) : (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={{ color: 'var(--text-slate-500)' }}>No deliveries found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const PatientDataTable = ({
  patients, stores, onEdit, onDelete,
  filterText, onFilterChange, sortColumn, sortDirection, onSortChange,
  isLoadingData,
  onDeleteAll, onDeleteSelected
}) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('patients');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_patient_column_widths');
    return saved ? JSON.parse(saved) : {
      checkbox: 50,
      id: 280,
      full_name: 200,
      patient_id: 100,
      phone: 140,
      address: 250,
      unit: 100,
      store: 150,
      last_delivery_date: 120,
      actions: 150
    };
  });

  const [selectedPatients, setSelectedPatients] = useState(new Set());

  const updateColumnWidth = useCallback((columnId, width) => {
    setColumnWidths(prev => {
      const newWidths = { ...prev, [columnId]: width };
      localStorage.setItem('admin_patient_column_widths', JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const [duplicateFilter, setDuplicateFilter] = useState('none');
  const [storeFilter, setStoreFilter] = useState('all');

  // Card styling for dark mode
  const cardStyle = { background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' };
  const textPrimary = { color: 'var(--text-slate-900)' };
  const textSecondary = { color: 'var(--text-slate-600)' };
  const textMuted = { color: 'var(--text-slate-500)' };

  const getSortIcon = (columnName) => {
    if (sortColumn === columnName) {
      return sortDirection === 'asc' ? <ArrowUpDown className="w-4 h-4 inline ml-1 transform rotate-180" /> : <ArrowUpDown className="w-4 h-4 inline ml-1" />;
    }
    return <ArrowUpDown className="w-4 h-4 inline ml-1 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />;
  };

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedPatients(new Set(filteredPatients.map(p => p.id)));
    } else {
      setSelectedPatients(new Set());
    }
  };

  const handleSelectPatient = (patientId, checked) => {
    setSelectedPatients(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(patientId);
      } else {
        newSet.delete(patientId);
      }
      return newSet;
    });
  };

  const handleDeleteSelected = () => {
    const selectedPatientsArray = filteredPatients.filter(p => selectedPatients.has(p.id));
    onDeleteSelected(selectedPatientsArray);
    setSelectedPatients(new Set());
  };

  const detectDuplicates = useMemo(() => {
    if (!patients || !Array.isArray(patients) || patients.length === 0) {
      return {
        address: new Set(),
        name: new Set(),
        phone: new Set(),
        pid: new Set()
      };
    }

    const addressMap = new Map();
    const nameMap = new Map();
    const phoneMap = new Map();
    const pidMap = new Map();

    patients.forEach(patient => {
      if (patient.address) {
        const addr = patient.address.toLowerCase().trim();
        if (!addressMap.has(addr)) addressMap.set(addr, []);
        addressMap.get(addr).push(patient.id);
      }

      if (patient.full_name) {
        const name = patient.full_name.toLowerCase().trim();
        if (!nameMap.has(name)) nameMap.set(name, []);
        nameMap.get(name).push(patient.id);
      }

      if (patient.phone) {
        const phone = patient.phone.replace(/\D/g, '');
        if (phone) {
          if (!phoneMap.has(phone)) phoneMap.set(phone, []);
          phoneMap.get(phone).push(patient.id);
        }
      }

      if (patient.patient_id) {
        const pid = patient.patient_id.toUpperCase().trim();
        if (!pidMap.has(pid)) pidMap.set(pid, []);
        pidMap.get(pid).push(patient.id);
      }
    });

    const duplicateAddressIds = new Set();
    const duplicateNameIds = new Set();
    const duplicatePhoneIds = new Set();
    const duplicatePidIds = new Set();

    addressMap.forEach(ids => {
      if (ids.length > 1) ids.forEach(id => duplicateAddressIds.add(id));
    });

    nameMap.forEach(ids => {
      if (ids.length > 1) ids.forEach(id => duplicateNameIds.add(id));
    });

    phoneMap.forEach(ids => {
      if (ids.length > 1) ids.forEach(id => duplicatePhoneIds.add(id));
    });

    pidMap.forEach(ids => {
      if (ids.length > 1) ids.forEach(id => duplicatePidIds.add(id));
    });

    return {
      address: duplicateAddressIds,
      name: duplicateNameIds,
      phone: duplicatePhoneIds,
      pid: duplicatePidIds
    };
  }, [patients]);

  const filteredPatients = useMemo(() => {
    let filtered = patients || [];

    if (duplicateFilter !== 'none') {
      switch (duplicateFilter) {
        case 'address':
          filtered = filtered.filter(p => detectDuplicates.address.has(p.id));
          break;
        case 'name':
          filtered = filtered.filter(p => detectDuplicates.name.has(p.id));
          break;
        case 'phone':
          filtered = filtered.filter(p => detectDuplicates.phone.has(p.id));
          break;
        case 'pid':
          filtered = filtered.filter(p => detectDuplicates.pid.has(p.id));
          break;
        default:
          filtered = patients || [];
      }
    }

    if (storeFilter !== 'all') {
      filtered = filtered.filter(patient => patient.store_id === storeFilter);
    }

    if (filterText && filterText.trim()) {
      const searchText = filterText.toLowerCase().trim();
      filtered = filtered.filter(patient => {
        const patientStore = stores.find(s => s.id === patient.store_id);
        const storeName = patientStore?.name?.toLowerCase() || '';
        const lastDeliveryDate = patient.last_delivery_date ? patient.last_delivery_date.toLowerCase() : '';

        return (
          (patient.id && patient.id.toLowerCase().includes(searchText)) ||
          (patient.full_name && patient.full_name.toLowerCase().includes(searchText)) ||
          (patient.phone && patient.phone.toLowerCase().includes(searchText)) ||
          (patient.address && patient.address.toLowerCase().includes(searchText)) ||
          (patient.patient_id && patient.patient_id.toLowerCase().includes(searchText)) ||
          storeName.includes(searchText) ||
          lastDeliveryDate.includes(searchText)
        );
      });
    }

    if (sortColumn) {
      filtered.sort((a, b) => {
        let aValue, bValue;

        if (sortColumn === 'store_id') {
          const aStore = stores.find(s => s.id === a.store_id);
          const bStore = stores.find(s => s.id === b.store_id);
          aValue = aStore?.name || '';
          bValue = bStore?.name || '';
        }
        else if (sortColumn === 'last_delivery_date') {
          const aDateObj = parseFlexibleDate(a.last_delivery_date);
          const bDateObj = parseFlexibleDate(b.last_delivery_date);

          const aTime = aDateObj ? aDateObj.getTime() : NaN;
          const bTime = bDateObj ? bDateObj.getTime() : NaN;

          const aIsEmpty = isNaN(aTime);
          const bIsEmpty = isNaN(bTime);

          if (aIsEmpty && bIsEmpty) return 0;
          if (aIsEmpty) return 1;
          if (bIsEmpty) return -1;

          return sortDirection === 'asc' ? aTime - bTime : bTime - aTime;
        }
        else {
          aValue = a[sortColumn];
          bValue = b[sortColumn];
        }

        if (aValue === null || aValue === undefined) return sortDirection === 'asc' ? 1 : -1;
        if (bValue === null || bValue === undefined) return sortDirection === 'asc' ? -1 : 1;

        if (typeof aValue === 'string' && typeof bValue === 'string') {
          return sortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
        }
        if (typeof aValue === 'number' && typeof bValue === 'number') {
          return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
        }
        return 0;
      });
    }

    return filtered;
  }, [patients, duplicateFilter, storeFilter, detectDuplicates, filterText, sortColumn, sortDirection, stores]);

  const duplicateCounts = {
    address: detectDuplicates.address.size,
    name: detectDuplicates.name.size,
    phone: detectDuplicates.phone.size,
    pid: detectDuplicates.pid.size
  };

  const isAllSelected = filteredPatients.length > 0 && selectedPatients.size === filteredPatients.length;
  const isSomeSelected = selectedPatients.size > 0 && selectedPatients.size < filteredPatients.length;

  return (
    <Card style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={textPrimary}>
          <span>Patients</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl
              config={config}
              visibleColumns={visibleColumns}
              onToggle={toggleColumn}
            />
            {selectedPatients.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteSelected}
                disabled={isLoadingData}
              >
                Delete Selected ({selectedPatients.size})
              </Button>
            )}
            {filteredPatients.length > 0 && selectedPatients.size === 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onDeleteAll(filteredPatients)}
                disabled={isLoadingData}
              >
                Delete All ({filteredPatients.length})
              </Button>
            )}
          </div>
        </CardTitle>
        <CardDescription style={textMuted}>Filtered and sorted list of patients.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 mb-4">
          <div className="flex gap-3 flex-wrap">
            <Input
              placeholder="Filter by ID, name, PID, phone, address, store, or last delivery date..."
              value={filterText}
              onChange={(e) => onFilterChange(e.target.value)}
              disabled={isLoadingData}
              className="flex-1 min-w-[250px]"
            />

            <Select value={storeFilter} onValueChange={setStoreFilter} disabled={isLoadingData}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All Stores" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Stores</SelectItem>
                {stores.map(store => (
                  <SelectItem key={store.id} value={store.id}>
                    {store.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant={duplicateFilter === 'none' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDuplicateFilter('none')}
            >
              All Patients ({patients?.length || 0})
            </Button>
            <Button
              variant={duplicateFilter === 'address' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDuplicateFilter('address')}
              disabled={duplicateCounts.address === 0}
            >
              <Database className="w-4 h-4 mr-1" />
              Duplicate Addresses ({duplicateCounts.address})
            </Button>
            <Button
              variant={duplicateFilter === 'name' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDuplicateFilter('name')}
              disabled={duplicateCounts.name === 0}
            >
              <Database className="w-4 h-4 mr-1" />
              Duplicate Names ({duplicateCounts.name})
            </Button>
            <Button
              variant={duplicateFilter === 'phone' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDuplicateFilter('phone')}
              disabled={duplicateCounts.phone === 0}
            >
              <Database className="w-4 h-4 mr-1" />
              Duplicate Phones ({duplicateCounts.phone})
            </Button>
            <Button
              variant={duplicateFilter === 'pid' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDuplicateFilter('pid')}
              disabled={duplicateCounts.pid === 0}
            >
              <Database className="w-4 h-4 mr-1" />
              Duplicate PIDs ({duplicateCounts.pid})
            </Button>
          </div>
        </div>

        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm table-fixed">
              <thead className="border-b sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                <tr>
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}>
                    <Checkbox
                      checked={isAllSelected}
                      onCheckedChange={handleSelectAll}
                      className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''}
                    />
                  </ResizableColumnHeader>
                  {visibleColumns.includes('id') && (
                    <ResizableColumnHeader width={columnWidths.id} onResize={(w) => updateColumnWidth('id', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('id')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold" style={textPrimary}>
                        System ID {getSortIcon('id')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('full_name') && (
                    <ResizableColumnHeader width={columnWidths.full_name} onResize={(w) => updateColumnWidth('full_name', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('full_name')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold" style={textPrimary}>
                        Full Name {getSortIcon('full_name')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('patient_id') && (
                    <ResizableColumnHeader width={columnWidths.patient_id} onResize={(w) => updateColumnWidth('patient_id', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('patient_id')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        PID {getSortIcon('patient_id')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('phone') && (
                    <ResizableColumnHeader width={columnWidths.phone} onResize={(w) => updateColumnWidth('phone', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('phone')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        Phone {getSortIcon('phone')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('address') && (
                    <ResizableColumnHeader width={columnWidths.address} onResize={(w) => updateColumnWidth('address', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('address')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        Address {getSortIcon('address')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('unit') && (
                    <ResizableColumnHeader width={columnWidths.unit} onResize={(w) => updateColumnWidth('unit', w)}>
                      <span className="font-semibold">Unit</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('store') && (
                    <ResizableColumnHeader width={columnWidths.store} onResize={(w) => updateColumnWidth('store', w)}>
                      <Button variant="ghost" onClick={() => onSortChange('store_id')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">
                        Store {getSortIcon('store_id')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('last_delivery_date') && (
                    <ResizableColumnHeader width={columnWidths.last_delivery_date} onResize={(w) => updateColumnWidth('last_delivery_date', w)}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          onSortChange('last_delivery_date');
                        }}
                        className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold"
                      >
                        Last Delivery {getSortIcon('last_delivery_date')}
                      </Button>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('actions') && (
                    <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}>
                      <span className="font-semibold">Actions</span>
                    </ResizableColumnHeader>
                  )}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading patients...</td></tr>
                ) : filteredPatients.length > 0 ? (
                  filteredPatients.map(patient => {
                    const isDuplicateAddress = detectDuplicates.address.has(patient.id);
                    const isDuplicateName = detectDuplicates.name.has(patient.id);
                    const isDuplicatePhone = detectDuplicates.phone.has(patient.id);
                    const isDuplicatePid = detectDuplicates.pid.has(patient.id);
                    const patientStore = stores.find(s => s.id === patient.store_id);

                    return (
                      <tr key={patient.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                        <td className="p-3">
                          <Checkbox
                            checked={selectedPatients.has(patient.id)}
                            onCheckedChange={(checked) => handleSelectPatient(patient.id, checked)}
                          />
                        </td>
                        {visibleColumns.includes('id') && (
                          <td className="p-3 font-mono text-xs select-all" style={{ color: 'var(--text-slate-700)' }}>
                            {patient.id}
                          </td>
                        )}
                        {visibleColumns.includes('full_name') && (
                          <td className={`p-3 ${isDuplicateName ? 'bg-yellow-50' : ''}`} style={textPrimary}>
                            {patient.full_name}
                            {isDuplicateName && <Badge variant="destructive" className="ml-2 text-xs">Dup</Badge>}
                          </td>
                        )}
                        {visibleColumns.includes('patient_id') && (
                          <td className={`p-3 font-mono text-xs ${isDuplicatePid ? 'bg-yellow-50' : ''}`} style={textPrimary}>
                            {patient.patient_id || '-'}
                            {isDuplicatePid && <Badge variant="destructive" className="ml-2 text-xs">Dup</Badge>}
                          </td>
                        )}
                        {visibleColumns.includes('phone') && (
                          <td className={`p-3 ${isDuplicatePhone ? 'bg-yellow-50' : ''}`} style={textPrimary}>
                            {patient.phone}
                            {isDuplicatePhone && <Badge variant="destructive" className="ml-2 text-xs">Dup</Badge>}
                          </td>
                        )}
                        {visibleColumns.includes('address') && (
                          <td className={`p-3 ${isDuplicateAddress ? 'bg-yellow-50' : ''}`} style={textPrimary}>
                            {patient.address}
                            {isDuplicateAddress && <Badge variant="destructive" className="ml-2 text-xs">Dup</Badge>}
                          </td>
                        )}
                        {visibleColumns.includes('unit') && (
                          <td className="p-3 text-xs" style={textPrimary}>{patient.unit_number || '-'}</td>
                        )}
                        {visibleColumns.includes('store') && (
                          <td className="p-3">
                            {patientStore ? (
                              <div className="flex flex-col">
                                <span className="font-medium" style={textPrimary}>{patientStore.name}</span>
                                <span className="text-xs font-mono" style={textMuted}>{patientStore.id}</span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-slate-400)' }}>Unassigned</span>
                            )}
                          </td>
                        )}
                        {visibleColumns.includes('last_delivery_date') && (
                          <td className="p-3 text-sm" style={textPrimary}>
                            {patient.last_delivery_date ? (() => {
                              const dateObj = parseFlexibleDate(patient.last_delivery_date);
                              if (dateObj && !isNaN(dateObj.getTime())) {
                                return format(dateObj, 'MMM d, yyyy');
                              }
                              return <span className="text-amber-600 text-xs" title="Unrecognized date format">{patient.last_delivery_date}</span>;
                            })() : (
                              <span style={{ color: 'var(--text-slate-400)' }}>Never</span>
                            )}
                          </td>
                        )}
                        {visibleColumns.includes('actions') && (
                          <td className="p-3 text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => onEdit(patient)}
                              >
                                <Edit className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => onDelete(patient)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                ) : (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={textMuted}>No patients found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const StoreDataTable = ({ stores, onEdit, onDelete, onDeleteSelected, isLoadingData }) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('stores');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_store_column_widths');
    return saved ? JSON.parse(saved) : {
      checkbox: 50,
      id: 120,
      name: 200,
      abbreviation: 100,
      address: 300,
      phone: 140,
      city: 120,
      actions: 150
    };
  });

  const [selectedStores, setSelectedStores] = useState(new Set());

  const updateColumnWidth = useCallback((columnId, width) => {
    setColumnWidths(prev => {
      const newWidths = { ...prev, [columnId]: width };
      localStorage.setItem('admin_store_column_widths', JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedStores(new Set((stores || []).map(s => s.id)));
    } else {
      setSelectedStores(new Set());
    }
  };

  const handleSelectStore = (storeId, checked) => {
    setSelectedStores(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(storeId);
      } else {
        newSet.delete(storeId);
      }
      return newSet;
    });
  };

  const handleDeleteSelected = () => {
    const selectedStoresArray = (stores || []).filter(s => selectedStores.has(s.id));
    onDeleteSelected(selectedStoresArray);
    setSelectedStores(new Set());
  };

  const isAllSelected = (stores || []).length > 0 && selectedStores.size === (stores || []).length;
  const isSomeSelected = selectedStores.size > 0 && selectedStores.size < (stores || []).length;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-slate-900)' }}>
          <span>Stores</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl
              config={config}
              visibleColumns={visibleColumns}
              onToggle={toggleColumn}
            />
            {selectedStores.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteSelected}
                disabled={isLoadingData}
              >
                Delete Selected ({selectedStores.size})
              </Button>
            )}
          </div>
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-slate-500)' }}>List of all stores.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm table-fixed">
              <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)' }}>
                <tr>
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}>
                    <Checkbox
                      checked={isAllSelected}
                      onCheckedChange={handleSelectAll}
                      className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''}
                    />
                  </ResizableColumnHeader>
                  {visibleColumns.includes('id') && (
                    <ResizableColumnHeader width={columnWidths.id} onResize={(w) => updateColumnWidth('id', w)}>
                      <span className="font-semibold">ID</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('name') && (
                    <ResizableColumnHeader width={columnWidths.name} onResize={(w) => updateColumnWidth('name', w)}>
                      <span className="font-semibold">Name</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('abbreviation') && (
                    <ResizableColumnHeader width={columnWidths.abbreviation} onResize={(w) => updateColumnWidth('abbreviation', w)}>
                      <span className="font-semibold">Abbr</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('address') && (
                    <ResizableColumnHeader width={columnWidths.address} onResize={(w) => updateColumnWidth('address', w)}>
                      <span className="font-semibold">Address</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('phone') && (
                    <ResizableColumnHeader width={columnWidths.phone} onResize={(w) => updateColumnWidth('phone', w)}>
                      <span className="font-semibold">Phone</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('city') && (
                    <ResizableColumnHeader width={columnWidths.city} onResize={(w) => updateColumnWidth('city', w)}>
                      <span className="font-semibold">City</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('actions') && (
                    <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}>
                      <span className="font-semibold">Actions</span>
                    </ResizableColumnHeader>
                  )}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading stores...</td></tr>
                ) : stores.length > 0 ? (
                  stores.map(store => (
                    <tr key={store.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <td className="p-2">
                        <Checkbox
                          checked={selectedStores.has(store.id)}
                          onCheckedChange={(checked) => handleSelectStore(store.id, checked)}
                        />
                      </td>
                      {visibleColumns.includes('id') && (
                        <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-500)' }} title={store.id}>{store.id.substring(0, 8)}...</td>
                      )}
                      {visibleColumns.includes('name') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.name}</td>
                      )}
                      {visibleColumns.includes('abbreviation') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.abbreviation}</td>
                      )}
                      {visibleColumns.includes('address') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.address}</td>
                      )}
                      {visibleColumns.includes('phone') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.phone}</td>
                      )}
                      {visibleColumns.includes('city') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.city_id || '-'}</td>
                      )}
                      {visibleColumns.includes('actions') && (
                        <td className="p-3 text-right">
                          <Button variant="outline" size="sm" onClick={() => onEdit(store)} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>Edit</Button>
                          <Button variant="destructive" size="sm" className="ml-2" onClick={() => onDelete(store)}>Delete</Button>
                        </td>
                      )}
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={{ color: 'var(--text-slate-500)' }}>No stores found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const UserDataTable = ({ users, onEdit, onDelete, onDeleteSelected, isLoadingData }) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('users');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_user_column_widths');
    return saved ? JSON.parse(saved) : {
      checkbox: 50,
      id: 120,
      user_name: 200,
      phone: 140,
      roles: 150,
      status: 120,
      location_tracking: 140,
      home_coords: 180,
      current_coords: 180,
      city: 120,
      stores: 150,
      actions: 150
    };
  });

  const [selectedUsers, setSelectedUsers] = useState(new Set());

  const updateColumnWidth = useCallback((columnId, width) => {
    setColumnWidths(prev => {
      const newWidths = { ...prev, [columnId]: width };
      localStorage.setItem('admin_user_column_widths', JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedUsers(new Set((users || []).map(u => u.id)));
    } else {
      setSelectedUsers(new Set());
    }
  };

  const handleSelectUser = (userId, checked) => {
    setSelectedUsers(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(userId);
      } else {
        newSet.delete(userId);
      }
      return newSet;
    });
  };

  const handleDeleteSelected = () => {
    const selectedUsersArray = (users || []).filter(u => selectedUsers.has(u.id));
    onDeleteSelected(selectedUsersArray);
    setSelectedUsers(new Set());
  };

  const isAllSelected = (users || []).length > 0 && selectedUsers.size === (users || []).length;
  const isSomeSelected = selectedUsers.size > 0 && selectedUsers.size < (users || []).length;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-slate-900)' }}>
          <span>App Users</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl
              config={config}
              visibleColumns={visibleColumns}
              onToggle={toggleColumn}
            />
            {selectedUsers.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteSelected}
                disabled={isLoadingData}
              >
                Delete Selected ({selectedUsers.size})
              </Button>
            )}
          </div>
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-slate-500)' }}>List of all application users.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm table-fixed">
              <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)' }}>
                <tr>
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}>
                    <Checkbox
                      checked={isAllSelected}
                      onCheckedChange={handleSelectAll}
                      className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''}
                    />
                  </ResizableColumnHeader>
                  {visibleColumns.includes('id') && (
                    <ResizableColumnHeader width={columnWidths.id} onResize={(w) => updateColumnWidth('id', w)}>
                      <span className="font-semibold">ID</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('user_name') && (
                    <ResizableColumnHeader width={columnWidths.user_name} onResize={(w) => updateColumnWidth('user_name', w)}>
                      <span className="font-semibold">User Name</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('phone') && (
                    <ResizableColumnHeader width={columnWidths.phone} onResize={(w) => updateColumnWidth('phone', w)}>
                      <span className="font-semibold">Phone</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('roles') && (
                    <ResizableColumnHeader width={columnWidths.roles} onResize={(w) => updateColumnWidth('roles', w)}>
                      <span className="font-semibold">Roles</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('status') && (
                    <ResizableColumnHeader width={columnWidths.status} onResize={(w) => updateColumnWidth('status', w)}>
                      <span className="font-semibold">Status</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('location_tracking') && (
                    <ResizableColumnHeader width={columnWidths.location_tracking} onResize={(w) => updateColumnWidth('location_tracking', w)}>
                      <span className="font-semibold">Location Tracking</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('home_coords') && (
                    <ResizableColumnHeader width={columnWidths.home_coords} onResize={(w) => updateColumnWidth('home_coords', w)}>
                      <span className="font-semibold">Home Coords</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('current_coords') && (
                    <ResizableColumnHeader width={columnWidths.current_coords} onResize={(w) => updateColumnWidth('current_coords', w)}>
                      <span className="font-semibold">Current Coords</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('city') && (
                    <ResizableColumnHeader width={columnWidths.city} onResize={(w) => updateColumnWidth('city', w)}>
                      <span className="font-semibold">City</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('stores') && (
                    <ResizableColumnHeader width={columnWidths.stores} onResize={(w) => updateColumnWidth('stores', w)}>
                      <span className="font-semibold">Stores</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('actions') && (
                    <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}>
                      <span className="font-semibold">Actions</span>
                    </ResizableColumnHeader>
                  )}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading app users...</td></tr>
                ) : users.length > 0 ? (
                  users.map(user => (
                    <tr key={user.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <td className="p-2">
                        <Checkbox
                          checked={selectedUsers.has(user.id)}
                          onCheckedChange={(checked) => handleSelectUser(user.id, checked)}
                        />
                      </td>
                      {visibleColumns.includes('id') && (
                        <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-500)' }} title={user.id}>{user.id.substring(0, 8)}...</td>
                      )}
                      {visibleColumns.includes('user_name') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.user_name}</td>
                      )}
                      {visibleColumns.includes('phone') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.phone}</td>
                      )}
                      {visibleColumns.includes('roles') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.app_roles ? user.app_roles.join(', ') : 'N/A'}</td>
                      )}
                      {visibleColumns.includes('status') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.status}</td>
                      )}
                      {visibleColumns.includes('location_tracking') && (
                        <td className="p-3">
                          <Badge variant={user.location_tracking_enabled ? 'default' : 'secondary'}>
                            {user.location_tracking_enabled ? '✓ Enabled' : 'Disabled'}
                          </Badge>
                        </td>
                      )}
                      {visibleColumns.includes('home_coords') && (
                        <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-900)' }}>
                          {user.home_latitude && user.home_longitude 
                            ? `${user.home_latitude.toFixed(5)}, ${user.home_longitude.toFixed(5)}`
                            : '-'
                          }
                        </td>
                      )}
                      {visibleColumns.includes('current_coords') && (
                        <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-900)' }}>
                          {user.current_latitude && user.current_longitude 
                            ? `${user.current_latitude.toFixed(5)}, ${user.current_longitude.toFixed(5)}`
                            : '-'
                          }
                        </td>
                      )}
                      {visibleColumns.includes('city') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.city_id || '-'}</td>
                      )}
                      {visibleColumns.includes('stores') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>
                          {user.store_ids && user.store_ids.length > 0
                            ? user.store_ids.map(id => id.substring(0,4)).join(', ') + '...'
                            : '-'
                          }
                        </td>
                      )}
                      {visibleColumns.includes('actions') && (
                        <td className="p-3 text-right">
                          <Button variant="outline" size="sm" onClick={() => onEdit(user)} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>Edit</Button>
                          <Button variant="destructive" size="sm" className="ml-2" onClick={() => onDelete(user)}>Delete</Button>
                        </td>
                      )}
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={{ color: 'var(--text-slate-500)' }}>No app users found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const UserSettingsTable = ({ appUsers, mergedUsers }) => {
  const [userSettings, setUserSettings] = useState([]);
  const [localUserSettings, setLocalUserSettings] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState('cloud'); // 'cloud' or 'local'
  const refreshIntervalRef = useRef(null);
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('userSettings');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_usersettings_column_widths');
    return saved ? JSON.parse(saved) : {
      user_name: 180,
      device_type: 120,
      selected_driver: 150,
      selected_date: 120,
      sidebar_width: 120,
      theme: 100,
      created: 160,
      updated: 160,
      actions: 100
    };
  });

  const updateColumnWidth = useCallback((columnId, width) => {
    setColumnWidths(prev => {
      const newWidths = { ...prev, [columnId]: width };
      localStorage.setItem('admin_usersettings_column_widths', JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      // Load cloud settings
      const settings = await UserSettings.list();
      setUserSettings(settings || []);
      
      // Load local cached settings from IndexedDB
      const { offlineManager } = await import('../components/utils/offlineManager');
      const localSettings = await offlineManager.getAllCachedUserSettings();
      console.log('📋 [UserSettingsTable] Loaded local cached settings from IndexedDB:', localSettings?.length || 0);
      setLocalUserSettings(localSettings || []);
      
      return settings || [];
    } catch (error) {
      console.error('Failed to load user settings:', error);
      setUserSettings([]);
      setLocalUserSettings([]);
      return [];
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await loadSettings();
      setIsLoading(false);
    };
    init();
  }, [loadSettings]);

  // Smart refresh for UserSettings - poll every 15 seconds
  useEffect(() => {
    if (isLoading) return;

    const performRefresh = async () => {
      try {
        console.log('🔄 [UserSettingsTable] Checking for UserSettings changes...');
        const freshSettings = await UserSettings.list();
        
        if (!freshSettings) return;
        
        // Compare counts first
        if (freshSettings.length !== userSettings.length) {
          console.log('✅ [UserSettingsTable] Count changed, updating...');
          setUserSettings(freshSettings);
          return;
        }
        
        // Compare each setting for changes
        let hasChanges = false;
        for (const fresh of freshSettings) {
          const existing = userSettings.find(s => s.id === fresh.id);
          if (!existing) {
            hasChanges = true;
            break;
          }
          // Check key fields that might change
          if (existing.selected_driver_id !== fresh.selected_driver_id ||
              existing.selected_date !== fresh.selected_date ||
              existing.sidebar_width !== fresh.sidebar_width ||
              existing.theme_preference !== fresh.theme_preference) {
            console.log(`✅ [UserSettingsTable] Setting ${fresh.id} changed:`, {
              driver: `${existing.selected_driver_id} → ${fresh.selected_driver_id}`,
              date: `${existing.selected_date} → ${fresh.selected_date}`
            });
            hasChanges = true;
            break;
          }
        }
        
        if (hasChanges) {
          console.log('✅ [UserSettingsTable] Updating with fresh data');
          setUserSettings(freshSettings);
        } else {
          console.log('ℹ️ [UserSettingsTable] No changes detected');
        }
      } catch (error) {
        console.error('❌ [UserSettingsTable] Smart refresh error:', error);
      }
    };

    // Initial check after mount
    const initialTimeout = setTimeout(performRefresh, 2000);
    
    refreshIntervalRef.current = setInterval(performRefresh, 15000);

    return () => {
      clearTimeout(initialTimeout);
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [isLoading, userSettings]);

  const getUserName = (userId) => {
    if (!userId) return 'Unknown';
    const appUser = appUsers.find(au => au && au.user_id === userId);
    if (appUser) return appUser.user_name || 'Unknown';
    const user = mergedUsers.find(u => u && u.id === userId);
    if (user) return user.user_name || 'Unknown';
    return userId.substring(0, 8) + '...';
  };

  const handleDeleteSetting = async (settingId) => {
    if (!window.confirm(`Are you sure you want to delete this ${viewMode === 'cloud' ? 'cloud' : 'local cached'} user setting?`)) return;
    try {
      if (viewMode === 'cloud') {
        await UserSettings.delete(settingId);
        setUserSettings(prev => prev.filter(s => s.id !== settingId));
      } else {
        // Delete from local IndexedDB cache
        const setting = localUserSettings.find(s => s.id === settingId || s._cacheId === settingId);
        if (!setting) {
          alert('Setting not found in local cache.');
          return;
        }
        
        const { offlineManager } = await import('../components/utils/offlineManager');
        const cacheId = setting._cacheId || settingId;
        const deleted = await offlineManager.deleteCachedUserSettings(cacheId);
        
        if (deleted) {
          setLocalUserSettings(prev => prev.filter(s => (s._cacheId || s.id) !== cacheId));
        } else {
          alert('Failed to delete from local cache.');
        }
      }
    } catch (error) {
      console.error('Failed to delete setting:', error);
      alert('Failed to delete setting: ' + error.message);
    }
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
            <Button
              variant={viewMode === 'cloud' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('cloud')}
              style={viewMode !== 'cloud' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' } : {}}
            >
              Cloud ({userSettings.length})
            </Button>
            <Button
              variant={viewMode === 'local' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('local')}
              style={viewMode !== 'local' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' } : {}}
            >
              Local ({localUserSettings.length})
            </Button>
            <ColumnVisibilityControl
              config={config}
              visibleColumns={visibleColumns}
              onToggle={toggleColumn}
            />
          </div>
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-slate-500)' }}>
          View and manage per-user, per-device settings. Toggle between Cloud (backend) and Local (IndexedDB) storage.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center items-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
            <span className="ml-2" style={{ color: 'var(--text-slate-600)' }}>Loading user settings...</span>
          </div>
        ) : displayedSettings.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--text-slate-500)' }}>
            No {viewMode} user settings found.
          </div>
        ) : (
          <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm table-fixed">
                <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)' }}>
                  <tr>
                    {visibleColumns.includes('user_name') && (
                      <ResizableColumnHeader width={columnWidths.user_name} onResize={(w) => updateColumnWidth('user_name', w)}>
                        <span className="font-semibold">User</span>
                      </ResizableColumnHeader>
                    )}
                    {visibleColumns.includes('device_type') && (
                      <ResizableColumnHeader width={columnWidths.device_type} onResize={(w) => updateColumnWidth('device_type', w)}>
                        <span className="font-semibold">Device Type</span>
                      </ResizableColumnHeader>
                    )}
                    {visibleColumns.includes('selected_driver') && (
                      <ResizableColumnHeader width={columnWidths.selected_driver} onResize={(w) => updateColumnWidth('selected_driver', w)}>
                        <span className="font-semibold">Selected Driver</span>
                      </ResizableColumnHeader>
                    )}
                    {visibleColumns.includes('selected_date') && (
                      <ResizableColumnHeader width={columnWidths.selected_date} onResize={(w) => updateColumnWidth('selected_date', w)}>
                        <span className="font-semibold">Selected Date</span>
                      </ResizableColumnHeader>
                    )}
                    {visibleColumns.includes('sidebar_width') && (
                      <ResizableColumnHeader width={columnWidths.sidebar_width} onResize={(w) => updateColumnWidth('sidebar_width', w)}>
                        <span className="font-semibold">Sidebar Width</span>
                      </ResizableColumnHeader>
                    )}
                    {visibleColumns.includes('theme') && (
                      <ResizableColumnHeader width={columnWidths.theme} onResize={(w) => updateColumnWidth('theme', w)}>
                        <span className="font-semibold">Theme</span>
                      </ResizableColumnHeader>
                    )}
                    {visibleColumns.includes('created') && (
                      <ResizableColumnHeader width={columnWidths.created} onResize={(w) => updateColumnWidth('created', w)}>
                        <span className="font-semibold">Created</span>
                      </ResizableColumnHeader>
                    )}
                    {visibleColumns.includes('updated') && (
                      <ResizableColumnHeader width={columnWidths.updated} onResize={(w) => updateColumnWidth('updated', w)}>
                        <span className="font-semibold">Updated</span>
                      </ResizableColumnHeader>
                    )}
                    {visibleColumns.includes('actions') && (
                      <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}>
                        <span className="font-semibold">Actions</span>
                      </ResizableColumnHeader>
                    )}
                  </tr>
                </thead>
                <tbody>
                 {displayedSettings
                   .sort((a, b) => {
                     // Primary sort: updated_date descending
                     const aUpdated = a.updated ? new Date(a.updated).getTime() : 0;
                     const bUpdated = b.updated ? new Date(b.updated).getTime() : 0;
                     if (aUpdated !== bUpdated) {
                       return bUpdated - aUpdated;
                     }
                     // Secondary sort: created_date descending
                     const aCreated = a.created ? new Date(a.created).getTime() : 0;
                     const bCreated = b.created ? new Date(b.created).getTime() : 0;
                     return bCreated - aCreated;
                   })
                   .map(setting => {
                   const selectedDriverName = setting.selected_driver_id 
                     ? (setting.selected_driver_id === 'all' ? 'All Drivers' : getUserName(setting.selected_driver_id))
                     : '-';

                   return (
                     <tr key={setting.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                       {visibleColumns.includes('user_name') && (
                         <td className="p-3 font-medium" style={{ color: 'var(--text-slate-900)' }}>{getUserName(setting.user_id)}</td>
                       )}
                       {visibleColumns.includes('device_type') && (
                         <td className="p-3">
                           <Badge variant={setting.device_type === 'Mobile' ? 'default' : 'secondary'}>
                             {setting.device_type || 'Unknown'}
                           </Badge>
                         </td>
                       )}
                       {visibleColumns.includes('selected_driver') && (
                         <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{selectedDriverName}</td>
                       )}
                       {visibleColumns.includes('selected_date') && (
                         <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{setting.selected_date || '-'}</td>
                       )}
                       {visibleColumns.includes('sidebar_width') && (
                         <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{setting.sidebar_width || 240}px</td>
                       )}
                       {visibleColumns.includes('theme') && (
                         <td className="p-3">
                           <Badge variant="secondary">{setting.theme_preference || 'auto'}</Badge>
                         </td>
                       )}
                       {visibleColumns.includes('created') && (
                         <td className="p-3 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                           {setting.created ? format(new Date(setting.created), 'MMM d, yyyy h:mm a') : '-'}
                         </td>
                       )}
                       {visibleColumns.includes('updated') && (
                         <td className="p-3 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                           {setting.updated ? format(new Date(setting.updated), 'MMM d, yyyy h:mm a') : '-'}
                         </td>
                       )}
                       {visibleColumns.includes('actions') && (
                         <td className="p-3">
                           <Button 
                             variant="destructive" 
                             size="sm"
                             onClick={() => handleDeleteSetting(setting.id)}
                           >
                             <Trash2 className="w-4 h-4" />
                           </Button>
                         </td>
                       )}
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
};

const CityDataTable = ({ cities, onEdit, onDelete, onDeleteSelected, isLoadingData }) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('cities');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_city_column_widths');
    return saved ? JSON.parse(saved) : {
      checkbox: 50,
      id: 120,
      name: 200,
      province: 150,
      country: 150,
      actions: 150
    };
  });

  const [selectedCities, setSelectedCities] = useState(new Set());

  const updateColumnWidth = useCallback((columnId, width) => {
    setColumnWidths(prev => {
      const newWidths = { ...prev, [columnId]: width };
      localStorage.setItem('admin_city_column_widths', JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedCities(new Set((cities || []).map(c => c.id)));
    } else {
      setSelectedCities(new Set());
    }
  };

  const handleSelectCity = (cityId, checked) => {
    setSelectedCities(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(cityId);
      } else {
        newSet.delete(cityId);
      }
      return newSet;
    });
  };

  const handleDeleteSelected = () => {
    const selectedCitiesArray = (cities || []).filter(c => selectedCities.has(c.id));
    onDeleteSelected(selectedCitiesArray);
    setSelectedCities(new Set());
  };

  const isAllSelected = (cities || []).length > 0 && selectedCities.size === (cities || []).length;
  const isSomeSelected = selectedCities.size > 0 && selectedCities.size < (cities || []).length;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-slate-900)' }}>
          <span>Cities</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl
              config={config}
              visibleColumns={visibleColumns}
              onToggle={toggleColumn}
            />
            {selectedCities.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteSelected}
                disabled={isLoadingData}
              >
                Delete Selected ({selectedCities.size})
              </Button>
            )}
          </div>
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-slate-500)' }}>List of all cities.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm table-fixed">
              <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)' }}>
                <tr>
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}>
                    <Checkbox
                      checked={isAllSelected}
                      onCheckedChange={handleSelectAll}
                      className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''}
                    />
                  </ResizableColumnHeader>
                  {visibleColumns.includes('id') && (
                    <ResizableColumnHeader width={columnWidths.id} onResize={(w) => updateColumnWidth('id', w)}>
                      <span className="font-semibold">ID</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('name') && (
                    <ResizableColumnHeader width={columnWidths.name} onResize={(w) => updateColumnWidth('name', w)}>
                      <span className="font-semibold">Name</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('province') && (
                    <ResizableColumnHeader width={columnWidths.province} onResize={(w) => updateColumnWidth('province', w)}>
                      <span className="font-semibold">Province/State</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('country') && (
                    <ResizableColumnHeader width={columnWidths.country} onResize={(w) => updateColumnWidth('country', w)}>
                      <span className="font-semibold">Country</span>
                    </ResizableColumnHeader>
                  )}
                  {visibleColumns.includes('actions') && (
                    <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}>
                      <span className="font-semibold">Actions</span>
                    </ResizableColumnHeader>
                  )}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading cities...</td></tr>
                ) : cities.length > 0 ? (
                  cities.map(city => (
                    <tr key={city.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <td className="p-2">
                        <Checkbox
                          checked={selectedCities.has(city.id)}
                          onCheckedChange={(checked) => handleSelectCity(city.id, checked)}
                        />
                      </td>
                      {visibleColumns.includes('id') && (
                        <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-500)' }} title={city.id}>{city.id.substring(0, 8)}...</td>
                      )}
                      {visibleColumns.includes('name') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{city.name}</td>
                      )}
                      {visibleColumns.includes('province') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{city.province}</td>
                      )}
                      {visibleColumns.includes('country') && (
                        <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{city.country}</td>
                      )}
                      {visibleColumns.includes('actions') && (
                        <td className="p-3 text-right">
                          <Button variant="outline" size="sm" onClick={() => onEdit(city)} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>Edit</Button>
                          <Button variant="destructive" size="sm" className="ml-2" onClick={() => onDelete(city)}>Delete</Button>
                        </td>
                      )}
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={{ color: 'var(--text-slate-500)' }}>No cities found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};


export default function AdminUtilities() {
  const queryClient = useQueryClient();
  const { 
    deliveries: contextDeliveries, 
    patients: contextPatients, 
    stores: contextStores, 
    users: contextUsers,
    appUsers: contextAppUsers,
    cities: contextCities,
    isDataLoaded: contextDataLoaded,
    refreshData 
  } = useAppData();
  
  const [currentUser, setCurrentUser] = useState(null);
  const [hasAccess, setHasAccess] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);



  const [activeDataTab, setActiveDataTab] = useState('deliveries');
  const [activeUtilityTab, setActiveUtilityTab] = useState('data');
  const [dataViewMode, setDataViewMode] = useState({}); // { tab: 'online' | 'offline' }

  const [isBackfilling, setIsBackfilling] = useState(false);

  const [isRefreshing, setIsRefreshing] = useState(false);

  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    description: '',
    onConfirm: () => {},
    confirmText: 'Delete',
    variant: 'destructive'
  });

  const [autoSelectDuplicateIds, setAutoSelectDuplicateIds] = useState([]);
  const [duplicateFilterMode, setDuplicateFilterMode] = useState(false);

  const [bulkDelete, setBulkDelete] = useState({
    open: false,
    running: false,
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    currentLabel: "",
    currentDelay: 0,
    retryQueue: 0,
    entityLabel: "",
  });

  const [deliveryFilterText, setDeliveryFilterText] = useState('');
  const [deliverySortColumn, setDeliverySortColumn] = useState('delivery_date');
  const [deliverySortDirection, setDeliverySortDirection] = useState('desc');
  const [selectedDeliveryYear, setSelectedDeliveryYear] = useState(() => new Date().getFullYear().toString());
  const [selectedDeliveryMonth, setSelectedDeliveryMonth] = useState(() => (new Date().getMonth() + 1).toString());
  const [selectedDriver, setSelectedDriver] = useState('all');
  const [availableDeliveryYears, setAvailableDeliveryYears] = useState([]);
  const [filtersReady, setFiltersReady] = useState(false);
  const [userSettingsLoaded, setUserSettingsLoaded] = useState(false);

  const [patientFilterText, setPatientFilterText] = useState('');
  const [patientSortColumn, setPatientSortColumn] = useState('full_name');
  const [patientSortDirection, setPatientSortDirection] = useState('asc');

  const [offlineDeliveries, setOfflineDeliveries] = useState([]);
  const [offlinePatients, setOfflinePatients] = useState([]);
  const [offlineStores, setOfflineStores] = useState([]);
  const [offlineAppUsers, setOfflineAppUsers] = useState([]);
  const [offlineCities, setOfflineCities] = useState([]);

  const [showRouteImport, setShowRouteImport] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [editingStatusId, setEditingStatusId] = useState(null);
  const [editingDriverId, setEditingDriverId] = useState(null);
  
  const refreshIntervalRef = useRef(null);

  const invalidate = async (entityName) => {
    let queryKey;
    switch (entityName) {
      case 'Patient': queryKey = ['patients']; break;
      case 'Store': queryKey = ['stores']; break;
      case 'User': queryKey = ['authUsers']; break;
      case 'AppUser': queryKey = ['appUsers']; break;
      case 'Delivery': queryKey = ['deliveries']; break;
      case 'ActiveDeliveries': queryKey = ['activeDeliveries']; break;
      case 'City': queryKey = ['cities']; break;
      default: return;
    }
    await queryClient.invalidateQueries({ queryKey });
  };

  const queryOptions = {
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  };

  const { data: fetchedPatients, isLoading: patientsLoading, refetch: refetchPatients } = useQuery({
    queryKey: ['patients'],
    queryFn: () => getData('Patient', 'full_name'),
    initialData: contextPatients?.length > 0 ? contextPatients : undefined,
    ...queryOptions
  });
  // Use context patients for real-time updates, or offline data if selected
  const patients = dataViewMode.patients === 'offline' ? offlinePatients : (contextPatients?.length > 0 ? contextPatients : (fetchedPatients || []));

  const { data: fetchedStores, isLoading: storesLoading, refetch: refetchStores } = useQuery({
    queryKey: ['stores'],
    queryFn: () => getData('Store', 'name'),
    initialData: contextStores?.length > 0 ? contextStores : undefined,
    ...queryOptions
  });
  const stores = dataViewMode.stores === 'offline' ? offlineStores : (contextStores?.length > 0 ? contextStores : (fetchedStores || []));

  const { data: authUsers, isLoading: authUsersLoading, refetch: refetchAuthUsers } = useQuery({
    queryKey: ['authUsers'],
    queryFn: () => getData('User', 'full_name'),
    initialData: contextUsers?.length > 0 ? contextUsers : undefined,
    ...queryOptions
  });

  const { data: fetchedAppUsers, isLoading: appUsersLoading, refetch: refetchAppUsers } = useQuery({
    queryKey: ['appUsers'],
    queryFn: () => getData('AppUser', 'user_name'),
    initialData: contextAppUsers?.length > 0 ? contextAppUsers : undefined,
    ...queryOptions
  });
  const appUsers = dataViewMode.users === 'offline' ? offlineAppUsers : (contextAppUsers?.length > 0 ? contextAppUsers : (fetchedAppUsers || []));

  const { data: fetchedCities, isLoading: citiesLoading, refetch: refetchCities } = useQuery({
    queryKey: ['cities'],
    queryFn: () => getData('City', 'name'),
    initialData: contextCities?.length > 0 ? contextCities : undefined,
    ...queryOptions
  });
  const cities = dataViewMode.cities === 'offline' ? offlineCities : (contextCities?.length > 0 ? contextCities : (fetchedCities || []));

  // CRITICAL: Disable automatic delivery loading - only load on explicit "Load Data" button click
  const [manualLoadTriggered, setManualLoadTriggered] = useState(false);
  
  const { data: fetchedDeliveries, isLoading: deliveriesLoading, refetch: refetchDeliveries } = useQuery({
    queryKey: ['deliveries'],
    queryFn: async () => {
      console.log('📊 [AdminUtilities] Fetching deliveries with filters...');
      
      // Build server-side filter to reduce data transfer
      const filter = {};
      
      // Year filter
      if (selectedDeliveryYear && selectedDeliveryYear !== 'all') {
        const year = parseInt(selectedDeliveryYear);
        const startDate = `${year}-01-01`;
        const endDate = `${year}-12-31`;
        filter.delivery_date = { $gte: startDate, $lte: endDate };
        
        // Month filter (only if year is selected)
        if (selectedDeliveryMonth !== 'all') {
          const month = parseInt(selectedDeliveryMonth);
          const monthStartDate = `${year}-${month.toString().padStart(2, '0')}-01`;
          const daysInMonth = new Date(year, month, 0).getDate();
          const monthEndDate = `${year}-${month.toString().padStart(2, '0')}-${daysInMonth}`;
          filter.delivery_date = { $gte: monthStartDate, $lte: monthEndDate };
        }
      }
      
      // Driver filter
      if (selectedDriver && selectedDriver !== 'all') {
        const targetDriver = driversForDropdown.find(d => d.user_name === selectedDriver);
        if (targetDriver) {
          filter.driver_id = targetDriver.id;
        }
      }
      
      console.log('📊 [AdminUtilities] Server-side filter:', filter);
      
      const deliveries = Object.keys(filter).length > 0 
        ? await Delivery.filter(filter, '-created_date', 5000)
        : await Delivery.list('-created_date', 5000);
        
      console.log(`✅ [AdminUtilities] Fetched ${deliveries?.length || 0} deliveries`);
      return deliveries;
    },
    enabled: filtersReady && manualLoadTriggered,
    initialData: undefined, // Never use context - admin needs fresh filtered data
    ...queryOptions
  });
  
  // Use ONLY fetched deliveries (not context) for admin view
  const allDeliveries = useMemo(() => {
    return dataViewMode.deliveries === 'offline' ? offlineDeliveries : (fetchedDeliveries || []);
  }, [fetchedDeliveries, dataViewMode.deliveries, offlineDeliveries]);


  const dataLoading = patientsLoading || storesLoading || authUsersLoading || appUsersLoading || citiesLoading || deliveriesLoading;

  const handleRefreshAllData = async () => {
    setIsRefreshing(true);
    console.log('🔄 [AdminUtilities] Starting manual data refresh...');
    
    try {
      // CRITICAL: Check if we're viewing offline data - reload from IndexedDB
      const { offlineDB } = await import('../components/utils/offlineDatabase');
      
      if (dataViewMode.deliveries === 'offline') {
        const data = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        setOfflineDeliveries(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline deliveries`);
      }
      if (dataViewMode.patients === 'offline') {
        const data = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
        setOfflinePatients(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline patients`);
      }
      if (dataViewMode.stores === 'offline') {
        const data = await offlineDB.getAll(offlineDB.STORES.STORES);
        setOfflineStores(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline stores`);
      }
      if (dataViewMode.users === 'offline') {
        const data = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        setOfflineAppUsers(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline app users`);
      }
      if (dataViewMode.cities === 'offline') {
        const data = await offlineDB.getAll(offlineDB.STORES.CITIES);
        setOfflineCities(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline cities`);
      }
      
      // Also invalidate and refetch online data
      await queryClient.invalidateQueries(['patients']);
      await queryClient.invalidateQueries(['stores']);
      await queryClient.invalidateQueries(['authUsers']);
      await queryClient.invalidateQueries(['appUsers']);
      await queryClient.invalidateQueries(['cities']);
      await queryClient.invalidateQueries(['deliveries']);
      
      await Promise.all([
        refetchPatients(),
        refetchStores(),
        refetchAuthUsers(),
        refetchAppUsers(),
        refetchCities(),
        refetchDeliveries()
      ]);
      
      await refreshData();
      
      console.log('✅ [AdminUtilities] Manual data refresh complete');
    } catch (error) {
      console.error('❌ [AdminUtilities] Error during manual refresh:', error);
      alert('Error refreshing data. Please try again.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const mergedUsers = useMemo(() => {
    if (!authUsers || !appUsers) return [];

    return authUsers
      .map((authUser) => {
        const appUser = appUsers.find((au) => au.user_id === authUser.id);
        if (!appUser) return null;

        return {
          ...authUser,
          ...appUser,
          id: authUser.id,
          user_name: appUser.user_name || authUser.full_name,
          app_roles: appUser.app_roles || ['driver'],
          status: appUser.status || 'active',
          display_name: appUser.user_name || authUser.full_name,
          first_name: (appUser.user_name || authUser.full_name).split(' ')[0]
        };
      })
      .filter(Boolean)
      .filter((u) => u.status === 'active');
  }, [authUsers, appUsers]);

  const driversForDropdown = useMemo(() => {
    if (!mergedUsers) return [];

    const drivers = mergedUsers.filter((user) => {
      const roles = user.app_roles || [];
      return roles.includes('driver') || roles.includes('admin');
    });
    
    return sortUsers(drivers);
  }, [mergedUsers]);


  const handleRouteImportComplete = async () => {
    console.log('✅ [AdminUtilities] Route import completed, refreshing data...');

    setShowRouteImport(false);

    try {
      console.log('🗑️ [AdminUtilities] Invalidating all relevant caches...');

      await invalidate('Delivery');
      await invalidate('Patient');
      await invalidate('Store');
      await invalidate('AppUser');
      await invalidate('User');
      await invalidate('City');

      console.log('🔄 [AdminUtilities] Triggering immediate refetches...');
      await Promise.all([
        refetchDeliveries(),
        refetchPatients(),
        refetchStores(),
        refetchAppUsers(),
        refetchAuthUsers(),
        refetchCities()
      ]);

      console.log('✅ [AdminUtilities] Data refresh complete after import');

      console.log('🔄 [AdminUtilities] Triggering global data refresh after route import');
      await refreshData();

    } catch (error) {
      console.error('❌ [AdminUtilities] Error during post-import refresh:', error);
      alert('Import completed but there was an error refreshing the display. Please try again.');
    } finally {
      setFiltersReady(true);
    }
  };


  // Load offline data when mode changes
  useEffect(() => {
    const loadOfflineData = async () => {
      try {
        const { offlineDB } = await import('../components/utils/offlineDatabase');
        
        if (dataViewMode.deliveries === 'offline') {
          const data = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
          setOfflineDeliveries(data || []);
          console.log(`📦 Loaded ${data?.length || 0} offline deliveries`);
        }
        if (dataViewMode.patients === 'offline') {
          const data = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
          setOfflinePatients(data || []);
          console.log(`📦 Loaded ${data?.length || 0} offline patients`);
        }
        if (dataViewMode.stores === 'offline') {
          const data = await offlineDB.getAll(offlineDB.STORES.STORES);
          setOfflineStores(data || []);
          console.log(`📦 Loaded ${data?.length || 0} offline stores`);
        }
        if (dataViewMode.users === 'offline') {
          const data = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
          setOfflineAppUsers(data || []);
          console.log(`📦 Loaded ${data?.length || 0} offline app users`);
        }
        if (dataViewMode.cities === 'offline') {
          const data = await offlineDB.getAll(offlineDB.STORES.CITIES);
          setOfflineCities(data || []);
          console.log(`📦 Loaded ${data?.length || 0} offline cities`);
        }
      } catch (error) {
        console.error('❌ Failed to load offline data:', error);
      }
    };
    
    loadOfflineData();
  }, [dataViewMode]);

  useEffect(() => {
    const checkAccess = async () => {
      try {
        const user = await getEffectiveUser();
        const realUserData = await User.me();
        setCurrentUser(user);
        setHasAccess(isAppOwner(realUserData));
        
        // Load user settings for Admin Utilities filters
        if (user?.id) {
          try {
            const settings = await loadUserSettings(user.id);
            console.log('📋 [AdminUtilities] Loaded user settings:', settings);
            
            if (settings.admin_utilities_year) {
              setSelectedDeliveryYear(settings.admin_utilities_year);
            }
            if (settings.admin_utilities_month) {
              setSelectedDeliveryMonth(settings.admin_utilities_month);
            }
            if (settings.admin_utilities_driver) {
              setSelectedDriver(settings.admin_utilities_driver);
            }
            setUserSettingsLoaded(true);
          } catch (settingsError) {
            console.warn('⚠️ [AdminUtilities] Error loading user settings:', settingsError);
            setUserSettingsLoaded(true);
          }
        }
      } catch (error) {
        console.error('Access check failed:', error);
        setHasAccess(false);
      } finally {
        setInitialLoading(false);
      }
    };
    checkAccess();
    
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, []);



  useEffect(() => {
    if (filtersReady) {
      return;
    }

    console.log('📊 [AdminUtilities] Calculating available years from metadata...');

    const currentYear = new Date().getFullYear();
    const estimatedYears = [currentYear, currentYear - 1, currentYear - 2].sort((a, b) => b - a);

    setAvailableDeliveryYears(estimatedYears);
    setFiltersReady(true);

    console.log('✅ [AdminUtilities] Filters ready, deliveries will now load');
  }, [filtersReady]);

  useEffect(() => {
    if (!filtersReady || !allDeliveries || deliveriesLoading) {
      return;
    }

    if (allDeliveries.length > 0) {
      const years = [...new Set(
        allDeliveries.map(d => d.delivery_date ? new Date(d.delivery_date).getFullYear() : null)
          .filter(Boolean)
      )].sort((a, b) => b - a);

      setAvailableDeliveryYears(years);
      console.log('📅 [AdminUtilities] Updated available years from actual data:', years);
    }
  }, [allDeliveries, deliveriesLoading, filtersReady]);

  // Simple polling for Admin Utilities - NO smart refresh filtering
  // Admin Utilities needs ALL data, not filtered incremental updates
  useEffect(() => {
    if (!filtersReady || dataLoading) {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      return;
    }

    console.log('🚀 [AdminUtilities] Starting simple polling (no smart refresh) for tab:', activeDataTab);

    const performRefresh = async () => {
      try {
        console.log('🔄 [AdminUtilities] Polling refetch for tab:', activeDataTab);
        
        switch (activeDataTab) {
          case 'deliveries':
            await refetchDeliveries();
            break;
          case 'patients':
            await refetchPatients();
            break;
          case 'stores':
            await refetchStores();
            break;
          case 'users':
            await refetchAppUsers();
            break;
          case 'cities':
            await refetchCities();
            break;
        }
      } catch (error) {
        console.error('❌ [AdminUtilities] Error during polling refresh:', error);
      }
    };

    // Poll every 30 seconds (less aggressive since this is admin view)
    refreshIntervalRef.current = setInterval(performRefresh, 30000);

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [activeDataTab, filtersReady, dataLoading, refetchDeliveries, refetchPatients, refetchStores, refetchAppUsers, refetchCities]);



  const handleSortChange = useCallback((column, currentSortColumn, currentSortDirection, setSortColumn, setSortDirection) => {
    if (currentSortColumn === column) {
      setSortDirection(currentSortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }, []);

  const handleDeliverySort = useCallback((column) =>
    handleSortChange(column, deliverySortColumn, deliverySortDirection, setDeliverySortColumn, setDeliverySortDirection),
    [handleSortChange, deliverySortColumn, deliverySortDirection]
  );

  const handlePatientSort = useCallback((column) => {
    handleSortChange(column, patientSortColumn, patientSortDirection, setPatientSortColumn, setPatientSortDirection);
  }, [handleSortChange, patientSortColumn, patientSortDirection]);


  const filteredAndSortedDeliveries = useMemo(() => {
    let filtered = allDeliveries || [];
    
    console.log(`📊 [AdminUtilities] filteredAndSortedDeliveries starting with ${filtered.length} deliveries`);
    console.log(`📊 [AdminUtilities] Filters: year=${selectedDeliveryYear}, month=${selectedDeliveryMonth}, driver=${selectedDriver}`);

    if (selectedDeliveryYear && selectedDeliveryYear !== 'all') {
      const year = parseInt(selectedDeliveryYear);
      const beforeFilter = filtered.length;
      filtered = filtered.filter(d => {
        if (!d.delivery_date || typeof d.delivery_date !== 'string') return false;
        const dateParts = d.delivery_date.split('-');
        if (dateParts.length === 3) {
          const deliveryYear = parseInt(dateParts[0]);
          return deliveryYear === year;
        }
        return false;
      });
      console.log(`📊 [AdminUtilities] Year filter (${year}): ${beforeFilter} → ${filtered.length}`);

      if (selectedDeliveryMonth !== 'all') {
        const month = parseInt(selectedDeliveryMonth);
        const beforeMonthFilter = filtered.length;
        filtered = filtered.filter(d => {
          if (!d.delivery_date || typeof d.delivery_date !== 'string') return false;
          const dateParts = d.delivery_date.split('-');
          if (dateParts.length === 3) {
            const deliveryMonth = parseInt(dateParts[1]);
            return deliveryMonth === month;
          }
          return false;
        });
        console.log(`📊 [AdminUtilities] Month filter (${month}): ${beforeMonthFilter} → ${filtered.length}`);
      }
    } else if (selectedDeliveryYear === 'all' && selectedDeliveryMonth !== 'all') {
      const month = parseInt(selectedDeliveryMonth);
      const beforeFilter = filtered.length;
      filtered = filtered.filter(d => {
        if (!d.delivery_date || typeof d.delivery_date !== 'string') return false;
        const dateParts = d.delivery_date.split('-');
        if (dateParts.length === 3) {
          const deliveryMonth = parseInt(dateParts[1]);
          return deliveryMonth === month;
        }
        return false;
      });
      console.log(`📊 [AdminUtilities] Month-only filter (${month}): ${beforeFilter} → ${filtered.length}`);
    }

    if (selectedDriver && selectedDriver !== 'all') {
      const targetDriver = driversForDropdown.find(d => d.user_name === selectedDriver);
      if (targetDriver) {
        filtered = filtered.filter(delivery => 
          delivery.driver_id === targetDriver.id || 
          delivery.driver_name === targetDriver.full_name ||
          delivery.driver_name === targetDriver.user_name
        );
      }
    }


    filtered = filtered.filter(delivery => {
      const patient = (patients || []).find(p => p.id === delivery.patient_id);
      const store = (stores || []).find(s => s.id === delivery.store_id);
      const patientName = patient?.full_name || 'Store Pickup';
      const address = patient?.address || store?.address || 'Unknown Address';
      const unitNumber = patient?.unit_number ? `, Unit: ${patient.unit_number}` : '';
      const stopId = delivery.stop_id ? String(delivery.stop_id) : '';
      const patientId = patient?.patient_id ? String(patient.patient_id) : '';
      const trackingNumber = delivery.tracking_number ? String(delivery.tracking_number) : '';
      const stopOrder = delivery.stop_order ? String(delivery.stop_order) : '';

      const searchText = deliveryFilterText.toLowerCase();

      return (
        searchText === '' ||
        patientName.toLowerCase().includes(searchText) ||
        (address + unitNumber).toLowerCase().includes(searchText) ||
        (delivery.status && delivery.status.toLowerCase().includes(searchText)) ||
        stopId.includes(searchText) ||
        patientId.includes(searchText) ||
        trackingNumber.includes(searchText) ||
        stopOrder.includes(searchText)
      );
    });

    if (deliverySortColumn) {
      filtered.sort((a, b) => {
        const getTimeValue = (delivery) => {
          if (delivery.actual_delivery_time) {
            try {
              const date = new Date(delivery.actual_delivery_time);
              if (!isNaN(date.getTime())) {
                return date.getHours() * 60 + date.getMinutes();
              }
            } catch (e) {
              // Fallback
            }
          }
          if (delivery.delivery_time_eta) {
            const timeParts = delivery.delivery_time_eta.match(/(\d{2}):(\d{2})/);
            if (timeParts) {
              const hours = parseInt(timeParts[1]);
              const minutes = parseInt(timeParts[2]);
              return hours * 60 + minutes;
            }
          }
          return 9999;
        };

        if (deliverySortColumn === 'stop_order') {
          const aOrder = a.stop_order ?? 99999;
          const bOrder = b.stop_order ?? 99999;
          
          if (aOrder !== bOrder) {
            return deliverySortDirection === 'asc' ? aOrder - bOrder : bOrder - aOrder;
          }
          
          const aDate = a.delivery_date || '';
          const bDate = b.delivery_date || '';
          
          const dateComparison = deliverySortDirection === 'asc' ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
          if (dateComparison !== 0) {
              return dateComparison;
          }
          
          const aTime = getTimeValue(a);
          const bTime = getTimeValue(b);
          
          return deliverySortDirection === 'asc' ? aTime - bTime : bTime - aTime;
        } else if (deliverySortColumn === 'delivery_date') {
          const aDate = a.delivery_date || '';
          const bDate = b.delivery_date || '';
          
          const dateComparison = deliverySortDirection === 'asc' ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
          if (dateComparison !== 0) {
              return dateComparison;
          }
          
          const aTime = getTimeValue(a);
          const bTime = getTimeValue(b);
          
          return deliverySortDirection === 'asc' ? aTime - bTime : bTime - aTime;
        } else {
          const aValue = a[deliverySortColumn];
          const bValue = b[deliverySortColumn];

          if (aValue === null || aValue === undefined) return deliverySortDirection === 'asc' ? 1 : -1;
          if (bValue === null || bValue === undefined) return deliverySortDirection === 'asc' ? -1 : 1;

          if (typeof aValue === 'string' && typeof bValue === 'string') {
            return deliverySortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
          }
          if (typeof aValue === 'number' && typeof bValue === 'number') {
            return deliverySortDirection === 'asc' ? aValue - bValue : bValue - aValue;
          }
          return 0;
        }
      });
    }
    return filtered;
  }, [allDeliveries, selectedDeliveryYear, selectedDeliveryMonth, selectedDriver, driversForDropdown, patients, stores, deliveryFilterText, deliverySortColumn, deliverySortDirection]);


  const filteredPatientsForDetectDuplicates = useMemo(() => {
    if (!patients || !Array.isArray(patients)) {
      console.warn('[AdminUtilities] filteredPatientsForDetectDuplicates: patients is not an array');
      return [];
    }
    
    return patients; 
  }, [patients]);

  const performBulkDeletePatients = useCallback(async (patientsToDelete) => {
    if (!patientsToDelete || !Array.isArray(patientsToDelete)) {
      console.error('[AdminUtilities] performBulkDeletePatients: Invalid input - not an array:', typeof patientsToDelete);
      alert('Error: Invalid data provided for deletion. Please refresh and try again.');
      return;
    }
    
    if (patientsToDelete.length === 0) {
      console.warn('[AdminUtilities] performBulkDeletePatients: Empty array provided');
      alert('No patients to delete.');
      return;
    }

    const count = patientsToDelete.length;

    let delayMs = 100;
    let trend = 'up';
    let opsSinceDelayChange = 0;
    let segmentFailures = 0;

    setBulkDelete({
      open: true,
      running: true,
      total: count,
      processed: 0,
      success: 0,
      failed: 0,
      currentLabel: "",
      currentDelay: delayMs,
      retryQueue: 0,
      entityLabel: "Patients"
    });

    const failedDeletions = [];
    try {
      let successCount = 0;
      let failCount = 0;
      let processed = 0;

      for (const patient of patientsToDelete) {
        if (!patient || !patient.id) {
          console.warn('[AdminUtilities] Skipping invalid patient:', patient);
          processed++;
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        const label = patient.full_name || patient.id;

        const { deletePatientLocal } = await import('../components/utils/offlineMutations');
        try {
          await deletePatientLocal(patient.id);
          successCount++;
        } catch (error) {
          console.error(`Failed to delete patient ${patient.id}:`, error);
          failCount++;
          segmentFailures++;
          failedDeletions.push(patient);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } finally {
          processed++;
          setBulkDelete(prev => ({
            ...prev,
            processed,
            success: successCount,
            failed: failCount,
            currentLabel: label,
            currentDelay: delayMs,
            retryQueue: failedDeletions.length
          }));

          opsSinceDelayChange++;
          if (opsSinceDelayChange >= 75) {
            if (segmentFailures === 0) {
              if (trend === 'up') {
                delayMs = Math.min(300, delayMs + 25);
                if (delayMs === 300) trend = 'down';
              } else if (trend === 'down') {
                delayMs = Math.max(100, delayMs - 25);
                if (delayMs === 100) trend = 'up';
              }
            }
            opsSinceDelayChange = 0;
            segmentFailures = 0;
            setBulkDelete(prev => ({ ...prev, currentDelay: delayMs }));
          }
        }
      }

      if (failedDeletions.length > 0) {
        console.log(`Retrying ${failedDeletions.length} failed patient deletions...`);
        const retryDelay = 500;
        setBulkDelete(prev => ({ ...prev, retryQueue: failedDeletions.length }));

        for (let i = 0; i < failedDeletions.length; i++) {
          const p = failedDeletions[i];
          if (!p || !p.id) continue;
          
          const label = p.full_name || p.id;

          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          const { deletePatientLocal } = await import('../components/utils/offlineMutations');
          try {
            await deletePatientLocal(p.id);
            setBulkDelete(prev => ({
              ...prev,
              processed: prev.processed + 1,
              success: prev.success + 1,
              failed: prev.failed - 1,
              currentLabel: label,
              currentDelay: retryDelay,
              retryQueue: Math.max(0, prev.retryQueue - 1)
            }));
          } catch (error) {
            console.error(`Retry failed for patient ${p.id}:`, error);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            setBulkDelete(prev => ({
              ...prev,
              processed: prev.processed + 1,
              failed: prev.failed + 1,
              currentLabel: label,
              currentDelay: retryDelay,
              retryQueue: Math.max(0, prev.retryQueue - 1)
            }));
          }
        }
      }

      setBulkDelete(prev => ({ ...prev, running: false, currentLabel: "" }));
      queryClient.invalidateQueries(['patients']);
      await refetchPatients();
      
      console.log('🔄 [AdminUtilities] Triggering global data refresh after bulk patient delete');
      await refreshData();
    } catch (error) {
      console.error('Error during bulk patient delete:', error);
      setBulkDelete(prev => ({ ...prev, running: false }));
    }
  }, [queryClient, refetchPatients, refreshData]);


  // Optimized batch delete for duplicates - deletes in chunks with minimal delays
  const performBulkDeleteDeliveriesBatch = useCallback(async (deliveriesToDelete) => {
    if (!deliveriesToDelete || !Array.isArray(deliveriesToDelete) || deliveriesToDelete.length === 0) {
      alert('No deliveries to delete.');
      return;
    }

    const count = deliveriesToDelete.length;

    setBulkDelete({
      open: true,
      running: true,
      total: count,
      processed: 0,
      success: 0,
      failed: 0,
      currentLabel: "Processing batch deletes...",
      currentDelay: 0,
      retryQueue: 0,
      entityLabel: "Duplicate Deliveries"
    });

    try {
      console.log(`🗑️ [AdminUtilities] Starting batch delete of ${count} duplicates...`);
      
      // Delete in batches of 50 (much faster than one-at-a-time)
      const BATCH_SIZE = 50;
      let successCount = 0;
      let failCount = 0;
      
      for (let i = 0; i < deliveriesToDelete.length; i += BATCH_SIZE) {
        const batch = deliveriesToDelete.slice(i, i + BATCH_SIZE);
        
        setBulkDelete(prev => ({
          ...prev,
          currentLabel: `Batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(count / BATCH_SIZE)}`,
        }));
        
        // Delete all in this batch with minimal delay
        for (const delivery of batch) {
          try {
            await Delivery.delete(delivery.id);
            successCount++;
          } catch (error) {
            console.error(`Failed to delete ${delivery.id}:`, error);
            failCount++;
          }
          await new Promise(resolve => setTimeout(resolve, 50)); // Minimal 50ms delay
        }
        
        setBulkDelete(prev => ({
          ...prev,
          processed: Math.min(i + BATCH_SIZE, count),
          success: successCount,
          failed: failCount,
        }));
        
        console.log(`✅ [AdminUtilities] Batch ${Math.floor(i / BATCH_SIZE) + 1} complete: ${successCount} deleted, ${failCount} failed`);
      }

      setBulkDelete(prev => ({ ...prev, running: false, currentLabel: "" }));
      
      // Reload offline data if in offline mode
      if (dataViewMode.deliveries === 'offline') {
        const { offlineDB } = await import('../components/utils/offlineDatabase');
        const data = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        setOfflineDeliveries(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline deliveries after delete`);
      }
      
      queryClient.invalidateQueries(['deliveries']);
      await refetchDeliveries();
      
      console.log('🔄 [AdminUtilities] Triggering global data refresh after batch delete');
      await refreshData();
      
      console.log(`✅ [AdminUtilities] Batch delete complete: ${successCount} deleted, ${failCount} failed`);
    } catch (error) {
      console.error('Error during batch delivery delete:', error);
      setBulkDelete(prev => ({ ...prev, running: false }));
    }
  }, [queryClient, refetchDeliveries, refreshData]);

  const performBulkDeleteDeliveries = useCallback(async (deliveriesToDelete) => {
    if (!deliveriesToDelete || !Array.isArray(deliveriesToDelete)) {
      console.error('[AdminUtilities] performBulkDeleteDeliveries: Invalid input - not an array:', typeof deliveriesToDelete);
      alert('Error: Invalid data provided for deletion. Please refresh and try again.');
      return;
    }
    
    if (deliveriesToDelete.length === 0) {
      console.warn('[AdminUtilities] performBulkDeleteDeliveries: Empty array provided');
      alert('No deliveries to delete.');
      return;
    }

    const count = deliveriesToDelete.length;

    let delayMs = 100;
    let trend = 'up';
    let opsSinceDelayChange = 0;
    let segmentFailures = 0;

    setBulkDelete({
      open: true,
      running: true,
      total: count,
      processed: 0,
      success: 0,
      failed: 0,
      currentLabel: "",
      currentDelay: delayMs,
      retryQueue: 0,
      entityLabel: "Deliveries"
    });

    const failedDeletions = [];
    try {
      let successCount = 0;
      let failCount = 0;
      let processed = 0;

      for (const delivery of deliveriesToDelete) {
        if (!delivery || !delivery.id) {
          console.warn('[AdminUtilities] Skipping invalid delivery:', delivery);
          processed++;
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        const label = delivery.tracking_number || delivery.id;

        try {
          // CRITICAL: Delete from backend AND offline DB
          await Delivery.delete(delivery.id);
          const { offlineDB } = await import('../components/utils/offlineDatabase');
          await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id);
          
          // Update offline state if viewing offline data
          if (dataViewMode.deliveries === 'offline') {
            setOfflineDeliveries(prev => prev.filter(d => d.id !== delivery.id));
          }
          
          successCount++;
        } catch (error) {
          console.error(`Failed to delete delivery ${delivery.id}:`, error);
          failCount++;
          segmentFailures++;
          failedDeletions.push(delivery);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } finally {
          processed++;
          setBulkDelete(prev => ({
            ...prev,
            processed,
            success: successCount,
            failed: failCount,
            currentLabel: label,
            currentDelay: delayMs,
            retryQueue: failedDeletions.length
          }));

          opsSinceDelayChange++;
          if (opsSinceDelayChange >= 75) {
            if (segmentFailures === 0) {
              if (trend === 'up') {
                delayMs = Math.min(300, delayMs + 25);
                if (delayMs === 300) trend = 'down';
              } else if (trend === 'down') {
                delayMs = Math.max(100, delayMs - 25);
                if (delayMs === 100) trend = 'up';
              }
            }
            opsSinceDelayChange = 0;
            segmentFailures = 0;
            setBulkDelete(prev => ({ ...prev, currentDelay: delayMs }));
          }
        }
      }

      if (failedDeletions.length > 0) {
        console.log(`Retrying ${failedDeletions.length} failed delivery deletions...`);
        const retryDelay = 500;
        setBulkDelete(prev => ({ ...prev, retryQueue: failedDeletions.length }));

        for (let i = 0; i < failedDeletions.length; i++) {
          const d = failedDeletions[i];
          if (!d || !d.id) continue;
          
          const label = d.tracking_number || d.id;

          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          try {
            // CRITICAL: Delete from backend AND offline DB
            await Delivery.delete(d.id);
            const { offlineDB } = await import('../components/utils/offlineDatabase');
            await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id);
            
            // Update offline state if viewing offline data
            if (dataViewMode.deliveries === 'offline') {
              setOfflineDeliveries(prev => prev.filter(del => del.id !== d.id));
            }
            
            setBulkDelete(prev => ({
              ...prev,
              processed: prev.processed + 1,
              success: prev.success + 1,
              failed: prev.failed - 1,
              currentLabel: label,
              currentDelay: retryDelay,
              retryQueue: Math.max(0, prev.retryQueue - 1)
            }));
          } catch (error) {
            console.error(`Retry failed for delivery ${d.id}:`, error);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            setBulkDelete(prev => ({
              ...prev,
              processed: prev.processed + 1,
              failed: prev.failed + 1,
              currentLabel: label,
              currentDelay: retryDelay,
              retryQueue: Math.max(0, prev.retryQueue - 1)
            }));
          }
        }
      }

      setBulkDelete(prev => ({ ...prev, running: false, currentLabel: "" }));
      
      // Reload offline data if in offline mode
      if (dataViewMode.deliveries === 'offline') {
        const { offlineDB } = await import('../components/utils/offlineDatabase');
        const data = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        setOfflineDeliveries(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline deliveries after delete`);
      }
      
      queryClient.invalidateQueries(['deliveries']);
      await refetchDeliveries();
      
      console.log('🔄 [AdminUtilities] Triggering global data refresh after bulk delivery delete');
      await refreshData();
    } catch (error) {
      console.error('Error during bulk delivery delete:', error);
      setBulkDelete(prev => ({ ...prev, running: false }));
    }
  }, [queryClient, refetchDeliveries, refreshData]);

  const _confirmDeleteAllDeliveries = useCallback(() => {
    const count = filteredAndSortedDeliveries.length;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} Deliveries?`,
      description: `⚠️ WARNING: This will permanently delete ${count} deliveries that are currently filtered. This action CANNOT be undone. Are you absolutely sure?`,
      confirmText: 'Yes, Delete All',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteDeliveries(filteredAndSortedDeliveries)
    });
  }, [filteredAndSortedDeliveries, performBulkDeleteDeliveries]);

  const _confirmDeleteSelectedDeliveries = useCallback((deliveriesToDelete) => {
    const count = deliveriesToDelete.length;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} Selected Deliveries?`,
      description: `This will permanently delete ${count} selected deliveries. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteDeliveries(deliveriesToDelete)
    });
  }, [performBulkDeleteDeliveries]);

  const _confirmDeleteAllPatients = useCallback((patientsToDelete) => {
    const count = patientsToDelete.length;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} Patients?`,
      description: `⚠️ WARNING: This will permanently delete ${count} patients that are currently filtered. This action CANNOT be undone. Are you absolutely sure?`,
      confirmText: 'Yes, Delete All',
      variant: 'destructive',
      onConfirm: () => performBulkDeletePatients(patientsToDelete)
    });
  }, [performBulkDeletePatients]);

  const _confirmDeleteSelectedPatients = useCallback((patientsToDelete) => {
    const count = patientsToDelete.length;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} Selected Patients?`,
      description: `This will permanently delete ${count} selected patients. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeletePatients(patientsToDelete)
    });
  }, [performBulkDeletePatients]);

  const performBulkDeleteStores = useCallback(async (storesToDelete) => {
    if (!storesToDelete || !Array.isArray(storesToDelete) || storesToDelete.length === 0) {
      alert('No stores to delete.');
      return;
    }

    setBulkDelete({
      open: true, running: true, total: storesToDelete.length, processed: 0, success: 0, failed: 0,
      currentLabel: "", currentDelay: 100, retryQueue: 0, entityLabel: "Stores"
    });

    let successCount = 0, failCount = 0;
    for (const store of storesToDelete) {
      if (!store || !store.id) continue;
      try {
        await Store.delete(store.id);
        successCount++;
      } catch (error) {
        console.error(`Failed to delete store ${store.id}:`, error);
        failCount++;
      }
      setBulkDelete(prev => ({
        ...prev, processed: prev.processed + 1, success: successCount, failed: failCount, currentLabel: store.name || store.id
      }));
      await new Promise(r => setTimeout(r, 100));
    }

    setBulkDelete(prev => ({ ...prev, running: false }));
    await refetchStores();
    await refreshData();
  }, [refetchStores, refreshData]);

  const _confirmDeleteSelectedStores = useCallback((storesToDelete) => {
    setConfirmDialog({
      open: true,
      title: `Delete ${storesToDelete.length} Selected Stores?`,
      description: `This will permanently delete ${storesToDelete.length} selected stores. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteStores(storesToDelete)
    });
  }, [performBulkDeleteStores]);

  const performBulkDeleteUsers = useCallback(async (usersToDelete) => {
    if (!usersToDelete || !Array.isArray(usersToDelete) || usersToDelete.length === 0) {
      alert('No users to delete.');
      return;
    }

    setBulkDelete({
      open: true, running: true, total: usersToDelete.length, processed: 0, success: 0, failed: 0,
      currentLabel: "", currentDelay: 100, retryQueue: 0, entityLabel: "App Users"
    });

    let successCount = 0, failCount = 0;
    for (const user of usersToDelete) {
      if (!user || !user.id) continue;
      try {
        await AppUser.delete(user.id);
        successCount++;
      } catch (error) {
        console.error(`Failed to delete user ${user.id}:`, error);
        failCount++;
      }
      setBulkDelete(prev => ({
        ...prev, processed: prev.processed + 1, success: successCount, failed: failCount, currentLabel: user.user_name || user.id
      }));
      await new Promise(r => setTimeout(r, 100));
    }

    setBulkDelete(prev => ({ ...prev, running: false }));
    await refetchAppUsers();
    await refreshData();
  }, [refetchAppUsers, refreshData]);

  const _confirmDeleteSelectedUsers = useCallback((usersToDelete) => {
    setConfirmDialog({
      open: true,
      title: `Delete ${usersToDelete.length} Selected Users?`,
      description: `This will permanently delete ${usersToDelete.length} selected app users. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteUsers(usersToDelete)
    });
  }, [performBulkDeleteUsers]);

  const performBulkDeleteCities = useCallback(async (citiesToDelete) => {
    if (!citiesToDelete || !Array.isArray(citiesToDelete) || citiesToDelete.length === 0) {
      alert('No cities to delete.');
      return;
    }

    setBulkDelete({
      open: true, running: true, total: citiesToDelete.length, processed: 0, success: 0, failed: 0,
      currentLabel: "", currentDelay: 100, retryQueue: 0, entityLabel: "Cities"
    });

    let successCount = 0, failCount = 0;
    for (const city of citiesToDelete) {
      if (!city || !city.id) continue;
      try {
        await City.delete(city.id);
        successCount++;
      } catch (error) {
        console.error(`Failed to delete city ${city.id}:`, error);
        failCount++;
      }
      setBulkDelete(prev => ({
        ...prev, processed: prev.processed + 1, success: successCount, failed: failCount, currentLabel: city.name || city.id
      }));
      await new Promise(r => setTimeout(r, 100));
    }

    setBulkDelete(prev => ({ ...prev, running: false }));
    await refetchCities();
    await refreshData();
  }, [refetchCities, refreshData]);

  const _confirmDeleteSelectedCities = useCallback((citiesToDelete) => {
    setConfirmDialog({
      open: true,
      title: `Delete ${citiesToDelete.length} Selected Cities?`,
      description: `This will permanently delete ${citiesToDelete.length} selected cities. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteCities(citiesToDelete)
    });
  }, [performBulkDeleteCities]);

  const handleFindDuplicates = useCallback(async (deliveriesToProcess, onAutoSelect) => {
    console.log(`🔍 Finding duplicates in ${deliveriesToProcess?.length || 0} deliveries...`);
    console.log('📊 Data source:', dataViewMode.deliveries === 'offline' ? 'OFFLINE' : 'ONLINE');
    console.log('📊 Sample deliveries:', deliveriesToProcess?.slice(0, 3).map(d => ({ sid: d.stop_id, date: d.delivery_date, driver_id: d.driver_id })));
    
    if (!deliveriesToProcess || deliveriesToProcess.length === 0) {
      console.warn('⚠️ No deliveries to process');
      setConfirmDialog({
        open: true,
        title: '⚠️ No Data',
        description: 'No deliveries to search. Please load data first.',
        confirmText: 'OK',
        variant: 'destructive',
        onConfirm: () => {}
      });
      return;
    }
    
    const duplicateGroups = new Map();
    
    deliveriesToProcess.forEach(d => {
      if (!d) {
        console.warn('⚠️ Null delivery');
        return;
      }
      
      const sid = d.stop_id?.toString() || '';
      const date = d.delivery_date || '';
      const driverId = d.driver_id || '';
      
      // Skip if no SID
      if (!sid || !date) {
        return;
      }
      
      const key = `${sid}|${date}|${driverId}`;
      if (!duplicateGroups.has(key)) {
        duplicateGroups.set(key, []);
      }
      duplicateGroups.get(key).push(d);
    });
    
    console.log(`📊 Found ${duplicateGroups.size} unique SID+Date+Driver combinations`);
    
    const duplicateIds = [];
    
    duplicateGroups.forEach((group, key) => {
      console.log(`📊 Group "${key}": ${group.length} deliveries`);
      if (group.length > 1) {
        // Keep all duplicates EXCEPT the oldest (which is first after sorting)
        const sorted = [...group].sort((a, b) => new Date(a.created_date || 0) - new Date(b.created_date || 0));
        sorted.slice(1).forEach(d => duplicateIds.push(d.id));
      }
    });
    
    console.log(`✅ Found ${duplicateIds.length} duplicates to mark`);
    
    if (duplicateIds.length === 0) {
      setConfirmDialog({
        open: true,
        title: '⚠️ No Duplicates Found',
        description: 'No duplicates found in the current filtered list.\n\nDuplicates are identified by matching:\n• Stop ID (SID)\n• Delivery Date\n• Driver',
        confirmText: 'OK',
        variant: 'destructive',
        onConfirm: () => {}
      });
      return;
    }
    
    // Auto-select the duplicate checkboxes and activate duplicate filter mode
    console.log(`✅ Auto-selecting ${duplicateIds.length} duplicate deliveries`);
    setDuplicateFilterMode(true);
    if (onAutoSelect) {
      onAutoSelect(duplicateIds);
    }
    
  }, [dataViewMode.deliveries]);



  const handleStatusChange = useCallback(async (delivery, newStatus) => {
    try {
      const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
      await updateDeliveryLocal(delivery.id, { status: newStatus });
      setEditingStatusId(null);
      await refetchDeliveries();
    } catch (error) {
      console.error('Failed to update status:', error);
      alert('Failed to update status: ' + error.message);
    }
  }, [refetchDeliveries]);

  const handleDriverChange = useCallback(async (delivery, newDriverId) => {
    try {
      const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
      const driver = driversForDropdown.find(d => d && d.id === newDriverId);
      const driverName = driver ? getDriverDisplayName(driver) : '';
      
      await updateDeliveryLocal(delivery.id, { 
        driver_id: newDriverId,
        driver_name: driverName
      });
      setEditingDriverId(null);
      await refetchDeliveries();
    } catch (error) {
      console.error('Failed to update driver:', error);
      alert('Failed to update driver: ' + error.message);
    }
  }, [driversForDropdown, refetchDeliveries]);

  const handleEditEntity = (entity) => {
    console.log('Edit entity:', entity);
    
    // If it's a delivery, open the form
    if (activeDataTab === 'deliveries') {
      setEditingDelivery(entity);
      return;
    }
    
    // For other entities, show message
    alert('Edit functionality not implemented yet. Please use the dedicated management pages (Patients, Stores, etc.) to edit records.');
  };

  const handleDeleteEntity = useCallback(async (entity) => {
    const entityType = activeDataTab;
    let entityName = '';
    let EntityClass = null;

    switch (entityType) {
      case 'patients':
        entityName = entity.full_name || entity.id;
        EntityClass = Patient;
        break;
      case 'deliveries':
        entityName = `Delivery ${entity.tracking_number || entity.id}`;
        EntityClass = Delivery;
        break;
      case 'stores':
        entityName = entity.name || entity.id;
        EntityClass = Store;
        break;
      case 'users':
        entityName = entity.user_name || entity.id;
        EntityClass = AppUser;
        break;
      case 'cities':
        entityName = entity.name || entity.id;
        EntityClass = City;
        break;
      default:
        alert('Unknown entity type');
        return;
    }

    setConfirmDialog({
      open: true,
      title: `Delete ${entityName}?`,
      description: `⚠️ Are you sure you want to delete "${entityName}"? This action cannot be undone.`,
      confirmText: 'Delete',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          console.log(`Deleting ${entityType}:`, entity.id);
          const { offlineDB } = await import('../components/utils/offlineDatabase');
          
          // Delete from backend AND offline DB
          if (entityType === 'patients') {
            await Patient.delete(entity.id);
            await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, entity.id);
            if (dataViewMode.patients === 'offline') {
              setOfflinePatients(prev => prev.filter(p => p.id !== entity.id));
            }
          } else if (entityType === 'deliveries') {
            await Delivery.delete(entity.id);
            await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, entity.id);
            if (dataViewMode.deliveries === 'offline') {
              setOfflineDeliveries(prev => prev.filter(d => d.id !== entity.id));
            }
          } else if (entityType === 'stores') {
            await Store.delete(entity.id);
            await offlineDB.deleteRecord(offlineDB.STORES.STORES, entity.id);
            if (dataViewMode.stores === 'offline') {
              setOfflineStores(prev => prev.filter(s => s.id !== entity.id));
            }
          } else if (entityType === 'users') {
            await AppUser.delete(entity.id);
            await offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, entity.id);
            if (dataViewMode.users === 'offline') {
              setOfflineAppUsers(prev => prev.filter(u => u.id !== entity.id));
            }
          } else if (entityType === 'cities') {
            await City.delete(entity.id);
            await offlineDB.deleteRecord(offlineDB.STORES.CITIES, entity.id);
            if (dataViewMode.cities === 'offline') {
              setOfflineCities(prev => prev.filter(c => c.id !== entity.id));
            }
          }
          
          console.log(`✅ Successfully deleted ${entityName}`);

          await invalidate(EntityClass.name);

          switch (entityType) {
            case 'patients':
              await refetchPatients();
              break;
            case 'deliveries':
              await refetchDeliveries();
              break;
            case 'stores':
              await refetchStores();
              break;
            case 'users':
              await refetchAppUsers();
              break;
            case 'cities':
              await refetchCities();
              break;
          }

          console.log('🔄 [AdminUtilities] Triggering global data refresh after entity delete');
          await refreshData();

          alert(`✅ Successfully deleted "${entityName}"`);
        } catch (error) {
          console.error(`❌ Failed to delete ${entityName}:`, error);
          alert(`❌ Failed to delete "${entityName}": ${error.message}`);
        }
      }
    });
  }, [activeDataTab, dataViewMode, invalidate, refetchPatients, refetchDeliveries, refetchStores, refetchAppUsers, refetchCities, refreshData]);


  if (initialLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        <span className="ml-3 text-lg" style={{ color: 'var(--text-slate-600)' }}>Loading initial data...</span>
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Card className="p-8 text-center" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <AlertCircle className="w-12 h-12 mx-auto mb-4 text-red-500" />
          <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-slate-900)' }}>Access Denied</h2>
          <p style={{ color: 'var(--text-slate-600)' }}>Only app owners can access this page.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-2 md:p-3" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-full mx-auto space-y-4 md:space-y-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 md:gap-0">
          <div className="flex items-center gap-2 md:gap-3">
            <h1 className="text-xl md:text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Admin Utilities</h1>
          </div>
          <SmartRefreshIndicator inline={true} onManualRefresh={handleRefreshAllData} />
        </div>

        <Tabs value={activeUtilityTab} onValueChange={setActiveUtilityTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-1 md:gap-0 h-auto md:h-10">
            <TabsTrigger value="data" className="text-xs md:text-sm px-2 md:px-4 py-2">Data</TabsTrigger>
            <TabsTrigger value="store-metrics" className="text-xs md:text-sm px-2 md:px-4 py-2">Metrics</TabsTrigger>
            <TabsTrigger value="user-settings" className="text-xs md:text-sm px-2 md:px-4 py-2 hidden md:block">Settings</TabsTrigger>
            <TabsTrigger value="app-settings" className="text-xs md:text-sm px-2 md:px-4 py-2 hidden md:block">App</TabsTrigger>
            <TabsTrigger value="message-rules" className="text-xs md:text-sm px-2 md:px-4 py-2 hidden lg:block">Messages</TabsTrigger>
            <TabsTrigger value="polylines" className="text-xs md:text-sm px-2 md:px-4 py-2 hidden lg:block">Routes</TabsTrigger>
            <TabsTrigger value="api-logs" className="text-xs md:text-sm px-2 md:px-4 py-2 hidden lg:block">Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="data">
            {(dataLoading && activeDataTab !== 'deliveries') || (dataLoading && activeDataTab === 'deliveries' && !allDeliveries?.length) ? (
              <div className="flex justify-center items-center h-60">
                <Loader2 className="h-10 w-10 animate-spin text-emerald-500" />
                <span className="ml-3 text-lg text-slate-600">Loading data...</span>
              </div>
            ) : (
              <div className="space-y-6">
                <Tabs value={activeDataTab} onValueChange={setActiveDataTab} className="w-full">
                   <TabsList className="grid w-full grid-cols-3 md:grid-cols-5 gap-1 md:gap-0 h-auto md:h-10">
                     <TabsTrigger value="deliveries" className="text-xs md:text-sm px-2 md:px-4 py-2">Deliveries</TabsTrigger>
                     <TabsTrigger value="patients" className="text-xs md:text-sm px-2 md:px-4 py-2">Patients</TabsTrigger>
                     <TabsTrigger value="stores" className="text-xs md:text-sm px-2 md:px-4 py-2">Stores</TabsTrigger>
                     <TabsTrigger value="users" className="text-xs md:text-sm px-2 md:px-4 py-2 hidden sm:block">Users</TabsTrigger>
                     <TabsTrigger value="cities" className="text-xs md:text-sm px-2 md:px-4 py-2 hidden sm:block">Cities</TabsTrigger>
                   </TabsList>

                  <TabsContent value="deliveries" className="mt-6">
                    <div className="space-y-4">
                      <div className="flex flex-col md:flex-row gap-2 flex-wrap items-stretch md:items-center justify-between">
                        {!manualLoadTriggered ? (
                          <Alert className="flex-1">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription className="flex items-center justify-between">
                              <span>Select filters above, then click "Load Data" to fetch deliveries.</span>
                              <Button
                                onClick={() => setManualLoadTriggered(true)}
                                disabled={deliveriesLoading}
                                size="sm"
                              >
                                <Database className="w-4 h-4 mr-2" />
                                Load Data
                              </Button>
                            </AlertDescription>
                          </Alert>
                        ) : (
                          <Button
                            onClick={() => {
                              setManualLoadTriggered(false);
                              setTimeout(() => setManualLoadTriggered(true), 100);
                            }}
                            disabled={deliveriesLoading}
                            variant="outline"
                          >
                            <RefreshCw className={`w-4 h-4 mr-2 ${deliveriesLoading ? 'animate-spin' : ''}`} />
                            Reload Data
                          </Button>
                        )}
                        {manualLoadTriggered && (
                           <div className="flex gap-2 w-full md:w-auto">
                             <Button
                               variant={dataViewMode.deliveries === 'offline' ? 'default' : 'outline'}
                               size="sm"
                               onClick={() => setDataViewMode(prev => ({ ...prev, deliveries: 'offline' }))}
                               className="flex-1 md:flex-none min-h-10"
                             >
                               Offline
                             </Button>
                             <Button
                               variant={dataViewMode.deliveries !== 'offline' ? 'default' : 'outline'}
                               size="sm"
                               onClick={() => setDataViewMode(prev => ({ ...prev, deliveries: 'online' }))}
                               className="flex-1 md:flex-none min-h-10"
                             >
                               Online
                             </Button>
                           </div>
                         )}
                      </div>

                      {manualLoadTriggered && <DeliveryDataTable
                         deliveries={filteredAndSortedDeliveries}
                         patients={patients || []}
                         stores={stores || []}
                         drivers={driversForDropdown}
                         onEdit={handleEditEntity}
                         onDelete={handleDeleteEntity}
                         onDeleteAll={_confirmDeleteAllDeliveries}
                         onDeleteSelected={_confirmDeleteSelectedDeliveries}
                         onFindDuplicates={(deliveries) => handleFindDuplicates(deliveries, setAutoSelectDuplicateIds)}
                         autoSelectIds={autoSelectDuplicateIds}
                         duplicateFilterMode={duplicateFilterMode}
                         onAutoSelectProcessed={() => setAutoSelectDuplicateIds([])}
                         onClearDuplicateFilter={() => setDuplicateFilterMode(false)}
                         filterText={deliveryFilterText}
                         onFilterChange={setDeliveryFilterText}
                         sortColumn={deliverySortColumn}
                         sortDirection={deliverySortDirection}
                         onSortChange={handleDeliverySort}
                         isLoadingData={deliveriesLoading}
                         selectedYear={selectedDeliveryYear}
                         onYearChange={(year) => {
                           setSelectedDeliveryYear(year);
                           if (currentUser?.id) {
                             saveSetting(currentUser.id, 'admin_utilities_year', year);
                           }
                         }}
                         availableYears={availableDeliveryYears}
                         selectedMonth={selectedDeliveryMonth}
                         onMonthChange={(month) => {
                           setSelectedDeliveryMonth(month);
                           if (currentUser?.id) {
                             saveSetting(currentUser.id, 'admin_utilities_month', month);
                           }
                         }}
                         selectedDriver={selectedDriver}
                         onDriverChange={(driver) => {
                           setSelectedDriver(driver);
                           if (currentUser?.id) {
                             saveSetting(currentUser.id, 'admin_utilities_driver', driver);
                           }
                         }}
                       />}
                    </div>
                  </TabsContent>

                  <TabsContent value="patients" className="mt-6">
                    <div className="mb-4 flex justify-start md:justify-end gap-2">
                      <Button
                        variant={dataViewMode.patients === 'offline' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setDataViewMode(prev => ({ ...prev, patients: 'offline' }))}
                        className="flex-1 md:flex-none min-h-10"
                      >
                        Offline
                      </Button>
                      <Button
                        variant={dataViewMode.patients !== 'offline' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setDataViewMode(prev => ({ ...prev, patients: 'online' }))}
                        className="flex-1 md:flex-none min-h-10"
                      >
                        Online
                      </Button>
                    </div>
                    <PatientDataTable
                      patients={filteredPatientsForDetectDuplicates || []}
                      stores={stores || []}
                      onEdit={handleEditEntity}
                      onDelete={handleDeleteEntity}
                      filterText={patientFilterText}
                      onFilterChange={setPatientFilterText}
                      sortColumn={patientSortColumn}
                      sortDirection={patientSortDirection}
                      onSortChange={handlePatientSort}
                      isLoadingData={patientsLoading}
                      onDeleteAll={_confirmDeleteAllPatients}
                      onDeleteSelected={_confirmDeleteSelectedPatients}
                    />
                  </TabsContent>

                  <TabsContent value="stores" className="mt-6">
                    <div className="mb-4 flex justify-start md:justify-end gap-2">
                      <Button
                        variant={dataViewMode.stores === 'offline' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setDataViewMode(prev => ({ ...prev, stores: 'offline' }))}
                        className="flex-1 md:flex-none min-h-10"
                      >
                        Offline
                      </Button>
                      <Button
                        variant={dataViewMode.stores !== 'offline' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setDataViewMode(prev => ({ ...prev, stores: 'online' }))}
                        className="flex-1 md:flex-none min-h-10"
                      >
                        Online
                      </Button>
                    </div>
                    <StoreDataTable
                      stores={stores || []}
                      onEdit={handleEditEntity}
                      onDelete={handleDeleteEntity}
                      onDeleteSelected={_confirmDeleteSelectedStores}
                      isLoadingData={storesLoading}
                    />
                  </TabsContent>

                  <TabsContent value="users" className="mt-6">
                    <div className="mb-4 flex justify-start md:justify-end gap-2">
                      <Button
                        variant={dataViewMode.users === 'offline' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setDataViewMode(prev => ({ ...prev, users: 'offline' }))}
                        className="flex-1 md:flex-none min-h-10"
                      >
                        Offline
                      </Button>
                      <Button
                        variant={dataViewMode.users !== 'offline' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setDataViewMode(prev => ({ ...prev, users: 'online' }))}
                        className="flex-1 md:flex-none min-h-10"
                      >
                        Online
                      </Button>
                    </div>
                    <UserDataTable
                      users={appUsers || []}
                      onEdit={handleEditEntity}
                      onDelete={handleDeleteEntity}
                      onDeleteSelected={_confirmDeleteSelectedUsers}
                      isLoadingData={appUsersLoading}
                    />
                  </TabsContent>

                  <TabsContent value="cities" className="mt-6">
                    <div className="mb-4 flex justify-start md:justify-end gap-2">
                      <Button
                        variant={dataViewMode.cities === 'offline' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setDataViewMode(prev => ({ ...prev, cities: 'offline' }))}
                        className="flex-1 md:flex-none min-h-10"
                      >
                        Offline
                      </Button>
                      <Button
                        variant={dataViewMode.cities !== 'offline' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setDataViewMode(prev => ({ ...prev, cities: 'online' }))}
                        className="flex-1 md:flex-none min-h-10"
                      >
                        Online
                      </Button>
                    </div>
                    <CityDataTable
                      cities={cities || []}
                      onEdit={handleEditEntity}
                      onDelete={handleDeleteEntity}
                      onDeleteSelected={_confirmDeleteSelectedCities}
                      isLoadingData={citiesLoading}
                    />
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </TabsContent>

          <TabsContent value="store-metrics">
            <StoreMetricsPanel />
          </TabsContent>

          <TabsContent value="user-settings">
            <UserSettingsTable 
              appUsers={appUsers || []}
              mergedUsers={mergedUsers}
            />
          </TabsContent>

          <TabsContent value="app-settings">
            <AppSettingsPanel />
          </TabsContent>

          <TabsContent value="message-rules">
            <MessageRulesManager />
          </TabsContent>

          <TabsContent value="polylines">
            <PolylineViewer users={mergedUsers} />
          </TabsContent>

          <TabsContent value="api-logs">
            <GoogleAPILogViewer />
          </TabsContent>
        </Tabs>
      </div>

      {showRouteImport && (
        <RouteImport
          onImportComplete={handleRouteImportComplete}
          onCancel={() => setShowRouteImport(false)}
          stores={stores || []}
          drivers={driversForDropdown}
          allUsers={mergedUsers}
          currentUser={currentUser}
          allDeliveries={allDeliveries || []}
        />
      )}

      {editingDelivery && (
        <DeliveryForm
          delivery={editingDelivery}
          patients={patients || []}
          stores={stores || []}
          drivers={mergedUsers || []}
          currentUser={currentUser}
          allDeliveries={allDeliveries || []}
          onSave={async (updatedData) => {
            try {
              const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
              await updateDeliveryLocal(editingDelivery.id, updatedData);
              setEditingDelivery(null);
              await refetchDeliveries();
              await refreshData();
            } catch (error) {
              console.error('Failed to update delivery:', error);
              throw error;
            }
          }}
          onCancel={() => setEditingDelivery(null)}
          closeOnSave={true}
        />
      )}

      <Dialog open={bulkDelete.open} onOpenChange={(open) => {
        if (!bulkDelete.running) {
          setBulkDelete(prev => ({ ...prev, open }));
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deleting {bulkDelete.entityLabel}</DialogTitle>
            <DialogDescription>
              {bulkDelete.running
                ? `Please keep this window open while we delete the filtered ${bulkDelete.entityLabel.toLowerCase()}.`
                : "Bulk delete completed."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              {bulkDelete.processed} / {bulkDelete.total} processed
              {bulkDelete.currentLabel ? ` • Last: ${bulkDelete.currentLabel}` : ""}
            </div>
            <div className="text-xs text-slate-500">
              Current delay: {Math.round(bulkDelete.currentDelay)} ms • Retrying: {bulkDelete.retryQueue}
            </div>
            <Progress value={bulkDelete.total ? (bulkDelete.processed / bulkDelete.total) * 100 : 0} />
            <div className="flex items-center justify-between text-sm">
              <div className="text-emerald-600 font-medium">Success: {bulkDelete.success}</div>
              <div className="text-red-600 font-medium">Failed: {bulkDelete.failed}</div>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button
              onClick={() => setBulkDelete(prev => ({ ...prev, open: false }))}
              disabled={bulkDelete.running}
            >
              {bulkDelete.running ? 'Deleting…' : 'Close'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog(prev => ({ ...prev, open }))}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        confirmText={confirmDialog.confirmText}
        variant={confirmDialog.variant}
      />
    </div>
  );
}