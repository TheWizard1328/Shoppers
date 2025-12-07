import React, { useState, useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MapPin } from 'lucide-react';
import { base44 } from '@/api/base44Client';

/**
 * Google Address Autocomplete Component
 * Provides address suggestions within 75km of a specified city center
 */
export function GoogleAddressAutocomplete({ 
  value, 
  onChange, 
  onAddressSelect,
  cityCenter,
  placeholder = "Search address...",
  className = "",
  disabled = false
}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const debounceTimer = useRef(null);

  // Fetch suggestions from Google Places Autocomplete
  const fetchSuggestions = async (searchText) => {
    if (!searchText || searchText.length < 3) {
      setSuggestions([]);
      return;
    }

    try {
      setIsLoading(true);
      console.log('[GoogleAddressAutocomplete] Fetching suggestions for:', searchText);
      console.log('[GoogleAddressAutocomplete] City center coordinates:', cityCenter);
      
      // CRITICAL: Validate that we have coordinates
      if (!cityCenter?.latitude || !cityCenter?.longitude) {
        console.error('[GoogleAddressAutocomplete] ❌ NO CITY CENTER COORDINATES PROVIDED!');
      } else {
        console.log('[GoogleAddressAutocomplete] ✅ Using coordinates:', cityCenter.latitude, cityCenter.longitude);
      }
      
      // Prepare request payload - only include coordinates if available
      const requestPayload = {
        input: searchText
      };
      
      // Add location biasing if city center coordinates are available
      if (cityCenter?.latitude && cityCenter?.longitude) {
        requestPayload.latitude = cityCenter.latitude;
        requestPayload.longitude = cityCenter.longitude;
        console.log('[GoogleAddressAutocomplete] ✅ Added coordinates to request:', requestPayload);
      } else {
        console.warn('[GoogleAddressAutocomplete] ⚠️ Searching without geographic restrictions (no coordinates)');
      }
      
      const response = await base44.functions.invoke('googlePlacesAutocomplete', requestPayload);

      console.log('[GoogleAddressAutocomplete] Raw response:', response);

      const data = response?.data || response;
      console.log('[GoogleAddressAutocomplete] Parsed data:', data);
      console.log('[GoogleAddressAutocomplete] Predictions array:', data?.predictions);

      if (data?.predictions && data.predictions.length > 0) {
        console.log('[GoogleAddressAutocomplete] Got predictions:', data.predictions.length, data.predictions);
        setSuggestions(data.predictions);
        setOpen(true);
        console.log('[GoogleAddressAutocomplete] State updated - open:', true, 'suggestions:', data.predictions);
      } else {
        console.log('[GoogleAddressAutocomplete] No predictions found');
        setSuggestions([]);
        setOpen(false);
      }
    } catch (error) {
      console.error('Error fetching address suggestions:', error);
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle address selection and fetch full details
  const handleSelectAddress = async (prediction) => {
    try {
      console.log('[GoogleAddressAutocomplete] Fetching details for:', prediction.place_id);
      
      // Get detailed place information
      const response = await base44.functions.invoke('googlePlaceDetails', {
        place_id: prediction.place_id
      });

      console.log('[GoogleAddressAutocomplete] Place details response:', response);

      const data = response?.data || response;
      
      // The backend returns formatted_address, not result.formatted_address
      const addressData = {
        full_address: data.formatted_address || prediction.description,
        latitude: data.latitude,
        longitude: data.longitude,
        place_id: prediction.place_id
      };

      console.log('[GoogleAddressAutocomplete] Address data:', addressData);

      // Call the parent handler with full address data
      if (onAddressSelect) {
        onAddressSelect(addressData);
      }
      
      // Update the input value
      onChange(data.formatted_address || prediction.description);
    } catch (error) {
      console.error('[GoogleAddressAutocomplete] Error fetching place details:', error);
      // Fallback to using the prediction description
      onChange(prediction.description);
      if (onAddressSelect) {
        onAddressSelect({
          full_address: prediction.description,
          place_id: prediction.place_id
        });
      }
    } finally {
      setOpen(false);
      setSuggestions([]);
    }
  };

  // Debounced search on input change
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // Debounce by 400ms (slight pause)
    debounceTimer.current = setTimeout(() => {
      if (value && value.length >= 3) {
        fetchSuggestions(value);
      } else {
        setSuggestions([]);
        setOpen(false);
      }
    }, 400);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [value, cityCenter]);

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg z-50 max-h-60 overflow-auto">
          {suggestions.map((prediction) => (
            <button
              key={prediction.place_id}
              onClick={() => handleSelectAddress(prediction)}
              className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 flex items-start gap-2 border-b border-slate-100 last:border-b-0"
            >
              <MapPin className="w-4 h-4 mt-0.5 text-slate-500 flex-shrink-0" />
              <span className="flex-1">{prediction.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}