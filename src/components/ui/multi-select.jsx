import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { X, Check, ChevronDown } from "lucide-react";

const getMobileOverlayBounds = () => {
  if (typeof window === 'undefined') {
    return { maxHeight: 320, isMobileLike: false };
  }

  const mobileHeader = document.querySelector('[data-mobile-header]');
  const mobileBottomNav = document.querySelector('[data-mobile-bottom-nav]');
  const headerHeight = mobileHeader?.offsetHeight || 0;
  const bottomNavHeight = mobileBottomNav?.offsetHeight || 0;
  const isMobileLike = window.innerWidth < 768 || !!mobileHeader;
  const availableHeight = Math.max(220, Math.floor(window.innerHeight - headerHeight - bottomNavHeight - 8));

  return {
    maxHeight: availableHeight,
    isMobileLike,
    topOffset: headerHeight,
    bottomOffset: bottomNavHeight
  };
};

export const MultiSelect = React.forwardRef((props, ref) => {
  const { options = [], value: propValue = [], onChange, placeholder = "Select...", className, id, ...rest } = props;
  const [open, setOpen] = React.useState(false);
  const [overlayBounds, setOverlayBounds] = React.useState(() => getMobileOverlayBounds());
  // Ensure value is always an array to prevent rendering errors
  const value = Array.isArray(propValue) ? propValue : [];

  React.useEffect(() => {
    if (!open) return;

    const updateBounds = () => setOverlayBounds(getMobileOverlayBounds());
    updateBounds();
    window.addEventListener('resize', updateBounds);
    window.addEventListener('orientationchange', updateBounds);

    return () => {
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('orientationchange', updateBounds);
    };
  }, [open]);

  const handleSelect = (selectedValue) => {
    const newValue = value.includes(selectedValue) ?
    value.filter((item) => item !== selectedValue) :
    [...value, selectedValue];
    onChange(newValue);
  };

  const handleRemove = (e, removedValue) => {
    e.stopPropagation();
    const newValue = value.filter((item) => item !== removedValue);
    onChange(newValue);
    setOpen(true);
  };

  // Filter selected options based on the current value array - add safety checks
  const selectedOptions = (options || []).filter((option) =>
  option && value.includes(option.value)
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
          ref={ref}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={`w-full justify-between h-auto min-h-[32px] border-black ${className}`}
          onClick={() => setOpen(!open)}
          id={id}
          {...rest}>
          
                    <div className="flex gap-1 flex-wrap">
                        {selectedOptions && selectedOptions.length > 0 ?
            selectedOptions.map((option) => {
              if (!option) return null;
              return (
                <Badge
                  key={option.value}
                  variant="secondary" className="inline-flex items-center rounded-md border px-1.0 text-xs font-semibold transition-colors border-transparent mr-1 bg-slate-100 text-slate-800 hover:bg-slate-200">

                  
                                        {option.label || 'Unknown'}
                                        <span
                    className="ml-1 inline-flex cursor-pointer hover:bg-slate-300 rounded-full p-0.5"
                    onClick={(e) => handleRemove(e, option.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    role="button"
                    tabIndex={0}
                    aria-label={`Remove ${option.label || 'item'}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleRemove(e, option.value);
                      }
                    }}>
                    
                                            <X className="h-3 w-3" />
                                        </span>
                                    </Badge>);

            }) :

            <span className="text-slate-500">{placeholder}</span>
            }
                    </div>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[--radix-popover-trigger-width] p-0 z-[10003] overflow-hidden"
              align="start"
              sideOffset={4}
              style={overlayBounds.isMobileLike ? {
                maxHeight: `${overlayBounds.maxHeight}px`,
                top: `${overlayBounds.topOffset || 0}px`,
                bottom: `${overlayBounds.bottomOffset || 0}px`
              } : undefined}>
                <Command className="overflow-hidden">
                    <CommandList className="max-h-full overflow-y-auto overscroll-contain" style={overlayBounds.isMobileLike ? { maxHeight: `${overlayBounds.maxHeight}px` } : { maxHeight: '20rem' }}>
                        <CommandEmpty>No results found.</CommandEmpty>
                        <CommandGroup>
                            {(options || []).map((option) => {
                if (!option) return null;
                return (
                  <CommandItem
                    key={option.value}
                    onSelect={() => {
                      handleSelect(option.value);
                    }}>
                    
                                        <Check
                      className={`mr-2 h-4 w-4 ${
                      value.includes(option.value) ? "opacity-100" : "opacity-0"}`
                      } />
                    
                                        {option.label || 'Unknown Option'}
                                    </CommandItem>);

              })}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>);

});

MultiSelect.displayName = "MultiSelect";

export default MultiSelect;