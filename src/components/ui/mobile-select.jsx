import React, { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
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

export function MobileSelect({ 
  value, 
  onValueChange, 
  children, 
  placeholder,
  disabled,
  className,
  triggerClassName
}) {
  const [open, setOpen] = useState(false);

  // Extract items from children
  const items = React.Children.toArray(children).filter(
    child => child.type?.displayName === 'SelectItem' || child.props?.value !== undefined
  );

  const selectedItem = items.find(item => item.props.value === value);

  const handleSelect = (itemValue) => {
    onValueChange(itemValue);
    setOpen(false);
  };

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          className={`flex h-9 md:h-9 min-h-[44px] md:min-h-0 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${triggerClassName || ''}`}
          disabled={disabled}
          style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}
        >
          <span>{selectedItem ? selectedItem.props.children : placeholder}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </button>
      </DrawerTrigger>
      <DrawerContent className={className}>
        <DrawerHeader className="text-left">
          <DrawerTitle>Select an option</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4 max-h-[60vh] overflow-y-auto">
          <div className="space-y-1">
            {items.map((item, index) => {
              const itemValue = item.props.value;
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
                  <span>{item.props.children}</span>
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