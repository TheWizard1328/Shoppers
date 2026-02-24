import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { SelectTrigger, SelectValue } from '@/components/ui/select';

export function MobileSelect({ 
  value, 
  onValueChange, 
  children, 
  options,
  placeholder,
  disabled,
  className,
  triggerClassName
}) {
  const [open, setOpen] = useState(false);

  // Support both children and options prop formats
  let items = [];
  if (options) {
    items = options.map(opt => ({
      value: opt.value,
      label: opt.label
    }));
  } else {
    items = React.Children.toArray(children).filter(
      child => child.type?.displayName === 'SelectItem' || child.props?.value !== undefined
    );
  }

  const selectedItem = items.find(item => 
    options ? item.value === value : item.props.value === value
  );

  const handleSelect = (itemValue) => {
    onValueChange(itemValue);
    setOpen(false);
  };

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <SelectTrigger className={triggerClassName} disabled={disabled}>
          <SelectValue>
            {selectedItem ? (options ? selectedItem.label : selectedItem.props.children) : placeholder}
          </SelectValue>
        </SelectTrigger>
      </DrawerTrigger>
      <DrawerContent className={className}>
        <DrawerHeader className="text-left">
          <DrawerTitle>Select an option</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4 max-h-[60vh] overflow-y-auto">
          <div className="space-y-1">
            {items.map((item, index) => {
              const itemValue = options ? item.value : item.props.value;
              const itemLabel = options ? item.label : item.props.children;
              const isSelected = itemValue === value;
              
              return (
                <button
                  key={itemValue || index}
                  onClick={() => handleSelect(itemValue)}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-lg transition-colors text-left select-none ${
                    isSelected 
                      ? 'bg-emerald-50 border border-emerald-200' 
                      : 'hover:bg-slate-50 border border-transparent'
                  }`}
                  style={{ color: 'var(--text-slate-900)' }}
                >
                  <span>{itemLabel}</span>
                  {isSelected && <Check className="w-5 h-5 text-emerald-600" />}
                </button>
              );
            })}
          </div>
        </div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}