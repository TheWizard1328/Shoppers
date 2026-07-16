/**
 * AdminDataTables.jsx
 * Extracted table components from AdminUtilities to reduce file size.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, ArrowUpDown, Edit, Trash2, Database } from 'lucide-react';
import { format, parse, parseISO } from 'date-fns';
import { ResizableColumnHeader, ColumnVisibilityControl } from './AdminTableControls';

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

const COLUMN_CONFIGS = {
  patients: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'full_name', label: 'Full Name', defaultVisible: true },
    { id: 'patient_id', label: 'PID', defaultVisible: true },
    { id: 'phone', label: 'Phone', defaultVisible: true },
    { id: 'address', label: 'Address', defaultVisible: true },
    { id: 'unit', label: 'Unit', defaultVisible: false },
    { id: 'store', label: 'Store', defaultVisible: true },
    { id: 'last_delivery_date', label: 'Last Delivery', defaultVisible: true },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true },
  ],
  stores: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'name', label: 'Name', defaultVisible: true },
    { id: 'abbreviation', label: 'Abbr', defaultVisible: true },
    { id: 'address', label: 'Address', defaultVisible: true },
    { id: 'phone', label: 'Phone', defaultVisible: true },
    { id: 'city', label: 'City', defaultVisible: false },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true },
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
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true },
  ],
  cities: [
    { id: 'id', label: 'ID', defaultVisible: false },
    { id: 'name', label: 'Name', defaultVisible: true },
    { id: 'province', label: 'Province/State', defaultVisible: true },
    { id: 'country', label: 'Country', defaultVisible: true },
    { id: 'actions', label: 'Actions', defaultVisible: true, alwaysVisible: true },
  ],
};

const useColumnVisibility = (entityType) => {
  const storageKey = `admin_columns_${entityType}`;
  const config = COLUMN_CONFIGS[entityType] || [];
  const [visibleColumns, setVisibleColumns] = useState(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) { try { return JSON.parse(saved); } catch (e) {} }
    return config.filter((c) => c.defaultVisible || c.alwaysVisible).map((c) => c.id);
  });
  const toggleColumn = useCallback((columnId) => {
    setVisibleColumns((prev) => {
      const newVisible = prev.includes(columnId) ? prev.filter((id) => id !== columnId) : [...prev, columnId];
      localStorage.setItem(storageKey, JSON.stringify(newVisible));
      return newVisible;
    });
  }, [storageKey]);
  return { visibleColumns, toggleColumn, config };
};

// ── PatientDataTable ──────────────────────────────────────────────────────────
export const PatientDataTable = ({
  patients, stores, onEdit, onDelete,
  filterText, onFilterChange, sortColumn, sortDirection, onSortChange,
  isLoadingData, onDeleteAll, onDeleteSelected,
}) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('patients');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_patient_column_widths');
    return saved ? JSON.parse(saved) : { checkbox: 50, id: 280, full_name: 200, patient_id: 100, phone: 140, address: 250, unit: 100, store: 150, last_delivery_date: 120, actions: 150 };
  });
  const [selectedPatients, setSelectedPatients] = useState(new Set());
  const [duplicateFilter, setDuplicateFilter] = useState('none');
  const [storeFilter, setStoreFilter] = useState('all');
  const [portalLoginFilter, setPortalLoginFilter] = useState(false);

  const updateColumnWidth = useCallback((columnId, width) => {
    setColumnWidths((prev) => { const nw = { ...prev, [columnId]: width }; localStorage.setItem('admin_patient_column_widths', JSON.stringify(nw)); return nw; });
  }, []);

  const cardStyle = { background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' };
  const textPrimary = { color: 'var(--text-slate-900)' };
  const textMuted = { color: 'var(--text-slate-500)' };

  const getSortIcon = (col) => sortColumn === col
    ? <ArrowUpDown className="w-4 h-4 inline ml-1 transform rotate-180" />
    : <ArrowUpDown className="w-4 h-4 inline ml-1 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />;

  const handleSelectAll = (checked) => setSelectedPatients(checked ? new Set(filteredPatients.map((p) => p.id)) : new Set());
  const handleSelectPatient = (id, checked) => setSelectedPatients((prev) => { const s = new Set(prev); checked ? s.add(id) : s.delete(id); return s; });
  const handleDeleteSelected = () => { onDeleteSelected(filteredPatients.filter((p) => selectedPatients.has(p.id))); setSelectedPatients(new Set()); };

  const detectDuplicates = useMemo(() => {
    if (!patients?.length) return { address: new Set(), name: new Set(), nameAndAddress: new Set(), phone: new Set(), pid: new Set() };
    const addressMap = new Map(), nameMap = new Map(), phoneMap = new Map(), pidMap = new Map(), naMap = new Map();
    patients.forEach((p) => {
      if (p.address) { const k = p.address.toLowerCase().trim(); if (!addressMap.has(k)) addressMap.set(k, []); addressMap.get(k).push(p.id); }
      if (p.full_name) { const k = p.full_name.toLowerCase().trim(); if (!nameMap.has(k)) nameMap.set(k, []); nameMap.get(k).push(p.id); }
      if (p.phone) { const ph = p.phone.replace(/\D/g, ''); if (ph) { const pk = `${ph}|${p.full_name?.toLowerCase().trim() || ''}|${p.store_id || ''}`; if (!phoneMap.has(pk)) phoneMap.set(pk, []); phoneMap.get(pk).push(p.id); } }
      if (p.patient_id) { const k = p.patient_id.toUpperCase().trim(); if (!pidMap.has(k)) pidMap.set(k, []); pidMap.get(k).push(p.id); }
      if (p.full_name && p.address) { const k = `${p.full_name.toLowerCase().trim()}|${p.address.toLowerCase().trim()}|${p.store_id || ''}`; if (!naMap.has(k)) naMap.set(k, []); naMap.get(k).push(p.id); }
    });
    const toSet = (m) => { const s = new Set(); m.forEach((ids) => { if (ids.length > 1) ids.forEach((id) => s.add(id)); }); return s; };
    return { address: toSet(addressMap), name: toSet(nameMap), phone: toSet(phoneMap), pid: toSet(pidMap), nameAndAddress: toSet(naMap) };
  }, [patients]);

  const filteredPatients = useMemo(() => {
    let f = patients || [];
    if (duplicateFilter !== 'none') {
      const map = { nameAndAddress: detectDuplicates.nameAndAddress, address: detectDuplicates.address, name: detectDuplicates.name, phone: detectDuplicates.phone, pid: detectDuplicates.pid };
      if (map[duplicateFilter]) f = f.filter((p) => map[duplicateFilter].has(p.id));
    }
    if (storeFilter !== 'all') f = f.filter((p) => p.store_id === storeFilter);
    if (portalLoginFilter) {
      f = f.filter((p) => !!p.last_login_date);
      f = [...f].sort((a, b) => new Date(b.last_login_date).getTime() - new Date(a.last_login_date).getTime());
      return f;
    }
    if (filterText?.trim()) {
      const q = filterText.toLowerCase().trim();
      f = f.filter((p) => {
        const storeName = stores.find((s) => s.id === p.store_id)?.name?.toLowerCase() || '';
        return p.id?.toLowerCase().includes(q) || p.full_name?.toLowerCase().includes(q) || p.phone?.toLowerCase().includes(q) || p.address?.toLowerCase().includes(q) || p.patient_id?.toLowerCase().includes(q) || storeName.includes(q) || (p.last_delivery_date || '').toLowerCase().includes(q);
      });
    }
    if (sortColumn) {
      f = [...f].sort((a, b) => {
        let av, bv;
        if (sortColumn === 'store_id') { av = stores.find((s) => s.id === a.store_id)?.name || ''; bv = stores.find((s) => s.id === b.store_id)?.name || ''; }
        else if (sortColumn === 'last_delivery_date') {
          const at = parseFlexibleDate(a.last_delivery_date)?.getTime() ?? NaN;
          const bt = parseFlexibleDate(b.last_delivery_date)?.getTime() ?? NaN;
          if (isNaN(at) && isNaN(bt)) return 0; if (isNaN(at)) return 1; if (isNaN(bt)) return -1;
          return sortDirection === 'asc' ? at - bt : bt - at;
        } else { av = a[sortColumn]; bv = b[sortColumn]; }
        if (av == null) return sortDirection === 'asc' ? 1 : -1;
        if (bv == null) return sortDirection === 'asc' ? -1 : 1;
        if (typeof av === 'string') return sortDirection === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        if (typeof av === 'number') return sortDirection === 'asc' ? av - bv : bv - av;
        return 0;
      });
    }
    return f;
  }, [patients, duplicateFilter, storeFilter, portalLoginFilter, detectDuplicates, filterText, sortColumn, sortDirection, stores]);

  const dc = { address: detectDuplicates.address.size, name: detectDuplicates.name.size, phone: detectDuplicates.phone.size, pid: detectDuplicates.pid.size, nameAndAddress: detectDuplicates.nameAndAddress.size };
  const portalPatientCount = useMemo(() => (patients || []).filter((p) => !!p.last_login_date).length, [patients]);
  const isAllSelected = filteredPatients.length > 0 && selectedPatients.size === filteredPatients.length;
  const isSomeSelected = selectedPatients.size > 0 && selectedPatients.size < filteredPatients.length;

  return (
    <Card style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={textPrimary}>
          <span>Patients</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl config={config} visibleColumns={visibleColumns} onToggle={toggleColumn} />
            {selectedPatients.size > 0 && <Button variant="destructive" size="sm" onClick={handleDeleteSelected} disabled={isLoadingData}>Delete Selected ({selectedPatients.size})</Button>}
            {filteredPatients.length > 0 && selectedPatients.size === 0 && <Button variant="destructive" size="sm" onClick={() => onDeleteAll(filteredPatients)} disabled={isLoadingData}>Delete All ({filteredPatients.length})</Button>}
          </div>
        </CardTitle>
        <CardDescription style={textMuted}>Filtered and sorted list of patients.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 mb-4">
          <div className="flex gap-3 flex-wrap">
            <Input placeholder="Filter by ID, name, PID, phone, address, store, or last delivery date..." value={filterText} onChange={(e) => onFilterChange(e.target.value)} disabled={isLoadingData} className="flex-1 min-w-[250px]" />
            <Select value={storeFilter} onValueChange={setStoreFilter} disabled={isLoadingData}>
              <SelectTrigger className="w-48"><SelectValue placeholder="All Stores" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Stores</SelectItem>
                {stores.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2 items-center justify-between">
            <div className="flex flex-wrap gap-2">
              <Button variant={duplicateFilter === 'none' ? 'default' : 'outline'} size="sm" onClick={() => setDuplicateFilter('none')}>All Patients ({patients?.length || 0})</Button>
              <Button variant={duplicateFilter === 'nameAndAddress' ? 'default' : 'outline'} size="sm" onClick={() => setDuplicateFilter('nameAndAddress')} disabled={dc.nameAndAddress === 0}><Database className="w-4 h-4 mr-1" />Dup Name+Address ({dc.nameAndAddress})</Button>
              <Button variant={duplicateFilter === 'phone' ? 'default' : 'outline'} size="sm" onClick={() => setDuplicateFilter('phone')} disabled={dc.phone === 0}><Database className="w-4 h-4 mr-1" />Duplicate Phones ({dc.phone})</Button>
              <Button variant={duplicateFilter === 'pid' ? 'default' : 'outline'} size="sm" onClick={() => setDuplicateFilter('pid')} disabled={dc.pid === 0}><Database className="w-4 h-4 mr-1" />Duplicate PIDs ({dc.pid})</Button>
            </div>
            <Button
              variant={portalLoginFilter ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPortalLoginFilter((v) => !v)}
              className={portalLoginFilter ? 'bg-blue-600 hover:bg-blue-700 text-white border-blue-600' : ''}
            >
              🔐 Portal Logins ({portalPatientCount})
            </Button>
          </div>
        </div>
        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm table-fixed">
              <thead className="border-b sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                <tr>
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}><Checkbox checked={isAllSelected} onCheckedChange={handleSelectAll} className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''} /></ResizableColumnHeader>
                  {visibleColumns.includes('id') && <ResizableColumnHeader width={columnWidths.id} onResize={(w) => updateColumnWidth('id', w)}><Button variant="ghost" onClick={() => onSortChange('id')} className="p-0 h-auto group flex items-center hover:text-emerald-600 font-semibold" style={textPrimary}>System ID {getSortIcon('id')}</Button></ResizableColumnHeader>}
                  {visibleColumns.includes('full_name') && <ResizableColumnHeader width={columnWidths.full_name} onResize={(w) => updateColumnWidth('full_name', w)}><Button variant="ghost" onClick={() => onSortChange('full_name')} className="p-0 h-auto group flex items-center hover:text-emerald-600 font-semibold" style={textPrimary}>Full Name {getSortIcon('full_name')}</Button></ResizableColumnHeader>}
                  {visibleColumns.includes('patient_id') && <ResizableColumnHeader width={columnWidths.patient_id} onResize={(w) => updateColumnWidth('patient_id', w)}><Button variant="ghost" onClick={() => onSortChange('patient_id')} className="p-0 h-auto group flex items-center hover:text-emerald-600 font-semibold">PID {getSortIcon('patient_id')}</Button></ResizableColumnHeader>}
                  {visibleColumns.includes('phone') && <ResizableColumnHeader width={columnWidths.phone} onResize={(w) => updateColumnWidth('phone', w)}><Button variant="ghost" onClick={() => onSortChange('phone')} className="p-0 h-auto group flex items-center hover:text-emerald-600 font-semibold">Phone {getSortIcon('phone')}</Button></ResizableColumnHeader>}
                  {visibleColumns.includes('address') && <ResizableColumnHeader width={columnWidths.address} onResize={(w) => updateColumnWidth('address', w)}><Button variant="ghost" onClick={() => onSortChange('address')} className="p-0 h-auto group flex items-center hover:text-emerald-600 font-semibold">Address {getSortIcon('address')}</Button></ResizableColumnHeader>}
                  {visibleColumns.includes('unit') && <ResizableColumnHeader width={columnWidths.unit} onResize={(w) => updateColumnWidth('unit', w)}><span className="font-semibold">Unit</span></ResizableColumnHeader>}
                  {visibleColumns.includes('store') && <ResizableColumnHeader width={columnWidths.store} onResize={(w) => updateColumnWidth('store', w)}><Button variant="ghost" onClick={() => onSortChange('store_id')} className="p-0 h-auto group flex items-center hover:text-emerald-600 font-semibold">Store {getSortIcon('store_id')}</Button></ResizableColumnHeader>}
                  {visibleColumns.includes('last_delivery_date') && <ResizableColumnHeader width={columnWidths.last_delivery_date} onResize={(w) => updateColumnWidth('last_delivery_date', w)}><Button variant="ghost" onClick={() => onSortChange('last_delivery_date')} className="p-0 h-auto group flex items-center hover:text-emerald-600 font-semibold">Last Delivery {getSortIcon('last_delivery_date')}</Button></ResizableColumnHeader>}
                  {visibleColumns.includes('actions') && <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}><span className="font-semibold">Actions</span></ResizableColumnHeader>}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading patients...</td></tr>
                : filteredPatients.length > 0 ? filteredPatients.map((patient) => {
                    const isDupNA = detectDuplicates.nameAndAddress.has(patient.id);
                    const isDupAddr = detectDuplicates.address.has(patient.id);
                    const isDupPhone = detectDuplicates.phone.has(patient.id);
                    const isDupPid = detectDuplicates.pid.has(patient.id);
                    const patientStore = stores.find((s) => s.id === patient.store_id);
                    return (
                      <tr key={patient.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                        <td className="p-3"><Checkbox checked={selectedPatients.has(patient.id)} onCheckedChange={(c) => handleSelectPatient(patient.id, c)} /></td>
                        {visibleColumns.includes('id') && <td className="p-3 font-mono text-xs select-all" style={{ color: 'var(--text-slate-700)' }}>{patient.id}</td>}
                        {visibleColumns.includes('full_name') && <td className={`p-3 ${isDupNA ? 'bg-orange-50' : ''}`} style={textPrimary}>{patient.full_name}{isDupNA && <Badge variant="destructive" className="ml-2 text-xs">Dup</Badge>}</td>}
                        {visibleColumns.includes('patient_id') && <td className={`p-3 font-mono text-xs ${isDupPid ? 'bg-yellow-50' : ''}`} style={textPrimary}>{patient.patient_id || '-'}{isDupPid && <Badge variant="destructive" className="ml-2 text-xs">Dup</Badge>}</td>}
                        {visibleColumns.includes('phone') && <td className={`p-3 ${isDupPhone ? 'bg-yellow-50' : ''}`} style={textPrimary}>{patient.phone}{isDupPhone && <Badge variant="destructive" className="ml-2 text-xs">Dup</Badge>}</td>}
                        {visibleColumns.includes('address') && <td className={`p-3 ${isDupNA ? 'bg-orange-50' : isDupAddr ? 'bg-yellow-50' : ''}`} style={textPrimary}>{patient.address}{isDupNA && <Badge variant="destructive" className="ml-2 text-xs">Dup</Badge>}</td>}
                        {visibleColumns.includes('unit') && <td className="p-3 text-xs" style={textPrimary}>{patient.unit_number || '-'}</td>}
                        {visibleColumns.includes('store') && <td className="p-3">{patientStore ? <div className="flex flex-col"><span className="font-medium" style={textPrimary}>{patientStore.name}</span><span className="text-xs font-mono select-all" style={{ color: 'var(--text-slate-500)' }}>{patient.id}</span></div> : <span style={{ color: 'var(--text-slate-400)' }}>Unassigned</span>}</td>}
                        {visibleColumns.includes('last_delivery_date') && <td className="p-3 text-sm" style={textPrimary}>{patient.last_delivery_date ? (() => { const d = parseFlexibleDate(patient.last_delivery_date); return d && !isNaN(d.getTime()) ? format(d, 'MMM d, yyyy') : <span className="text-amber-600 text-xs">{patient.last_delivery_date}</span>; })() : <span style={{ color: 'var(--text-slate-400)' }}>Never</span>}</td>}
                        {visibleColumns.includes('actions') && <td className="p-3 text-right"><div className="flex justify-end gap-2"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(patient)}><Edit className="w-4 h-4" /></Button><Button variant="ghost" size="icon" className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => onDelete(patient)}><Trash2 className="w-4 h-4" /></Button></div></td>}
                      </tr>
                    );
                  })
                : <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={textMuted}>No patients found.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

// ── StoreDataTable ────────────────────────────────────────────────────────────
export const StoreDataTable = ({ stores, onEdit, onDelete, onDeleteSelected, isLoadingData }) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('stores');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_store_column_widths');
    return saved ? JSON.parse(saved) : { checkbox: 50, id: 120, name: 200, abbreviation: 100, address: 300, phone: 140, city: 120, actions: 150 };
  });
  const [selectedStores, setSelectedStores] = useState(new Set());
  const updateColumnWidth = useCallback((id, w) => setColumnWidths((prev) => { const nw = { ...prev, [id]: w }; localStorage.setItem('admin_store_column_widths', JSON.stringify(nw)); return nw; }), []);
  const handleSelectAll = (c) => setSelectedStores(c ? new Set((stores || []).map((s) => s.id)) : new Set());
  const handleSelectStore = (id, c) => setSelectedStores((prev) => { const s = new Set(prev); c ? s.add(id) : s.delete(id); return s; });
  const handleDeleteSelected = () => { onDeleteSelected((stores || []).filter((s) => selectedStores.has(s.id))); setSelectedStores(new Set()); };
  const isAllSelected = (stores || []).length > 0 && selectedStores.size === (stores || []).length;
  const isSomeSelected = selectedStores.size > 0 && selectedStores.size < (stores || []).length;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-slate-900)' }}>
          <span>Stores</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl config={config} visibleColumns={visibleColumns} onToggle={toggleColumn} />
            {selectedStores.size > 0 && <Button variant="destructive" size="sm" onClick={handleDeleteSelected} disabled={isLoadingData}>Delete Selected ({selectedStores.size})</Button>}
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
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}><Checkbox checked={isAllSelected} onCheckedChange={handleSelectAll} className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''} /></ResizableColumnHeader>
                  {visibleColumns.includes('id') && <ResizableColumnHeader width={columnWidths.id} onResize={(w) => updateColumnWidth('id', w)}><span className="font-semibold">ID</span></ResizableColumnHeader>}
                  {visibleColumns.includes('name') && <ResizableColumnHeader width={columnWidths.name} onResize={(w) => updateColumnWidth('name', w)}><span className="font-semibold">Name</span></ResizableColumnHeader>}
                  {visibleColumns.includes('abbreviation') && <ResizableColumnHeader width={columnWidths.abbreviation} onResize={(w) => updateColumnWidth('abbreviation', w)}><span className="font-semibold">Abbr</span></ResizableColumnHeader>}
                  {visibleColumns.includes('address') && <ResizableColumnHeader width={columnWidths.address} onResize={(w) => updateColumnWidth('address', w)}><span className="font-semibold">Address</span></ResizableColumnHeader>}
                  {visibleColumns.includes('phone') && <ResizableColumnHeader width={columnWidths.phone} onResize={(w) => updateColumnWidth('phone', w)}><span className="font-semibold">Phone</span></ResizableColumnHeader>}
                  {visibleColumns.includes('city') && <ResizableColumnHeader width={columnWidths.city} onResize={(w) => updateColumnWidth('city', w)}><span className="font-semibold">City</span></ResizableColumnHeader>}
                  {visibleColumns.includes('actions') && <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}><span className="font-semibold">Actions</span></ResizableColumnHeader>}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading stores...</td></tr>
                : stores.length > 0 ? stores.map((store) => (
                    <tr key={store.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <td className="p-2"><Checkbox checked={selectedStores.has(store.id)} onCheckedChange={(c) => handleSelectStore(store.id, c)} /></td>
                      {visibleColumns.includes('id') && <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-500)' }} title={store.id}>{store.id.substring(0, 8)}...</td>}
                      {visibleColumns.includes('name') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.name}</td>}
                      {visibleColumns.includes('abbreviation') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.abbreviation}</td>}
                      {visibleColumns.includes('address') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.address}</td>}
                      {visibleColumns.includes('phone') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.phone}</td>}
                      {visibleColumns.includes('city') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{store.city_id || '-'}</td>}
                      {visibleColumns.includes('actions') && <td className="p-3 text-right"><Button variant="outline" size="sm" onClick={() => onEdit(store)} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>Edit</Button><Button variant="destructive" size="sm" className="ml-2" onClick={() => onDelete(store)}>Delete</Button></td>}
                    </tr>
                  ))
                : <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={{ color: 'var(--text-slate-500)' }}>No stores found.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

// ── UserDataTable ─────────────────────────────────────────────────────────────
export const UserDataTable = ({ users, onEdit, onDelete, onDeleteSelected, isLoadingData }) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('users');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_user_column_widths');
    return saved ? JSON.parse(saved) : { checkbox: 50, id: 120, user_name: 200, phone: 140, roles: 150, status: 120, location_tracking: 140, home_coords: 180, current_coords: 180, city: 120, stores: 150, actions: 150 };
  });
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const updateColumnWidth = useCallback((id, w) => setColumnWidths((prev) => { const nw = { ...prev, [id]: w }; localStorage.setItem('admin_user_column_widths', JSON.stringify(nw)); return nw; }), []);
  const handleSelectAll = (c) => setSelectedUsers(c ? new Set((users || []).map((u) => u.id)) : new Set());
  const handleSelectUser = (id, c) => setSelectedUsers((prev) => { const s = new Set(prev); c ? s.add(id) : s.delete(id); return s; });
  const handleDeleteSelected = () => { onDeleteSelected((users || []).filter((u) => selectedUsers.has(u.id))); setSelectedUsers(new Set()); };
  const isAllSelected = (users || []).length > 0 && selectedUsers.size === (users || []).length;
  const isSomeSelected = selectedUsers.size > 0 && selectedUsers.size < (users || []).length;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-slate-900)' }}>
          <span>App Users</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl config={config} visibleColumns={visibleColumns} onToggle={toggleColumn} />
            {selectedUsers.size > 0 && <Button variant="destructive" size="sm" onClick={handleDeleteSelected} disabled={isLoadingData}>Delete Selected ({selectedUsers.size})</Button>}
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
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}><Checkbox checked={isAllSelected} onCheckedChange={handleSelectAll} className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''} /></ResizableColumnHeader>
                  {visibleColumns.includes('id') && <ResizableColumnHeader width={columnWidths.id} onResize={(w) => updateColumnWidth('id', w)}><span className="font-semibold">ID</span></ResizableColumnHeader>}
                  {visibleColumns.includes('user_name') && <ResizableColumnHeader width={columnWidths.user_name} onResize={(w) => updateColumnWidth('user_name', w)}><span className="font-semibold">User Name</span></ResizableColumnHeader>}
                  {visibleColumns.includes('phone') && <ResizableColumnHeader width={columnWidths.phone} onResize={(w) => updateColumnWidth('phone', w)}><span className="font-semibold">Phone</span></ResizableColumnHeader>}
                  {visibleColumns.includes('roles') && <ResizableColumnHeader width={columnWidths.roles} onResize={(w) => updateColumnWidth('roles', w)}><span className="font-semibold">Roles</span></ResizableColumnHeader>}
                  {visibleColumns.includes('status') && <ResizableColumnHeader width={columnWidths.status} onResize={(w) => updateColumnWidth('status', w)}><span className="font-semibold">Status</span></ResizableColumnHeader>}
                  {visibleColumns.includes('location_tracking') && <ResizableColumnHeader width={columnWidths.location_tracking} onResize={(w) => updateColumnWidth('location_tracking', w)}><span className="font-semibold">Location Tracking</span></ResizableColumnHeader>}
                  {visibleColumns.includes('home_coords') && <ResizableColumnHeader width={columnWidths.home_coords} onResize={(w) => updateColumnWidth('home_coords', w)}><span className="font-semibold">Home Coords</span></ResizableColumnHeader>}
                  {visibleColumns.includes('current_coords') && <ResizableColumnHeader width={columnWidths.current_coords} onResize={(w) => updateColumnWidth('current_coords', w)}><span className="font-semibold">Current Coords</span></ResizableColumnHeader>}
                  {visibleColumns.includes('city') && <ResizableColumnHeader width={columnWidths.city} onResize={(w) => updateColumnWidth('city', w)}><span className="font-semibold">City</span></ResizableColumnHeader>}
                  {visibleColumns.includes('stores') && <ResizableColumnHeader width={columnWidths.stores} onResize={(w) => updateColumnWidth('stores', w)}><span className="font-semibold">Stores</span></ResizableColumnHeader>}
                  {visibleColumns.includes('actions') && <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}><span className="font-semibold">Actions</span></ResizableColumnHeader>}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading app users...</td></tr>
                : users.length > 0 ? users.map((user) => (
                    <tr key={user.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <td className="p-2"><Checkbox checked={selectedUsers.has(user.id)} onCheckedChange={(c) => handleSelectUser(user.id, c)} /></td>
                      {visibleColumns.includes('id') && <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-500)' }} title={user.id}>{user.id.substring(0, 8)}...</td>}
                      {visibleColumns.includes('user_name') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.user_name}</td>}
                      {visibleColumns.includes('phone') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.phone}</td>}
                      {visibleColumns.includes('roles') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.app_roles ? user.app_roles.join(', ') : 'N/A'}</td>}
                      {visibleColumns.includes('status') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.status}</td>}
                      {visibleColumns.includes('location_tracking') && <td className="p-3"><Badge variant={user.location_tracking_enabled ? 'default' : 'secondary'}>{user.location_tracking_enabled ? '✓ Enabled' : 'Disabled'}</Badge></td>}
                      {visibleColumns.includes('home_coords') && <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-900)' }}>{user.home_latitude && user.home_longitude ? `${user.home_latitude.toFixed(5)}, ${user.home_longitude.toFixed(5)}` : '-'}</td>}
                      {visibleColumns.includes('current_coords') && <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-900)' }}>{user.current_latitude && user.current_longitude ? `${user.current_latitude.toFixed(5)}, ${user.current_longitude.toFixed(5)}` : '-'}</td>}
                      {visibleColumns.includes('city') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.city_id || '-'}</td>}
                      {visibleColumns.includes('stores') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{user.store_ids?.length > 0 ? user.store_ids.map((id) => id.substring(0, 4)).join(', ') + '...' : '-'}</td>}
                      {visibleColumns.includes('actions') && <td className="p-3 text-right"><Button variant="outline" size="sm" onClick={() => onEdit(user)} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>Edit</Button><Button variant="destructive" size="sm" className="ml-2" onClick={() => onDelete(user)}>Delete</Button></td>}
                    </tr>
                  ))
                : <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={{ color: 'var(--text-slate-500)' }}>No app users found.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

// ── CityDataTable ─────────────────────────────────────────────────────────────
export const CityDataTable = ({ cities, onEdit, onDelete, onDeleteSelected, isLoadingData }) => {
  const { visibleColumns, toggleColumn, config } = useColumnVisibility('cities');
  const [columnWidths, setColumnWidths] = useState(() => {
    const saved = localStorage.getItem('admin_city_column_widths');
    return saved ? JSON.parse(saved) : { checkbox: 50, id: 120, name: 200, province: 150, country: 150, actions: 150 };
  });
  const [selectedCities, setSelectedCities] = useState(new Set());
  const updateColumnWidth = useCallback((id, w) => setColumnWidths((prev) => { const nw = { ...prev, [id]: w }; localStorage.setItem('admin_city_column_widths', JSON.stringify(nw)); return nw; }), []);
  const handleSelectAll = (c) => setSelectedCities(c ? new Set((cities || []).map((ct) => ct.id)) : new Set());
  const handleSelectCity = (id, c) => setSelectedCities((prev) => { const s = new Set(prev); c ? s.add(id) : s.delete(id); return s; });
  const handleDeleteSelected = () => { onDeleteSelected((cities || []).filter((c) => selectedCities.has(c.id))); setSelectedCities(new Set()); };
  const isAllSelected = (cities || []).length > 0 && selectedCities.size === (cities || []).length;
  const isSomeSelected = selectedCities.size > 0 && selectedCities.size < (cities || []).length;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-slate-900)' }}>
          <span>Cities</span>
          <div className="flex gap-2">
            <ColumnVisibilityControl config={config} visibleColumns={visibleColumns} onToggle={toggleColumn} />
            {selectedCities.size > 0 && <Button variant="destructive" size="sm" onClick={handleDeleteSelected} disabled={isLoadingData}>Delete Selected ({selectedCities.size})</Button>}
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
                  <ResizableColumnHeader width={columnWidths.checkbox} onResize={(w) => updateColumnWidth('checkbox', w)}><Checkbox checked={isAllSelected} onCheckedChange={handleSelectAll} className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''} /></ResizableColumnHeader>
                  {visibleColumns.includes('id') && <ResizableColumnHeader width={columnWidths.id} onResize={(w) => updateColumnWidth('id', w)}><span className="font-semibold">ID</span></ResizableColumnHeader>}
                  {visibleColumns.includes('name') && <ResizableColumnHeader width={columnWidths.name} onResize={(w) => updateColumnWidth('name', w)}><span className="font-semibold">Name</span></ResizableColumnHeader>}
                  {visibleColumns.includes('province') && <ResizableColumnHeader width={columnWidths.province} onResize={(w) => updateColumnWidth('province', w)}><span className="font-semibold">Province/State</span></ResizableColumnHeader>}
                  {visibleColumns.includes('country') && <ResizableColumnHeader width={columnWidths.country} onResize={(w) => updateColumnWidth('country', w)}><span className="font-semibold">Country</span></ResizableColumnHeader>}
                  {visibleColumns.includes('actions') && <ResizableColumnHeader width={columnWidths.actions} onResize={(w) => updateColumnWidth('actions', w)}><span className="font-semibold">Actions</span></ResizableColumnHeader>}
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading cities...</td></tr>
                : cities.length > 0 ? cities.map((city) => (
                    <tr key={city.id} className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <td className="p-2"><Checkbox checked={selectedCities.has(city.id)} onCheckedChange={(c) => handleSelectCity(city.id, c)} /></td>
                      {visibleColumns.includes('id') && <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-slate-500)' }} title={city.id}>{city.id.substring(0, 8)}...</td>}
                      {visibleColumns.includes('name') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{city.name}</td>}
                      {visibleColumns.includes('province') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{city.province}</td>}
                      {visibleColumns.includes('country') && <td className="p-3" style={{ color: 'var(--text-slate-900)' }}>{city.country}</td>}
                      {visibleColumns.includes('actions') && <td className="p-3 text-right"><Button variant="outline" size="sm" onClick={() => onEdit(city)} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>Edit</Button><Button variant="destructive" size="sm" className="ml-2" onClick={() => onDelete(city)}>Delete</Button></td>}
                    </tr>
                  ))
                : <tr><td colSpan={visibleColumns.length + 1} className="p-3 text-center" style={{ color: 'var(--text-slate-500)' }}>No cities found.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};