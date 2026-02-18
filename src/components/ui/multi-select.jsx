import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { X, Check, ChevronDown } from "lucide-react";

export const MultiSelect = React.forwardRef(({ options = [], value: propValue = [], onChange, placeholder = "Select...", className, ...props }, ref) => {
    const [open, setOpen] = React.useState(false);
    // Ensure value is always an array to prevent rendering errors
    const value = Array.isArray(propValue) ? propValue : [];

    const handleSelect = (selectedValue) => {
        const newValue = value.includes(selectedValue)
            ? value.filter(item => item !== selectedValue)
            : [...value, selectedValue];
        onChange(newValue);
    };

    const handleRemove = (e, removedValue) => {
        e.stopPropagation();
        const newValue = value.filter(item => item !== removedValue);
        onChange(newValue);
        setOpen(true);
    };
    
    // Filter selected options based on the current value array - add safety checks
    const selectedOptions = (options || []).filter(option => 
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
                    {...props}
                >
                    <div className="flex gap-1 flex-wrap">
                        {selectedOptions && selectedOptions.length > 0 ? (
                            selectedOptions.map(option => {
                                if (!option) return null;
                                return (
                                    <Badge
                                        key={option.value}
                                        variant="secondary"
                                        className="mr-1 bg-slate-100 text-slate-800 hover:bg-slate-200"
                                    >
                                        {option.label || 'Unknown'}
                                        <button
                                            className="ml-1 hover:bg-slate-300 rounded-full p-0.5"
                                            onClick={(e) => handleRemove(e, option.value)}
                                            type="button"
                                            aria-label={`Remove ${option.label || 'item'}`}
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </Badge>
                                );
                            })
                        ) : (
                            <span className="text-slate-500">{placeholder}</span>
                        )}
                    </div>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0 z-[10003]">
                <Command>
                    <CommandList>
                        <CommandEmpty>No results found.</CommandEmpty>
                        <CommandGroup>
                            {(options || []).map((option) => {
                                if (!option) return null;
                                return (
                                    <CommandItem
                                        key={option.value}
                                        onSelect={() => {
                                            handleSelect(option.value);
                                        }}
                                    >
                                        <Check
                                            className={`mr-2 h-4 w-4 ${
                                                value.includes(option.value) ? "opacity-100" : "opacity-0"
                                            }`}
                                        />
                                        {option.label || 'Unknown Option'}
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
});

MultiSelect.displayName = "MultiSelect";

export default MultiSelect;