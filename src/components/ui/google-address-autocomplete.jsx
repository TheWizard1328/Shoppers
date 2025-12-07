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
      console.log('[GoogleAddressAutocomplete] Fetching suggestions for:', searchText, cityCenter);
      
      // Prepare request payload - only include coordinates if available
      const requestPayload = {
        input: searchText
      };
      
      // Add location biasing if city center coordinates are available
      if (cityCenter?.latitude && cityCenter?.longitude) {
        requestPayload.latitude = cityCenter.latitude;
        requestPayload.longitude = cityCenter.longitude;
      }
      
      const response = await base44.functions.invoke('googlePlacesAutocomplete', requestPayload);

      console.log('[GoogleAddressAutocomplete] Response:', response);

      const data = response?.data || response;
      
      if (data?.predictions && data.predictions.length > 0) {
        console.log('[GoogleAddressAutocomplete] Got predictions:', data.predictions.length);
        setSuggestions(data.predictions);
        setOpen(true);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={className}
            disabled={disabled}
          />
          {isLoading && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div>
            </div>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent 
        className="w-[--radix-popover-trigger-width] p-0" 
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command>
          <CommandList>
            {suggestions.length === 0 ? (
              <CommandEmpty>
                {isLoading ? 'Searching...' : 'No addresses found'}
              </CommandEmpty>
            ) : (
              <CommandGroup>
                {suggestions.map((prediction) => (
                  <CommandItem
                    key={prediction.place_id}
                    value={prediction.description}
                    onSelect={() => handleSelectAddress(prediction)}
                    className="cursor-pointer"
                  >
                    <MapPin className="w-4 h-4 mr-2 text-slate-500" />
                    <div className="flex-1 text-sm">
                      {prediction.description}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}