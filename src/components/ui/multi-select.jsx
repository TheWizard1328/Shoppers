import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { X, Check, ChevronDown } from "lucide-react";

export const MultiSelect = React.forwardRef((props, ref) => {
  const { options = [], value: propValue = [], onChange, placeholder = "Select...", className, id, ...rest } = props;
  const [open, setOpen] = React.useState(false);
  // Ensure value is always an array to prevent rendering errors
  const value = Array.isArray(propValue) ? propValue : [];

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
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={`flex min-h-11 w-full items-center justify-between rounded-md border px-3 py-2 text-sm shadow-sm ${className || ''}`}
          style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}
          id={id}
          {...rest}>
          
                    <div className="flex min-w-0 flex-1 flex-wrap gap-1 text-left">
                        {selectedOptions && selectedOptions.length > 0 ?
            selectedOptions.map((option) => {
              if (!option) return null;
              return (
                <Badge
                  key={option.value}
                  variant="secondary" className="mr-1 inline-flex h-6 items-center rounded-md border border-transparent bg-slate-100 px-2 py-0 text-xs font-semibold leading-none text-slate-800 hover:bg-slate-200">

                  
                                        {option.label || 'Unknown'}
                                        <button
                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-slate-300"
                    onClick={(e) => handleRemove(e, option.value)}
                    type="button"
                    aria-label={`Remove ${option.label || 'item'}`}>
                    
                                            <X className="h-3 w-3" />
                                        </button>
                                    </Badge>);

            }) :

            <span className="truncate text-slate-500">{placeholder}</span>
            }
                    </div>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="z-[10003] w-[--radix-popover-trigger-width] p-0" sideOffset={4} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <Command>
                    <CommandInput placeholder="Search dispatchers..." />
                    <CommandList>
                        <CommandEmpty>No results found.</CommandEmpty>
                        <CommandGroup>
                            {(options || []).map((option) => {
                if (!option) return null;
                return (
                  <CommandItem
                    key={option.value}
                    value={String(option.value)}
                    className="min-h-11 cursor-pointer"
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