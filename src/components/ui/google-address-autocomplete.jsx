import React, { useState, useEffect, useRef, forwardRef } from 'react';
import { Input } from '@/components/ui/input';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MapPin } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Unabbreviate street names and abbreviate directionals
const unabbreviateAddress = (address) => {
  if (!address) return '';

  const abbreviations = {
    'Northwest': 'NW',
    'Northeast': 'NE',
    'Southwest': 'SW',
    'Southeast': 'SE'
  };

  const unabbreviations = {
    'St\\b': 'Street',
    'Ave\\b': 'Avenue',
    'Blvd\\b': 'Boulevard',
    'Dr\\b': 'Drive',
    'Rd\\b': 'Road',
    'Ln\\b': 'Lane',
    'Ct\\b': 'Court',
    'Pl\\b': 'Place',
    'Ter\\b': 'Terrace'
  };

  let result = address;
  
  // First abbreviate directionals
  Object.entries(abbreviations).forEach(([full, abbrev]) => {
    const regex = new RegExp(`\\b${full}\\b`, 'gi');
    result = result.replace(regex, abbrev);
  });
  
  // Then unabbreviate street types
  Object.entries(unabbreviations).forEach(([abbrev, full]) => {
    const regex = new RegExp(abbrev, 'gi');
    result = result.replace(regex, full);
  });

  return result;
};

/**
 * Google Address Autocomplete Component
 * Provides address suggestions within 75km of a specified city center
 */
export const GoogleAddressAutocomplete = forwardRef(function GoogleAddressAutocomplete({ 
  value, 
  onChange, 
  onAddressSelect,
  onSearchStateChange,
  cityCenter,
  placeholder = "Search address...",
  className = "",
  disabled = false
}, ref) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hasTypedSinceFocus, setHasTypedSinceFocus] = useState(false);
  const debounceTimer = useRef(null);
  const justSelected = useRef(false);
  const inputRef = useRef(null);
  const requestCount = useRef(0); // Track requests for debugging

  // Fetch suggestions from Google Places Autocomplete
  const fetchSuggestions = async (searchText) => {
    if (!searchText || searchText.length < 3) {
      setSuggestions([]);
      onSearchStateChange?.(false);
      return;
    }

    try {
      requestCount.current++;
      console.log(`📍 [GoogleAddressAutocomplete] Request #${requestCount.current} for: "${searchText}"`);
      setIsLoading(true);
      
      // CRITICAL: Log everything
      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log('🔍 [ADDRESS SEARCH DEBUG]');
      console.log('═══════════════════════════════════════════');
      console.log('Search text:', searchText);
      console.log('cityCenter prop:', cityCenter);
      console.log('Has coordinates?:', !!(cityCenter?.latitude && cityCenter?.longitude));
      
      if (!cityCenter?.latitude || !cityCenter?.longitude) {
        console.error('❌ CRITICAL: NO COORDINATES - SEARCH WILL BE UNRESTRICTED');
        console.log('═══════════════════════════════════════════');
      }
      
      // Prepare request payload
      const requestPayload = {
        input: searchText
      };
      
      if (cityCenter?.latitude && cityCenter?.longitude) {
        requestPayload.latitude = cityCenter.latitude;
        requestPayload.longitude = cityCenter.longitude;
      }
      
      console.log('📤 Request payload:', JSON.stringify(requestPayload, null, 2));
      
      const response = await base44.functions.invoke('googlePlacesAutocomplete', requestPayload);
      console.log('📥 Response:', response);

      const data = response?.data || response;
      console.log('[GoogleAddressAutocomplete] Parsed data:', data);
      console.log('[GoogleAddressAutocomplete] Predictions array:', data?.predictions);

      if (data?.predictions && data.predictions.length > 0) {
        console.log('[GoogleAddressAutocomplete] Got predictions:', data.predictions.length, data.predictions);
        setSuggestions(data.predictions);
        setSelectedIndex(0);
        setOpen(true);
        console.log('[GoogleAddressAutocomplete] State updated - open:', true, 'suggestions:', data.predictions);
      } else {
        console.log('[GoogleAddressAutocomplete] No predictions found');
        setSuggestions([]);
        setOpen(false);
        onSearchStateChange?.(false);
      }
    } catch (error) {
      console.error('Error fetching address suggestions:', error);
      setSuggestions([]);
      onSearchStateChange?.(false);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle address selection and fetch full details
  const handleSelectAddress = async (prediction) => {
    if (justSelected.current) return;
    try {
      // Set flag to prevent search after selection
      justSelected.current = true;
      
      // Cancel any pending debounced search to prevent reopen
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      
      // CRITICAL: Close dropdown immediately
      setOpen(false);
      setSuggestions([]);
      

      console.log('[GoogleAddressAutocomplete] Fetching details for:', prediction.place_id);
      
      // Get detailed place information
      const response = await base44.functions.invoke('googlePlaceDetails', {
        place_id: prediction.place_id
      });

      console.log('[GoogleAddressAutocomplete] Place details response:', response);

      const data = response?.data || response;
      const resolvedLatitude = data?.latitude ?? data?.lat ?? data?.location?.latitude ?? data?.location?.lat ?? data?.geometry?.location?.lat ?? null;
      const resolvedLongitude = data?.longitude ?? data?.lng ?? data?.location?.longitude ?? data?.location?.lng ?? data?.geometry?.location?.lng ?? null;
      
      // Prefer exact street_number + route if provided by backend, then parsed/formatted, then prediction
      const parsedStreet = (data.address || '').trim();
      const formatted = (data.formatted_address || '').trim();
      const fromFormatted = formatted ? (formatted.split(',')[0]?.trim() || formatted) : '';
      const fromPrediction = (prediction.description || '').split(',')[0]?.trim() || prediction.description;
      const streetFromComponents = (data?.street_number && data?.route) ? `${data.street_number} ${data.route}`.trim() : '';

      const primaryStreet = streetFromComponents || parsedStreet || fromFormatted || fromPrediction || '';
      const hasLeadingNumberPrimary = /^\d+\s/.test(primaryStreet);
      const hasLeadingNumberPrediction = /^\d+\s/.test(fromPrediction || '');
      let streetAddress = hasLeadingNumberPrimary ? primaryStreet : (hasLeadingNumberPrediction ? fromPrediction : primaryStreet);

      // FINAL SAFEGUARD: If selected street lacks a leading number but user typed one, prepend it
      const typedMatch = (value || '').trim().match(/^(\d+[A-Za-z]?)/);
      if (!/^\d+\s/.test(streetAddress) && typedMatch) {
        streetAddress = `${typedMatch[1]} ${streetAddress}`.trim();
      }

      const fullAddress = formatted || prediction.description || streetAddress;
      
      console.log('[GoogleAddressAutocomplete] Full address:', fullAddress);
      console.log('[GoogleAddressAutocomplete] Chosen street address:', streetAddress);
      console.log('[GoogleAddressAutocomplete] GPS Coords:', { lat: resolvedLatitude, lon: resolvedLongitude });
      
      const addressData = {
        full_address: fullAddress,
        street_address: streetAddress,
        latitude: resolvedLatitude,
        longitude: resolvedLongitude,
        lat: resolvedLatitude,
        lng: resolvedLongitude,
        place_id: prediction.place_id,
        distance: prediction.distance,
        unit: data.unit || null,
        street_number: data.street_number || null,
        route: data.route || null
      };

      console.log('[GoogleAddressAutocomplete] Address data being sent to parent:', addressData);

      // Call the parent handler with full address data
      if (onAddressSelect) {
        await onAddressSelect(addressData);
      }
      
      // Update the input value with street address only (preserves directionals like NW, SE)
      onChange(streetAddress);


      // Prevent blur formatter from altering the value during the immediate refocus to unit field
      justSelected.current = true;

      // Clear the flag after a short delay
      setTimeout(() => {
        justSelected.current = false;
      }, 400);
    } catch (error) {
      console.error('[GoogleAddressAutocomplete] Error fetching place details:', error);
      // Fallback to using the prediction description
      const streetAddress = prediction.description.split(',')[0]?.trim() || prediction.description;
      onChange(streetAddress);
      if (onAddressSelect) {
        onAddressSelect({
          full_address: prediction.description,
          street_address: streetAddress,
          place_id: prediction.place_id,
          distance: prediction.distance
        });
      }
      
      setTimeout(() => {
        justSelected.current = false;
      }, 300);
    } finally {
      setOpen(false);
      setSuggestions([]);
      onSearchStateChange?.(false);
    }
  };

  // Debounced search on input change
  useEffect(() => {
    if (justSelected.current) {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      return;
    }

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    if (!hasTypedSinceFocus) {
      setSuggestions([]);
      setOpen(false);
      onSearchStateChange?.(false);
      return;
    }

    debounceTimer.current = setTimeout(() => {
      if (value && value.trim().length >= 3) {
        fetchSuggestions(value.trim());
      } else {
        setSuggestions([]);
        setOpen(false);
        onSearchStateChange?.(false);
      }
    }, 400);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [value, hasTypedSinceFocus]);

  return (
    <div className="relative">
      <Input
        ref={(el) => {
          inputRef.current = el;
          if (ref) {
            if (typeof ref === 'function') ref(el);
            else ref.current = el;
          }
        }}
        value={value}
        onChange={(e) => {
          setHasTypedSinceFocus(true);
          onChange(e.target.value);
          onSearchStateChange?.(e.target.value.trim().length > 0);
        }}
        onFocus={() => {
          setHasTypedSinceFocus(false);
        }}
        onBlur={() => {
          // Do not change text on blur; just close the list after a short delay
          setTimeout(() => {
            setOpen(false);
            setSuggestions([]);
            setHasTypedSinceFocus(false);
            if (!justSelected.current) {
              onSearchStateChange?.(false);
            }
          }, 200);
        }}
        onKeyDown={(e) => {
          if (!open || suggestions.length === 0) return;

          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % suggestions.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            handleSelectAddress(suggestions[selectedIndex]);
          }
        }}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
      />
      {isLoading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 z-10">
          <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div>
        </div>
      )}
      
      {/* Dropdown for suggestions */}
      {open && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-md shadow-lg z-[10050] max-h-60 overflow-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', border: '1px solid var(--border-slate-200)' }}>
          {suggestions.map((prediction, index) => (
            <button
              key={prediction.place_id}
              type="button"
              onPointerDownCapture={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleSelectAddress(prediction);
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleSelectAddress(prediction);
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleSelectAddress(prediction);
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleSelectAddress(prediction);
              }}
              className={`w-full px-3 py-2 text-left text-sm flex items-start gap-2 last:border-b-0 transition-colors`}
              style={{
                background: index === selectedIndex ? 'var(--bg-slate-200)' : 'var(--bg-white)',
                borderBottom: '1px solid var(--border-slate-200)',
                color: 'var(--text-slate-900)'
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-slate-100)'}
              onMouseLeave={(e) => e.currentTarget.style.background = index === selectedIndex ? 'var(--bg-slate-200)' : 'var(--bg-white)'}
            >
              <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
              <div className="flex-1 flex items-center justify-between gap-2">
                <span>{prediction.description}</span>
                {prediction.distance !== null && (
                  <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                    {prediction.distance.toFixed(1)} km
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

GoogleAddressAutocomplete.displayName = 'GoogleAddressAutocomplete';