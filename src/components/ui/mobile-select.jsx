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
        <Button variant="outline" className={triggerClassName} disabled={disabled}>
          {selectedItem ? (options ? selectedItem.label : selectedItem.props.children) : placeholder}
        </Button>
      </DrawerTrigger>
      {/* OWNER REPORT (Nov 15 2026, iPhone screenshot of Theme): huge empty bands above and
          below the option list. Three pads were stacking inside one bottom sheet - the
          DrawerHeader carries pt-[max(1rem,env(safe-area-inset-top))] (48px on an iPhone
          PWA, which belongs to a top sheet, not this one), and the content AND the options
          list each added their own max(1rem, env(safe-area-inset-bottom)) on top of the
          DrawerFooter's own bottom pad. The paddings now live in one place: a tight header,
          a 0.5rem list tail, and the footer owning the single safe-area bottom pad. */}
      <DrawerContent className={`z-[10030] pb-0 ${className || ''}`}>
        <DrawerHeader className="text-left px-4 pt-1 pb-2">
          <DrawerTitle>Select an option</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-2 max-h-[60vh] overflow-y-auto">
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
                      ? 'bg-emerald-50 border border-emerald-200 text-emerald-900 dark:bg-emerald-500/15 dark:border-emerald-500/40 dark:text-emerald-100'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800 border border-transparent text-body'
                  }`}
                >
                  <span>{itemLabel}</span>
                  {isSelected && <Check className="w-5 h-5 text-emerald-600 dark:text-emerald-300" />}
                </button>
              );
            })}
          </div>
        </div>
        <DrawerFooter className="mt-0 p-3 pt-0 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
          <DrawerClose asChild>
            <Button variant="outline">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}