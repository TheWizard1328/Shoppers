/**
 * CyclingLocationSearch
 * Search/select from saved CyclingLocation library.
 * Filters by nearest city (GPS → appUser city_id fallback → first city).
 * Sorted by usage_count desc, then name asc.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { MapPin, Search, X } from 'lucide-react';
import { locationTracker } from '@/components/utils/locationTracker';

// Haversine distance in km
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function CyclingLocationSearch({
  cities = [],
  currentUser,
  appUsers = [],
  onSelect,           // (location) => void — called when a saved location is chosen
  onClearSelection,   // () => void — called when user clears the selection
  selectedLocation,   // currently linked CyclingLocation record (or null)
  disabled = false,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [cityId, setCityId] = useState(null);
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);

  // Resolve which city to filter by
  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      // 1. Try GPS → find nearest city
      // Use the locationTracker's cached position — it's always fresh (≤15s old)
      // and survives backgrounding, unlike a one-shot getCurrentPosition that
      // times out when GPS is still re-acquiring after the app returns from
      // background.
      if (cities.length > 0) {
        const cached = locationTracker.getCachedPosition();
        if (cached) {
          let nearest = null;
          let minDist = Infinity;
          for (const city of cities) {
            if (!city.latitude || !city.longitude) continue;
            const d = haversine(cached.latitude, cached.longitude, city.latitude, city.longitude);
            if (d < minDist) { minDist = d; nearest = city; }
          }
          if (nearest && !cancelled) { setCityId(nearest.id); return; }
        }
      }

      // 2. Fall back to appUser city_id
      const driverAppUser = (appUsers || []).find((au) => au?.user_id === currentUser?.id);
      const fallbackCityId = driverAppUser?.city_id || driverAppUser?.city_ids?.[0] || null;
      if (fallbackCityId && !cancelled) { setCityId(fallbackCityId); return; }

      // 3. Fall back to first city
      if (cities.length > 0 && !cancelled) setCityId(cities[0].id);
    };

    resolve();
    return () => { cancelled = true; };
  }, [cities, currentUser?.id, appUsers]);

  // Fetch locations when query or cityId changes
  const fetchLocations = useCallback(async (searchQuery) => {
    if (!cityId) return;
    setIsLoading(true);
    try {
      const all = await base44.entities.CyclingLocation.filter({ city_id: cityId });
      const q = searchQuery.toLowerCase().trim();
      const filtered = (all || [])
        .filter((loc) => !q || loc.name?.toLowerCase().includes(q))
        .sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0) || (a.name || '').localeCompare(b.name || ''));
      setResults(filtered.slice(0, 8));
    } catch (_) {
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, [cityId]);

  useEffect(() => {
    if (!isOpen) return;
    fetchLocations(query);
  }, [query, isOpen, fetchLocations]);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        inputRef.current && !inputRef.current.contains(e.target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (loc) => {
    setIsOpen(false);
    setQuery('');
    onSelect?.(loc);
  };

  const handleClear = () => {
    setQuery('');
    setIsOpen(false);
    onClearSelection?.();
  };

  return (
    <div className="space-y-1">
      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
        Saved Location Library
      </Label>

      {selectedLocation ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-emerald-50 border-emerald-300">
          <MapPin className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          <span className="text-sm font-medium text-emerald-800 flex-1 truncate">{selectedLocation.name}</span>
          {!disabled && (
            <button
              type="button"
              onClick={handleClear}
              className="text-emerald-500 hover:text-emerald-700 flex-shrink-0"
              title="Clear selection"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
            onFocus={() => { setIsOpen(true); fetchLocations(query); }}
            placeholder="Search saved cycling spots…"
            className="pl-9 h-9 text-sm"
            disabled={disabled || !cityId}
          />
          {isOpen && (
            <div
              ref={dropdownRef}
              className="absolute z-[999999] top-full left-0 right-0 mt-1 rounded-lg border shadow-lg overflow-hidden"
              style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
            >
              {isLoading ? (
                <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
              ) : results.length === 0 ? (
                <div className="px-3 py-2 text-xs text-slate-400">No saved locations found</div>
              ) : (
                results.map((loc) => (
                  <button
                    key={loc.id}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); handleSelect(loc); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2 border-b last:border-b-0"
                    style={{ borderColor: 'var(--border-slate-100)' }}
                  >
                    <MapPin className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                    <span className="flex-1 truncate font-medium">{loc.name}</span>
                    {loc.usage_count > 0 && (
                      <span className="text-xs text-slate-400 flex-shrink-0">×{loc.usage_count}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}