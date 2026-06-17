/**
 * InterStoreFormContent.jsx
 * UI panel rendered inside DeliveryFormView when isInterStoreMode is true.
 * Displays From (left) and To (right) location selectors, plus transfer notes.
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Search, ArrowRight, MapPin, Phone, Route, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Converts "HH:MM" (24h) → "hh:MM AM/PM"
function to12h(val) {
  if (!val) return '';
  const [hStr, mStr] = val.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
}

function TimePickerField({ label, value, onChange, disabled, required }) {
  return (
    <div className="flex flex-col gap-1 flex-1 min-w-0">
      <style>{`input[type="time"]::-webkit-calendar-picker-indicator { display: none !important; }`}</style>
      <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </Label>
      <div className="relative flex items-center">
        <input
          type="time"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-full h-9 pl-3 pr-8 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
          style={{ colorScheme: 'auto' }}
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute right-2 text-slate-400 hover:text-slate-600"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
import { base44 } from '@/api/base44Client';
import { getGoogleDrivingDistance } from '@/functions/getGoogleDrivingDistance';
import { formatPhoneNumber } from '@/components/utils/phoneFormatter';
import { backfillInterStoreCoords } from '@/components/utils/interStoreGeocode';

function LocationPanel({ title, color, locations, loading, selectedId, onSelect, isSaving, dispatcherLocation, onDispatcherShortcut }) {
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef(null);

  const matchedId = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const match = locations.find((loc) =>
      (loc.store_name || '').toLowerCase().includes(q) ||
      (loc.store_number || '').toLowerCase().includes(q) ||
      (loc.store_address || '').toLowerCase().includes(q) ||
      (loc.city || '').toLowerCase().includes(q)
    );
    return match ? match.id : null;
  }, [locations, searchQuery]);

  // Auto-select the matched location when search yields a single best match
  useEffect(() => {
    if (matchedId && matchedId !== selectedId) {
      const matched = locations.find((l) => l.id === matchedId);
      if (matched) onSelect(matched);
    }
  }, [matchedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll matched item into view
  useEffect(() => {
    if (!matchedId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-loc-id="${matchedId}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [matchedId]);

  // Scroll selected item into view whenever selectedId changes (e.g. on edit load)
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-loc-id="${selectedId}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }, [selectedId]);

  const isFrom = color === 'emerald';
  const selectedStyle = isFrom
    ? { bg: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', header: 'text-emerald-700', highlight: 'bg-yellow-50 ring-1 ring-yellow-300' }
    : { bg: 'bg-blue-50', badge: 'bg-blue-100 text-blue-700 border-blue-200', header: 'text-blue-700', highlight: 'bg-yellow-50 ring-1 ring-yellow-300' };

  return (
    <div className="flex flex-col gap-2 flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <div className={`text-sm font-bold ${selectedStyle.header}`}>{title}</div>
        {dispatcherLocation && onDispatcherShortcut && (
          <button
            type="button"
            disabled={isSaving}
            onClick={() => onDispatcherShortcut(dispatcherLocation)}
            className={`text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors truncate max-w-[120px] ${
              selectedId === dispatcherLocation.id
                ? (isFrom ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-blue-600 text-white border-blue-600')
                : (isFrom ? 'bg-white dark:bg-slate-800 text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30' : 'bg-white dark:bg-slate-800 text-blue-700 border-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30')
            }`}
            title={dispatcherLocation.store_name}
          >
            {dispatcherLocation.store_name}
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search to select..."
          className="pl-8 h-8 text-xs"
          disabled={isSaving}
        />
      </div>

      {/* List — always shows all locations, matched one is highlighted */}
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
        <div ref={listRef} className="max-h-[220px] overflow-y-auto divide-y" style={{ borderColor: 'var(--border-slate-100)' }}>
          {loading && (
            <div className="px-3 py-4 text-center text-xs text-slate-400">Loading...</div>
          )}
          {!loading && locations.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-slate-400">No locations found.</div>
          )}
          {!loading && locations.map((loc) => {
            const isSelected = loc.id === selectedId;
            const isMatch = matchedId && loc.id === matchedId;
            return (
              <button
                key={loc.id}
                data-loc-id={loc.id}
                type="button"
                disabled={isSaving}
                onClick={() => onSelect(loc)}
                className={`w-full text-left px-2.5 py-2 transition-colors ${
                  isSelected ? selectedStyle.bg : isMatch ? selectedStyle.highlight : 'hover:bg-slate-50 dark:hover:bg-slate-700'
                }`}
              >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-xs" style={{ color: 'var(--text-slate-900)' }}>{loc.store_name}</span>
                  {loc.store_number && <span className="text-[10px] text-slate-400">#{loc.store_number}</span>}
                  {isSelected && <Badge className={`text-[10px] px-1.5 py-0 ${selectedStyle.badge} ml-auto`}>{isFrom ? 'From' : 'To'}</Badge>}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin className="w-2.5 h-2.5 text-slate-400 shrink-0" />
                  <span className="text-[10px] text-slate-500 truncate">{loc.store_address}{loc.city ? `, ${loc.city}` : ''}</span>
                </div>
                {loc.store_phone && (
                  <div className="flex items-center gap-1">
                    <Phone className="w-2.5 h-2.5 text-slate-400 shrink-0" />
                    <span className="text-[10px] text-slate-500">{formatPhoneNumber(loc.store_phone)}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function InterStoreFormContent({ formData, setFormData, isSaving, currentUser, stores, onReady, delivery, isAddToRouteMode }) {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drivingDistance, setDrivingDistance] = useState(null);
  const [distanceLoading, setDistanceLoading] = useState(false);

  // Pre-populate arrival_time and actual_delivery_time from the delivery record on edit load
  useEffect(() => {
    if (!delivery?.id) return;
    setFormData((prev) => ({
      ...prev,
      ...(delivery.arrival_time && !prev.arrival_time ? { arrival_time: delivery.arrival_time } : {}),
      ...(delivery.actual_delivery_time && !prev.actual_delivery_time ? { actual_delivery_time: delivery.actual_delivery_time } : {}),
    }));
  }, [delivery?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [data, storeData] = await Promise.all([
          base44.entities.InterStoreLocation.list(),
          base44.entities.Store.list(),
        ]);
        if (!cancelled) {
          const storeList = storeData || [];
          // Build a map from store name (lowercase) → sort_order for quick lookup
          const storeSortMap = {};
          storeList.forEach((s) => {
            if (s.name) storeSortMap[s.name.toLowerCase()] = s.sort_order ?? 9999;
          });
          const sorted = (data || []).slice().sort((a, b) => {
            const aCompany = storeSortMap[( a.store_name || '').toLowerCase()] ?? 9999;
            const bCompany = storeSortMap[(b.store_name || '').toLowerCase()] ?? 9999;
            if (aCompany !== bCompany) return aCompany - bCompany;
            // Secondary: store_number numerically
            const aNum = parseInt(a.store_number || '9999999', 10);
            const bNum = parseInt(b.store_number || '9999999', 10);
            return aNum - bNum;
          });
          setLocations(sorted);
        }
      } catch {
        if (!cancelled) setLocations([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    // Backfill any InterStoreLocations missing coords (fire-and-forget)
    backfillInterStoreCoords().catch(() => null);
    return () => { cancelled = true; };
  }, []);

  const sourceId = formData._interstore_source_id || '';
  const destId = formData._interstore_dest_id || '';
  const sourceLocation = locations.find((l) => l.id === sourceId);
  const destLocation = locations.find((l) => l.id === destId);
  const bothSelected = !!(sourceId && destId);

  // Notify parent when both stores are selected
  useEffect(() => {
    if (onReady) onReady(bothSelected);
  }, [bothSelected, onReady]);

  // Track which pair we last fetched distance for — skip API if we already have a saved distance
  const lastFetchedPairRef = useRef('');

  // Build distance payload directly from InterStoreLocation address fields
  const getDistancePayload = (srcLoc, dstLoc) => {
    const srcAddr = `${srcLoc.store_address}${srcLoc.city ? ', ' + srcLoc.city : ''}`;
    const dstAddr = `${dstLoc.store_address}${dstLoc.city ? ', ' + dstLoc.city : ''}`;
    if (!srcAddr.trim() || !dstAddr.trim()) return null;
    return { origin: srcAddr, destination: dstAddr };
  };

  // Show saved distance immediately when it's already in formData (edit mode)
  useEffect(() => {
    if (formData._interstore_distance_km != null) {
      setDrivingDistance({ text: `${formData._interstore_distance_km} km`, duration: null });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch driving distance when both stores are selected — skip if we already have a saved value
  useEffect(() => {
    if (!bothSelected || !sourceLocation || !destLocation) {
      // Only clear distance display if user has deselected a store
      if (!bothSelected) setDrivingDistance(null);
      return;
    }

    const pairKey = `${sourceId}__${destId}`;

    // If formData already has a distance for this pair (edit mode), just display it without calling API
    if (formData._interstore_distance_km != null && lastFetchedPairRef.current !== pairKey) {
      lastFetchedPairRef.current = pairKey;
      setDrivingDistance({ text: `${formData._interstore_distance_km} km`, duration: null });
      return;
    }

    // Already fetched for this pair
    if (lastFetchedPairRef.current === pairKey) return;

    const payload = getDistancePayload(sourceLocation, destLocation);
    if (!payload) { setDrivingDistance(null); return; }

    let cancelled = false;
    lastFetchedPairRef.current = pairKey;
    const fetchDist = async () => {
      setDistanceLoading(true);
      setDrivingDistance(null);
      try {
        const res = await getGoogleDrivingDistance(payload);
        if (!cancelled && res?.data?.distance_km != null) {
          const distKm = res.data.distance_km;
          setDrivingDistance({ text: `${distKm} km`, duration: res.data.duration_text || null });
          setFormData((prev) => ({ ...prev, _interstore_distance_km: distKm }));
        }
      } catch {
        // silent fail — distance is informational only
      } finally {
        if (!cancelled) setDistanceLoading(false);
      }
    };
    fetchDist();
    return () => { cancelled = true; };
  }, [sourceId, destId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find the dispatcher's store name from their assigned store_ids
  const isAdmin = Array.isArray(currentUser?.app_roles) && currentUser.app_roles.includes('admin');
  // In "Add to Route" mode, non-admins are locked to in_transit
  const statusLockedToInTransit = isAddToRouteMode && !isAdmin;

  // Auto-set status to in_transit for non-admins in Add to Route mode
  useEffect(() => {
    if (statusLockedToInTransit && formData.status !== 'in_transit') {
      setFormData((prev) => ({ ...prev, status: 'in_transit' }));
    }
  }, [statusLockedToInTransit]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDispatcher = Array.isArray(currentUser?.app_roles) && currentUser.app_roles.includes('dispatcher') && !isAdmin;
  const dispatcherStoreId = isDispatcher ? (currentUser?.store_ids?.[0] || currentUser?.store_id) : null;
  const dispatcherStore = dispatcherStoreId && stores ? stores.find((s) => s.id === dispatcherStoreId) : null;
  // Match dispatcher's store to an InterStoreLocation by store name
  const dispatcherLocation = dispatcherStore
    ? locations.find((l) => l.store_name && dispatcherStore.name && l.store_name.toLowerCase().includes(dispatcherStore.name.toLowerCase()))
    : null;

  const selectSource = (loc) =>
    setFormData((prev) => prev._interstore_source_id === loc.id
      ? { ...prev, _interstore_source_id: '', _interstore_source_name: '', _interstore_source_number: '' }
      : { ...prev, _interstore_source_id: loc.id, _interstore_source_name: loc.store_name, _interstore_source_number: loc.store_number || loc.store_name });
  const selectDest = (loc) =>
    setFormData((prev) => prev._interstore_dest_id === loc.id
      ? { ...prev, _interstore_dest_id: '', _interstore_dest_name: '', _interstore_dest_number: '' }
      : { ...prev, _interstore_dest_id: loc.id, _interstore_dest_name: loc.store_name, _interstore_dest_number: loc.store_number || loc.store_name });

  // Dispatcher shortcut: toggle From; if selecting, also clear To if it was the same store
  const handleFromShortcut = (loc) => {
    setFormData((prev) => {
      if (prev._interstore_source_id === loc.id) {
        return { ...prev, _interstore_source_id: '', _interstore_source_name: '', _interstore_source_number: '' };
      }
      return {
        ...prev,
        _interstore_source_id: loc.id,
        _interstore_source_name: loc.store_name,
        _interstore_source_number: loc.store_number || loc.store_name,
        ...(prev._interstore_dest_id === loc.id ? { _interstore_dest_id: '', _interstore_dest_name: '', _interstore_dest_number: '' } : {})
      };
    });
  };

  // Dispatcher shortcut: toggle To; if selecting, also clear From if it was the same store
  const handleToShortcut = (loc) => {
    setFormData((prev) => {
      if (prev._interstore_dest_id === loc.id) {
        return { ...prev, _interstore_dest_id: '', _interstore_dest_name: '', _interstore_dest_number: '' };
      }
      return {
        ...prev,
        _interstore_dest_id: loc.id,
        _interstore_dest_name: loc.store_name,
        _interstore_dest_number: loc.store_number || loc.store_name,
        ...(prev._interstore_source_id === loc.id ? { _interstore_source_id: '', _interstore_source_name: '', _interstore_source_number: '' } : {})
      };
    });
  };

  return (
    <div className="flex flex-col gap-3">

      {/* Pickup / Dropoff toggle — only in Add to Route mode */}
      {isAddToRouteMode && (
        <div className="flex justify-center">
          <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-slate-300)' }}>
            {['pickup', 'dropoff'].map((type) => {
              const isActive = (formData._interstore_stop_type || 'pickup') === type;
              return (
                <button
                  key={type}
                  type="button"
                  disabled={isSaving}
                  onClick={() => setFormData((prev) => ({ ...prev, _interstore_stop_type: type }))}
                  className={`px-5 py-1.5 text-sm font-semibold transition-colors capitalize ${
                    isActive
                      ? type === 'pickup'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-blue-600 text-white'
                      : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
                  }`}
                >
                  {type === 'pickup' ? 'Pickup' : 'Drop Off'}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Route summary */}
      {(
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
          <span className={`font-semibold truncate max-w-[30%] ${sourceId ? 'text-emerald-700' : 'text-slate-400 italic'}`}>
            {sourceLocation ? sourceLocation.store_name : 'Select Pickup'}
          </span>
          <ArrowRight className="w-4 h-4 flex-shrink-0 text-slate-400" />
          <span className={`font-semibold truncate max-w-[30%] ${destId ? 'text-blue-700' : 'text-slate-400 italic'}`}>
            {destLocation ? destLocation.store_name : 'Select Destination'}
          </span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {bothSelected && (
              distanceLoading
                ? <span className="text-[10px] text-slate-400 animate-pulse">Calculating...</span>
                : drivingDistance
                  ? <span className="flex items-center gap-1 text-[10px] font-medium text-slate-600 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
                     <Route className="w-3 h-3" />
                     {drivingDistance.text}{drivingDistance.duration ? ` · ${drivingDistance.duration}` : ''}
                   </span>
                  : null
            )}
            {bothSelected && <Badge variant="outline" className="text-[10px] shrink-0">Route Set</Badge>}
          </div>
        </div>
      )}

      {/* From / To columns */}
      <div className="flex gap-3">
        <LocationPanel
          title="From:"
          color="emerald"
          locations={locations}
          loading={loading}
          selectedId={sourceId}
          onSelect={selectSource}
          isSaving={isSaving}
          dispatcherLocation={dispatcherLocation}
          onDispatcherShortcut={handleFromShortcut}
        />
        <div className="w-px bg-slate-200 dark:bg-slate-700 self-stretch" />
        <LocationPanel
          title="To:"
          color="blue"
          locations={locations}
          loading={loading}
          selectedId={destId}
          onSelect={selectDest}
          isSaving={isSaving}
          dispatcherLocation={dispatcherLocation}
          onDispatcherShortcut={handleToShortcut}
        />
      </div>

      {/* Status & Timing + Delivery Options */}
      <div className="grid grid-cols-2 gap-3">
        {/* Left: Status + Time fields */}
        <div className="flex flex-col gap-2 px-3 py-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
          <div className="flex flex-col gap-1 min-w-0">
            <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Status</Label>
            <Select value={formData.status || ''} onValueChange={(s) => setFormData((prev) => ({ ...prev, status: s }))} disabled={isSaving || statusLockedToInTransit}>
              <SelectTrigger className="h-9 text-sm w-full bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent className="z-[999999]">
                <SelectItem value="in_transit">In Transit</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Time Window (In Transit) */}
          {formData.status === 'in_transit' && (
            <>
              <TimePickerField
                label="Delivery Start"
                value={formData.delivery_time_start || ''}
                onChange={(v) => setFormData((prev) => ({ ...prev, delivery_time_start: v }))}
                disabled={isSaving}
              />
              <TimePickerField
                label="Delivery End"
                value={formData.delivery_time_end || ''}
                onChange={(v) => setFormData((prev) => ({ ...prev, delivery_time_end: v }))}
                disabled={isSaving}
              />
            </>
          )}

          {/* Arrival & Completed times (Completed) */}
          {formData.status === 'completed' && (
            <>
              <TimePickerField
                label="Arrival Time"
                value={(() => {
                  const v = formData.arrival_time || '';
                  if (v.includes('T')) return v.slice(11, 16);
                  return v.slice(0, 5);
                })()}
                onChange={(v) => setFormData((prev) => ({ ...prev, arrival_time: v ? `${prev.delivery_date}T${v}:00` : '' }))}
                disabled={isSaving}
              />
              <TimePickerField
                label="Completion Time"
                required
                value={(() => {
                  const v = formData.actual_delivery_time || '';
                  if (v.includes('T')) return v.slice(11, 16);
                  return v.slice(0, 5);
                })()}
                onChange={(v) => setFormData((prev) => ({ ...prev, actual_delivery_time: v ? `${prev.delivery_date}T${v}:00` : '' }))}
                disabled={isSaving}
              />
            </>
          )}
        </div>

        {/* Right: Delivery Options */}
        <div className="flex flex-col gap-2 px-3 py-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Delivery Options</Label>
          <div className="flex flex-col gap-3">
            {[
              { id: 'fridge_item', label: 'Fridge Item', field: 'fridge_item' },
              { id: 'oversized', label: 'Oversized', field: 'oversized' },
              { id: 'signature_needed', label: 'Signature Needed', field: 'signature_needed' },
              { id: 'no_charge', label: 'No Charge', field: 'no_charge' },
            ].map(({ id, label, field }) => (
              <div key={id} className="flex items-center gap-2">
                <Checkbox
                  id={`interstore_${id}`}
                  checked={!!formData[field]}
                  onCheckedChange={(c) => setFormData((prev) => ({ ...prev, [field]: c }))}
                  disabled={isSaving}
                />
                <Label htmlFor={`interstore_${id}`} className="text-sm font-medium leading-none">{label}</Label>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Transfer Notes */}
      <div className="flex flex-col gap-1 px-3 py-2 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Transfer Notes</Label>
        <Textarea
          value={formData._interstore_notes || ''}
          onChange={(e) => setFormData((prev) => ({ ...prev, _interstore_notes: e.target.value }))}
          placeholder="Notes for this inter-store transfer..."
          className="resize-none text-sm min-h-[60px]"
          disabled={isSaving}
        />
      </div>
    </div>
  );
}