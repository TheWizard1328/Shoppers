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
export const GoogleAddressAutocomplete = React.forwardRef(({ 
  value, 
  onChange, 
  onAddressSelect,
  cityCenter,
  placeholder = "Search address...",
  className = "",
  disabled = false
}, ref) => {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const debounceTimer = useRef(null);
  const justSelected = useRef(false);
  const initialValue = useRef(value);
  const hasUserTyped = useRef(false);

  // Fetch suggestions from Google Places Autocomplete
  const fetchSuggestions = async (searchText) => {
    if (!searchText || searchText.length < 3) {
      setSuggestions([]);
      return;
    }

    try {
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
        setOpen(true);
        setSelectedIndex(-1);
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
      // Set flag to prevent search after selection
      justSelected.current = true;
      
      console.log('[GoogleAddressAutocomplete] Fetching details for:', prediction.place_id);
      
      // Get detailed place information
      const response = await base44.functions.invoke('googlePlaceDetails', {
        place_id: prediction.place_id
      });

      console.log('[GoogleAddressAutocomplete] Place details response:', response);

      const data = response?.data || response;
      
      // Extract only street address (remove city, province, postal code, country)
      const fullAddress = data.formatted_address || prediction.description;
      const streetAddress = fullAddress.split(',')[0]?.trim() || fullAddress;
      
      console.log('[GoogleAddressAutocomplete] Full address:', fullAddress);
      console.log('[GoogleAddressAutocomplete] Street address:', streetAddress);
      console.log('[GoogleAddressAutocomplete] GPS Coords:', { lat: data.latitude, lon: data.longitude });
      
      const addressData = {
        full_address: fullAddress,
        street_address: streetAddress,
        latitude: data.latitude,
        longitude: data.longitude,
        place_id: prediction.place_id
      };

      console.log('[GoogleAddressAutocomplete] Address data being sent to parent:', addressData);

      // Call the parent handler with full address data
      if (onAddressSelect) {
        onAddressSelect(addressData);
      }
      
      // Update the input value with street address only (preserves directionals like NW, SE)
      onChange(streetAddress);
      
      // Clear the flag after a short delay
      setTimeout(() => {
        justSelected.current = false;
      }, 300);
    } catch (error) {
      console.error('[GoogleAddressAutocomplete] Error fetching place details:', error);
      // Fallback to using the prediction description
      const streetAddress = prediction.description.split(',')[0]?.trim() || prediction.description;
      onChange(streetAddress);
      if (onAddressSelect) {
        onAddressSelect({
          full_address: prediction.description,
          street_address: streetAddress,
          place_id: prediction.place_id
        });
      }
      
      setTimeout(() => {
        justSelected.current = false;
      }, 300);
    } finally {
      setOpen(false);
      setSuggestions([]);
    }
  };

  // Debounced search on input change
  useEffect(() => {
    // Skip search if we just selected an address
    if (justSelected.current) {
      console.log('[GoogleAddressAutocomplete] Skipping search - just selected an address');
      return;
    }
    
    // Skip search if this is the initial value (form opened with pre-populated address)
    if (value === initialValue.current && !hasUserTyped.current) {
      console.log('[GoogleAddressAutocomplete] Skipping search - initial value, user has not typed yet');
      return;
    }
    
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // Debounce by 1500ms (wait for user to finish typing)
    debounceTimer.current = setTimeout(() => {
      if (value && value.length >= 3 && hasUserTyped.current) {
        fetchSuggestions(value);
      } else {
        setSuggestions([]);
        setOpen(false);
      }
    }, 1500);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [value]);

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => {
          hasUserTyped.current = true;
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          // Prevent Enter from submitting the form when autocomplete is open
          if (e.key === 'Enter' && open && suggestions.length > 0) {
            e.preventDefault();
            e.stopPropagation();
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
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg z-50 max-h-60 overflow-auto">
          {suggestions.map((prediction, index) => (
            <button
              key={prediction.place_id}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleSelectAddress(prediction);
              }}
              className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 flex items-start gap-2 border-b border-slate-100 last:border-b-0"
            >
              <MapPin className="w-4 h-4 mt-0.5 text-slate-500 flex-shrink-0" />
              <div className="flex-1 flex items-center justify-between gap-2">
                <span>{prediction.description}</span>
                {prediction.distance !== null && (
                  <span className="text-xs text-slate-500">
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
}