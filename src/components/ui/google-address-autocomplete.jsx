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
      const response = await base44.functions.invoke('googlePlacesAutocomplete', {
        input: searchText,
        latitude: cityCenter?.latitude,
        longitude: cityCenter?.longitude,
        radius: 75000 // 75km in meters
      });

      const data = response?.data || response;
      
      if (data?.predictions) {
        setSuggestions(data.predictions);
        setOpen(true);
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
      // Get detailed place information
      const response = await base44.functions.invoke('googlePlaceDetails', {
        placeId: prediction.place_id
      });

      const data = response?.data || response;
      
      if (data?.result) {
        const place = data.result;
        
        // Extract address components
        const addressData = {
          full_address: place.formatted_address,
          latitude: place.geometry?.location?.lat,
          longitude: place.geometry?.location?.lng,
          place_id: place.place_id
        };

        // Call the parent handler with full address data
        if (onAddressSelect) {
          onAddressSelect(addressData);
        }
        
        // Update the input value
        onChange(place.formatted_address);
      }
    } catch (error) {
      console.error('Error fetching place details:', error);
    } finally {
      setOpen(false);
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
                    <div className="flex-1">
                      <div className="text-sm">{prediction.structured_formatting?.main_text}</div>
                      <div className="text-xs text-slate-500">
                        {prediction.structured_formatting?.secondary_text}
                      </div>
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