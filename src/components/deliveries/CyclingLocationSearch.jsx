/**
 * CyclingLocationSearch
 * Direct dropdown select from saved CyclingLocation library (no search field —
 * changed Sep 14 2026 per owner request; the list is short enough per city that
 * typing to filter added friction instead of saving time).
 * Filters by nearest city (GPS → appUser city_id fallback → first city).
 * Sorted by distance-from-driver, then usage_count desc, then name asc.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MapPin, X } from 'lucide-react';
import { locationTracker } from '@/components/utils/locationTracker';

// Haversine distance in km
// Consolidated into geoUtils — identical math, single source of truth.
import { haversineKm as haversine } from '@/components/utils/geoUtils';

export default function CyclingLocationSearch({
  cities = [],
  currentUser,
  appUsers = [],
  onSelect,           // (location) => void — called when a saved location is chosen
  onClearSelection,   // () => void — called when user clears the selection
  selectedLocation,   // currently linked CyclingLocation record (or null)
  disabled = false,
}) {
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [cityId, setCityId] = useState(null);

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

  // Fetch locations when cityId changes
  const fetchLocations = useCallback(async () => {
    if (!cityId) return;
    setIsLoading(true);
    try {
      const all = await base44.entities.CyclingLocation.filter({ city_id: cityId });

      // Driver's current position for as-the-crow-flies distance ranking.
      // Falls back to null when GPS is unavailable — those locations sort last.
      let driverLat = null;
      let driverLon = null;
      const cached = locationTracker.getCachedPosition();
      if (cached?.latitude != null && cached?.longitude != null) {
        driverLat = cached.latitude;
        driverLon = cached.longitude;
      } else {
        const driverAppUser = (appUsers || []).find((au) => au?.user_id === currentUser?.id);
        if (driverAppUser?.current_latitude != null && driverAppUser?.current_longitude != null) {
          driverLat = driverAppUser.current_latitude;
          driverLon = driverAppUser.current_longitude;
        }
      }
      const distFromDriver = (loc) => {
        if (driverLat == null || loc.latitude == null || loc.longitude == null) return Infinity;
        return haversine(driverLat, driverLon, loc.latitude, loc.longitude);
      };

      const sorted = (all || [])
        .slice()
        .sort((a, b) => {
          const da = distFromDriver(a);
          const db = distFromDriver(b);
          return da - db ||
            (b.usage_count || 0) - (a.usage_count || 0) ||
            (a.name || '').localeCompare(b.name || '');
        });
      setResults(sorted);
    } catch (_) {
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, [cityId, appUsers, currentUser?.id]);

  useEffect(() => {
    fetchLocations();
  }, [fetchLocations]);

  const handleSelect = (locId) => {
    const loc = results.find((r) => r.id === locId);
    if (loc) onSelect?.(loc);
  };

  const handleClear = () => {
    onClearSelection?.();
  };

  return (
    <div className="space-y-1">
      <Label className="text-sm font-semibold text-body">
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
        <Select
          value={undefined}
          onValueChange={handleSelect}
          disabled={disabled || !cityId || isLoading}
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder={isLoading ? 'Loading…' : 'Select a saved cycling spot…'} />
          </SelectTrigger>
          <SelectContent className="z-[999999]">
            {results.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-400">No saved locations found</div>
            ) : (
              results.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  <span className="flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                    <span className="flex-1 truncate font-medium">{loc.name}</span>
                    {loc.usage_count > 0 && (
                      <span className="text-xs text-slate-400 dark:text-slate-400 flex-shrink-0">×{loc.usage_count}</span>
                    )}
                  </span>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
