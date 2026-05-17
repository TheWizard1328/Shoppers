import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Edit, Trash2, Palette, Save, X, Copy, Check, DollarSign, Calendar, CreditCard, Phone, MapPin } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format, parseISO } from "date-fns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger } from
"@/components/ui/alert-dialog";
import { getStoreColor } from "../utils/colorGenerator";
import { formatPhoneNumber } from "../utils/formatters";
import { userHasRole } from "../utils/userRoles";
import { updateStoreLocal } from "@/components/utils/offlineMutations";

export default function StoreCard({ store, onEdit, onDelete, onSave, currentUser, drivers, onSelect, isSelected, isLimitedView, hideEditDelete }) {
  const [editingColor, setEditingColor] = useState(false);
  const [editableStore, setEditableStore] = useState({ ...store });
  const [copiedId, setCopiedId] = useState(false);
  const [copiedDispatcherId, setCopiedDispatcherId] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [editingDateType, setEditingDateType] = useState(null); // 'start' or 'end'
  const [editingSlot, setEditingSlot] = useState(null);
  const [editingSlotDriverId, setEditingSlotDriverId] = useState('null');

  // Generate color locally if missing (don't auto-save to avoid infinite loops)
  const displayColor = store.color || getStoreColor(store);

  useEffect(() => {
    setEditableStore({ ...store });
  }, [store]);

  const handleColorSave = async (newColor) => {
    try {
      const updatedStore = await updateStoreLocal(store.id, { color: newColor });
      const { invalidate } = await import('@/components/utils/dataManager');
      invalidate('Store');
      setEditableStore(updatedStore);
      window.dispatchEvent(new CustomEvent('storeUpdated', { detail: { storeId: store.id, updatedStore } }));
      setEditingColor(false);
    } catch (error) {
      console.error("Error saving store color:", error);
    }
  };

  const handleCancelColorEdit = () => {
    setEditableStore({ ...store });
    setEditingColor(false);
  };

  const handleQuickEdit = (field, value) => {
    setEditableStore((prev) => ({ ...prev, [field]: value }));
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(store.id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch (err) {
      console.error('Failed to copy ID:', err);
    }
  };

  const handleCopyDispatcherId = async () => {
    try {
      await navigator.clipboard.writeText(store.dispatcher_id);
      setCopiedDispatcherId(true);
      setTimeout(() => setCopiedDispatcherId(false), 2000);
    } catch (err) {
      console.error('Failed to copy Dispatcher ID:', err);
    }
  };

  const currentStoreColor = editableStore.color || displayColor;

  const slotConfig = {
    weekday_am: { label: 'Weekdays AM', driverIdField: 'weekday_am_driver_id', driverNameField: 'weekday_am_driver', startField: 'weekday_am_start', endField: 'weekday_am_end' },
    saturday_am: { label: 'Saturdays AM', driverIdField: 'saturday_am_driver_id', driverNameField: 'saturday_am_driver', startField: 'saturday_am_start', endField: 'saturday_am_end' },
    sunday_am: { label: 'Sundays AM', driverIdField: 'sunday_am_driver_id', driverNameField: 'sunday_am_driver', startField: 'sunday_am_start', endField: 'sunday_am_end' },
    weekday_pm: { label: 'Weekdays PM', driverIdField: 'weekday_pm_driver_id', driverNameField: 'weekday_pm_driver', startField: 'weekday_pm_start', endField: 'weekday_pm_end' },
    saturday_pm: { label: 'Saturdays PM', driverIdField: 'saturday_pm_driver_id', driverNameField: 'saturday_pm_driver', startField: 'saturday_pm_start', endField: 'saturday_pm_end' },
    sunday_pm: { label: 'Sundays PM', driverIdField: 'sunday_pm_driver_id', driverNameField: 'sunday_pm_driver', startField: 'sunday_pm_start', endField: 'sunday_pm_end' }
  };

  const canQuickEditSlot = (slotKey) => {
    const config = slotConfig[slotKey];
    if (!config) return false;
    return !!((store[config.driverIdField] || store[config.driverNameField]) && store[config.startField] && store[config.endField]);
  };

  const openSlotEditor = (slotKey) => {
    const config = slotConfig[slotKey];
    if (!config || !canQuickEditSlot(slotKey)) return;
    setEditingSlot(slotKey);
    setEditingSlotDriverId(store[config.driverIdField] || 'null');
  };

  const handleSlotDriverSave = async () => {
    if (!editingSlot) return;
    const config = slotConfig[editingSlot];
    const selectedDriver = drivers?.find((driver) => driver?.id === editingSlotDriverId);
    try {
      const updatedStore = await updateStoreLocal(store.id, {
        [config.driverIdField]: editingSlotDriverId === 'null' ? null : editingSlotDriverId,
        [config.driverNameField]: editingSlotDriverId === 'null' ? '' : selectedDriver?.user_name || selectedDriver?.full_name || ''
      });
      setEditableStore(updatedStore);
      const { invalidate } = await import('@/components/utils/dataManager');
      invalidate('Store');
      window.dispatchEvent(new CustomEvent('storeUpdated', { detail: { storeId: store.id, updatedStore } }));
      setEditingSlot(null);
    } catch (error) {
      console.error('Error saving store driver assignment:', error);
    }
  };

  // Helper to get background style for active slots
  const getSlotBgStyle = (isEnabled, hasDriver) => {
    if (isEnabled !== false && hasDriver) {
      // Active slot - use store color with transparency
      return {
        backgroundColor: `${currentStoreColor}15`, // 15 in hex = ~8% opacity
        borderLeft: `3px solid ${currentStoreColor}`
      };
    }
    return {}; // Disabled or no driver - use default slate-100
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
      className="h-full">

      <Card
        className={`overflow-hidden hover:border-emerald-400 transition-all duration-200 hover:shadow-lg cursor-pointer h-full ${isSelected ? 'ring-2 ring-emerald-500 border-emerald-500' : ''}`}
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
        onClick={() => onSelect?.(store)}>

        <CardContent className="p-4 flex flex-col justify-between h-full">
          <div>
            {/* Header with Store Name, Address, Phone (first 4 rows in limited view) */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap flex-1">
                  <h3 className="font-semibold text-xl" style={{ color: 'var(--text-slate-900)' }}>
                    {store.name}
                  </h3>
                  {store.abbreviation &&
                  <Badge className="px-2.5 py-0.5 text-xs font-semibold rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent shadow hover:bg-primary/80"

                  style={{ backgroundColor: currentStoreColor, color: 'white' }}>

                      {store.abbreviation}
                    </Badge>
                  }
                  {store.square_location_config_id &&
                  <Badge variant="outline" className="px-1.5 py-0.5 text-xs font-medium rounded-md inline-flex items-center gap-1" style={{ borderColor: '#10b981', color: '#059669' }}>
                      <CreditCard className="w-3 h-3" />
                    </Badge>
                  }
                </div>
                
                {!hideEditDelete && <div className="flex gap-2 items-center flex-shrink-0">
                  <Button variant="ghost" size="sm" onClick={(e) => {e.stopPropagation();onEdit(store);}} className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:bg-accent h-8 rounded-md px-3 text-xs text-red-600 hover:text-accent-foreground">
                    <Edit className="w-4 h-4" />
                  </Button>
                  {currentUser && userHasRole(currentUser, 'admin') &&
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={(e) => e.stopPropagation()}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Store</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to delete {store.name}? This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => onDelete(store.id)}
                          className="bg-red-600 hover:bg-red-700">
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  }
                </div>}
              </div>
              
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{store.address}</p>
                  {store.phone &&
                  <p className="text-sm mt-1" style={{ color: 'var(--text-slate-500)' }}>
                      {formatPhoneNumber(store.phone)}
                    </p>
                  }
                  {store.latitude && store.longitude &&
                  <p className="text-xs mt-2 mb-2" style={{ color: 'var(--text-slate-500)' }}>
                      GPS: {store.latitude.toFixed(4)}, {store.longitude.toFixed(4)}
                    </p>
                  }
                </div>
                
                {/* Call and navigate buttons - always visible for limited view (drivers/dispatchers), mobile-only for admins */}
                {store.phone && store.latitude && store.longitude &&
                <div className={`flex gap-2 flex-shrink-0 ${isLimitedView ? '' : 'md:hidden'}`}>
                    <a
                    href={`tel:${store.phone.replace(/\D/g, '')}`}
                    onClick={(e) => e.stopPropagation()}
                    className="h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 transition-colors hover:opacity-80"
                    style={{ backgroundColor: '#d1fae5' }}>
                      <Phone className="w-5 h-5" style={{ color: '#059669' }} />
                    </a>
                    <a
                    href={`https://maps.google.com/?q=${store.latitude},${store.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 transition-colors hover:opacity-80"
                    style={{ backgroundColor: '#dbeafe' }}>
                      <MapPin className="w-5 h-5" style={{ color: '#2563eb' }} />
                    </a>
                  </div>
                }
              </div>
            </div>



            {/* Pays App Fees Checkbox - Admin only */}
            {!isLimitedView && currentUser && userHasRole(currentUser, 'admin') && (() => {
              const history = store.app_fee_history || [];
              const sortedHistory = [...history].sort((a, b) =>
              new Date(b.effective_date) - new Date(a.effective_date)
              );

              // Find current active period (most recent entry where pays_app_fees is true)
              const currentPeriod = sortedHistory.find((h) => h.pays_app_fees);
              const endPeriod = currentPeriod ? sortedHistory.find((h) =>
              !h.pays_app_fees && new Date(h.effective_date) > new Date(currentPeriod.effective_date)
              ) : null;

              const formatEffectiveDate = (dateStr) => {
                if (!dateStr) return 'Unknown';
                try {
                  return format(parseISO(dateStr), 'MMM d, yyyy');
                } catch {
                  return dateStr;
                }
              };

              const handleDateSelect = async (date, type) => {
                if (!date) return;
                const dateStr = format(date, 'yyyy-MM-dd');
                const existingHistory = store.app_fee_history || [];

                let updatedHistory = existingHistory;
                if (type === 'start' && currentPeriod) {
                  // Update the start date of current period
                  updatedHistory = existingHistory.map((h) =>
                  h === currentPeriod ? { ...h, effective_date: dateStr } : h
                  );
                } else if (type === 'end' && endPeriod) {
                  // Update the end date
                  updatedHistory = existingHistory.map((h) =>
                  h === endPeriod ? { ...h, effective_date: dateStr } : h
                  );
                }

                const updatedStore = await updateStoreLocal(store.id, { app_fee_history: updatedHistory });
                const { invalidate } = await import('@/components/utils/dataManager');
                invalidate('Store');
                setEditableStore(updatedStore);
                window.dispatchEvent(new CustomEvent('storeUpdated', { detail: { storeId: store.id, updatedStore } }));

                setShowDatePicker(false);
                setEditingDateType(null);
              };

              return (
                <div className="px-2 rounded-lg flex flex-wrap items-center gap-2 min-h-[46px]" style={{ background: 'var(--bg-amber-50, #fffbeb)', border: '1px solid var(--border-amber-200, #fde68a)' }}>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`pays-fees-${store.id}`}
                      checked={store.pays_app_fees || false}
                      onCheckedChange={async (checked) => {
                        try {
                          const today = new Date().toISOString().split('T')[0];
                          const historyEntry = {
                            effective_date: today,
                            pays_app_fees: checked,
                            changed_by: currentUser?.user_name || currentUser?.full_name || 'Unknown'
                          };
                          const existingHistory = store.app_fee_history || [];
                          const updatedData = {
                            pays_app_fees: checked,
                            app_fee_history: [...existingHistory, historyEntry]
                          };
                          const updatedStore = await updateStoreLocal(store.id, updatedData);
                          const { invalidate } = await import('@/components/utils/dataManager');
                          invalidate('Store');
                          setEditableStore(updatedStore);
                          window.dispatchEvent(new CustomEvent('storeUpdated', { detail: { storeId: store.id, updatedStore } }));
                        } catch (error) {
                          console.error("Error updating app fees status:", error);
                        }
                      }} />

                    <label
                      htmlFor={`pays-fees-${store.id}`} className="text-sm font-medium cursor-pointer flex items-center gap-1" style={{ color: 'var(--text-amber-800, #92400e)' }}>App Fees




                    </label>
                  </div>
                  
                  {/* Effective Date Range Display */}
                  {currentPeriod &&
                  <Popover open={showDatePicker} onOpenChange={setShowDatePicker}>
                      <PopoverTrigger asChild>
                        <button className="text-xs flex items-center gap-1 ml-4 underline decoration-dotted"

                      style={{ color: 'var(--text-amber-700, #b45309)' }}
                      onClick={(e) => e.stopPropagation()}>

                          <Calendar className="w-3 h-3" />
                          (Effective: {formatEffectiveDate(currentPeriod.effective_date)} → {endPeriod ? formatEffectiveDate(endPeriod.effective_date) : 'Present'})
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-3 z-[100]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }} onClick={(e) => e.stopPropagation()}>
                        <div className="space-y-3">
                          <div className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>Edit Date Range</div>
                          <div className="flex gap-2">
                            <Button
                            variant={editingDateType === 'start' ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setEditingDateType('start')}>

                              Start Date
                            </Button>
                            <Button
                            variant={editingDateType === 'end' ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setEditingDateType('end')}
                            disabled={!endPeriod && store.pays_app_fees}>

                              End Date
                            </Button>
                          </div>
                          {editingDateType &&
                        <CalendarComponent
                          mode="single"
                          selected={editingDateType === 'start' ?
                          parseISO(currentPeriod.effective_date) :
                          endPeriod ? parseISO(endPeriod.effective_date) : new Date()
                          }
                          onSelect={(date) => handleDateSelect(date, editingDateType)}
                          className="rounded-md border" />

                        }
                        </div>
                      </PopoverContent>
                    </Popover>
                  }
                </div>);

            })()}

            {/* Color Selector - Admin only */}
            {!isLimitedView && <div className="flex items-center gap-2 mb-1">
              {editingColor ?
              <div className="flex items-center gap-2">
                  <Input
                  type="color"
                  value={editableStore.color || currentStoreColor}
                  onChange={(e) => handleQuickEdit('color', e.target.value)}
                  className="w-8 h-8 p-0 border-0 rounded cursor-pointer" />

                  <Button
                  size="icon"
                  className="h-6 w-6 bg-emerald-600 hover:bg-emerald-700"
                  onClick={(e) => {e.stopPropagation();handleColorSave(editableStore.color || currentStoreColor);}}>

                    <Save className="w-3 h-3" />
                  </Button>
                  <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={(e) => {e.stopPropagation();handleCancelColorEdit();}}>

                    <X className="w-3 h-3" />
                  </Button>
                </div> :

              <button
                onClick={(e) => {e.stopPropagation();setEditingColor(true);}}
                className="flex items-center gap-2 text-sm"
                style={{ color: 'var(--text-slate-600)' }}>

                  <div
                  className="w-4 h-4 rounded-full"
                  style={{ backgroundColor: currentStoreColor, border: '1px solid var(--border-slate-300)' }}>
                  </div>
                  <Palette className="w-3 h-3" />
                  <span>Store Color</span>
                </button>
              }
              </div>}

              {/* Driver Assignments Section */}
              <div className="space-y-2 pt-2" style={{ background: 'var(--bg-slate-50)', borderTop: '1px solid var(--border-slate-200)' }}>
              <h4 className="font-semibold text-sm" style={{ color: 'var(--text-slate-800)' }}>Driver Assignments & Pickup Times</h4>

              {(() => {
                const getDriverName = (driverId, fallbackName) => {
                  let name = fallbackName || 'No driver';
                  if (driverId && drivers && drivers.length > 0) {
                    const driver = drivers.find((d) => d && (d.id === driverId || d.user_id === driverId));
                    if (driver) {
                      name = driver.user_name || driver.full_name || fallbackName || 'Unknown';
                    } else {
                      // If driver not found in list but driverId is set, still show fallbackName instead of "No driver"
                      if (fallbackName && fallbackName !== 'No driver') {
                        name = fallbackName;
                      }
                    }
                  } else if (fallbackName && fallbackName !== 'No driver') {
                    // If no drivers array but fallback name exists, use it
                    name = fallbackName;
                  }
                  // If format is "X Word" (single letter + space + word), return the second word
                  const parts = name.trim().split(' ');
                  if (parts.length >= 2 && parts[0].length === 1) {
                    return parts.slice(1).join(' ');
                  }
                  return name;
                };

                return (
                  <>
                    {/* AM ROW */}
                    <div className="bg-transparent space-y-1">
                      <h5 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-slate-600)' }}>
                        AM Drivers & Pickup Windows
                      </h5>
                      <div className="grid grid-cols-3 gap-4">
                        {/* Weekdays AM */}
                        <div
                          className={`p-2 rounded min-h-[76px] flex flex-col justify-between space-y-1 transition-all duration-200 ${!isLimitedView && canQuickEditSlot('weekday_am') ? 'cursor-pointer hover:ring-1 hover:ring-emerald-400' : 'cursor-default'}`}
                          style={{ background: 'var(--bg-slate-100)', ...getSlotBgStyle(store.weekday_am_enabled, store.weekday_am_driver_id || store.driver_weekday_am) }}
                          onClick={(e) => {if (isLimitedView) return;e.stopPropagation();openSlotEditor('weekday_am');}}>

                          <div className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>Weekdays</div>
                          {store.weekday_am_enabled !== false && (store.weekday_am_driver_id || store.weekday_am_driver) ?
                          <>
                              <div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                {getDriverName(store.weekday_am_driver_id, store.weekday_am_driver)}
                              </div>
                              {store.weekday_am_start && store.weekday_am_end &&
                            <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                                  {store.weekday_am_start} - {store.weekday_am_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs italic" style={{ color: 'var(--text-slate-400)' }}>
                              {store.weekday_am_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>

                        {/* Saturdays AM */}
                        <div
                          className={`p-2 rounded min-h-[76px] flex flex-col justify-between space-y-1 transition-all duration-200 ${!isLimitedView && canQuickEditSlot('saturday_am') ? 'cursor-pointer hover:ring-1 hover:ring-emerald-400' : 'cursor-default'}`}
                          style={{ background: 'var(--bg-slate-100)', ...getSlotBgStyle(store.saturday_am_enabled, store.saturday_am_driver_id || store.saturday_am_driver) }}
                          onClick={(e) => {if (isLimitedView) return;e.stopPropagation();openSlotEditor('saturday_am');}}>

                          <div className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>Saturdays</div>
                          {store.saturday_am_enabled !== false && (store.saturday_am_driver_id || store.saturday_am_driver) ?
                          <>
                              <div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                {getDriverName(store.saturday_am_driver_id, store.saturday_am_driver)}
                              </div>
                              {store.saturday_am_start && store.saturday_am_end &&
                            <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                                  {store.saturday_am_start} - {store.saturday_am_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs italic" style={{ color: 'var(--text-slate-400)' }}>
                              {store.saturday_am_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>

                        {/* Sundays AM */}
                        <div
                          className={`p-2 rounded min-h-[76px] flex flex-col justify-between space-y-1 transition-all duration-200 ${!isLimitedView && canQuickEditSlot('sunday_am') ? 'cursor-pointer hover:ring-1 hover:ring-emerald-400' : 'cursor-default'}`}
                          style={{ background: 'var(--bg-slate-100)', ...getSlotBgStyle(store.sunday_am_enabled, store.sunday_am_driver_id || store.driver_sunday_am) }}
                          onClick={(e) => {if (isLimitedView) return;e.stopPropagation();openSlotEditor('sunday_am');}}>

                          <div className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>Sundays</div>
                          {store.sunday_am_enabled !== false && (store.sunday_am_driver_id || store.sunday_am_driver) ?
                          <>
                              <div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                {getDriverName(store.sunday_am_driver_id, store.sunday_am_driver)}
                              </div>
                              {store.sunday_am_start && store.sunday_am_end &&
                            <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                                  {store.sunday_am_start} - {store.sunday_am_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs italic" style={{ color: 'var(--text-slate-400)' }}>
                              {store.sunday_am_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>
                      </div>
                    </div>

                    {/* PM ROW */}
                    <div>
                      <h5 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-slate-600)' }}>
                        PM Drivers & Pickup Windows
                      </h5>
                      <div className="grid grid-cols-3 gap-4">
                        {/* Weekdays PM */}
                        <div
                          className={`p-2 rounded min-h-[76px] flex flex-col justify-between space-y-1 transition-all duration-200 ${!isLimitedView && canQuickEditSlot('weekday_pm') ? 'cursor-pointer hover:ring-1 hover:ring-emerald-400' : 'cursor-default'}`}
                          style={{ background: 'var(--bg-slate-100)', ...getSlotBgStyle(store.weekday_pm_enabled, store.weekday_pm_driver_id || store.driver_weekday_pm) }}
                          onClick={(e) => {if (isLimitedView) return;e.stopPropagation();openSlotEditor('weekday_pm');}}>

                          <div className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>Weekdays</div>
                          {store.weekday_pm_enabled !== false && (store.weekday_pm_driver_id || store.weekday_pm_driver) ?
                          <>
                              <div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                {getDriverName(store.weekday_pm_driver_id, store.weekday_pm_driver)}
                              </div>
                              {store.weekday_pm_start && store.weekday_pm_end &&
                            <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                                  {store.weekday_pm_start} - {store.weekday_pm_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs italic" style={{ color: 'var(--text-slate-400)' }}>
                              {store.weekday_pm_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>

                        {/* Saturdays PM */}
                        <div
                          className={`p-2 rounded min-h-[76px] flex flex-col justify-between space-y-1 transition-all duration-200 ${!isLimitedView && canQuickEditSlot('saturday_pm') ? 'cursor-pointer hover:ring-1 hover:ring-emerald-400' : 'cursor-default'}`}
                          style={{ background: 'var(--bg-slate-100)', ...getSlotBgStyle(store.saturday_pm_enabled, store.saturday_pm_driver_id || store.saturday_pm_driver) }}
                          onClick={(e) => {if (isLimitedView) return;e.stopPropagation();openSlotEditor('saturday_pm');}}>

                          <div className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>Saturdays</div>
                          {store.saturday_pm_enabled !== false && (store.saturday_pm_driver_id || store.saturday_pm_driver) ?
                          <>
                              <div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                {getDriverName(store.saturday_pm_driver_id, store.saturday_pm_driver)}
                              </div>
                              {store.saturday_pm_start && store.saturday_pm_end &&
                            <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                                  {store.saturday_pm_start} - {store.saturday_pm_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs italic" style={{ color: 'var(--text-slate-400)' }}>
                              {store.saturday_pm_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>

                        {/* Sundays PM */}
                        <div
                          className={`p-2 rounded min-h-[76px] flex flex-col justify-between space-y-1 transition-all duration-200 ${!isLimitedView && canQuickEditSlot('sunday_pm') ? 'cursor-pointer hover:ring-1 hover:ring-emerald-400' : 'cursor-default'}`}
                          style={{ background: 'var(--bg-slate-100)', ...getSlotBgStyle(store.sunday_pm_enabled, store.sunday_pm_driver_id || store.driver_sunday_pm) }}
                          onClick={(e) => {if (isLimitedView) return;e.stopPropagation();openSlotEditor('sunday_pm');}}>

                          <div className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>Sundays</div>
                          {store.sunday_pm_enabled !== false && (store.sunday_pm_driver_id || store.sunday_pm_driver) ?
                          <>
                              <div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                {getDriverName(store.sunday_pm_driver_id, store.sunday_pm_driver)}
                              </div>
                              {store.sunday_pm_start && store.sunday_pm_end &&
                            <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                                  {store.sunday_pm_start} - {store.sunday_pm_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs italic" style={{ color: 'var(--text-slate-400)' }}>
                              {store.sunday_pm_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>
                      </div>
                    </div>
                  </>);

              })()}
            </div>
          </div>

          {/* Bottom Actions - Store ID, Dispatcher ID and Delete button - Admin only */}
          {!isLimitedView && <div className="space-y-0" style={{ borderTop: '1px solid var(--border-slate-100)' }}>
            {/* Store ID with Copy */}
            <div className="flex items-center">
              <span className="text-xs font-mono w-28 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }}>Store ID:</span>
              <span className="text-xs font-mono truncate flex-1 mr-2" style={{ color: 'var(--text-slate-500)' }} title={store.id}>
                {store.id}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0 ml-auto"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyId();
                }}
                title="Copy full Store ID">

                {copiedId ?
                <Check className="w-3 h-3 text-emerald-600" /> :

                <Copy className="w-3 h-3" style={{ color: 'var(--text-slate-400)' }} />
                }
              </Button>
            </div>

            {/* Dispatcher ID with Copy */}
            {store.dispatcher_id &&
            <div className="flex items-center">
              <span className="text-xs font-mono w-28 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }}>Dispatcher ID:</span>
              <span className="text-xs font-mono truncate flex-1 mr-2" style={{ color: 'var(--text-slate-500)' }} title={store.dispatcher_id}>
                {store.dispatcher_id}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyDispatcherId();
                }}
                title="Copy Dispatcher ID">

                {copiedDispatcherId ?
                <Check className="w-3 h-3 text-emerald-600" /> :

                <Copy className="w-3 h-3" style={{ color: 'var(--text-slate-400)' }} />
                }
              </Button>
            </div>
            }
            </div>}
            </CardContent>
            </Card>
      <Dialog open={!!editingSlot} onOpenChange={(open) => !open && setEditingSlot(null)}>
        <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }} onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Change Driver</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                {editingSlot ? slotConfig[editingSlot]?.label : ''}
              </div>
              <Select value={editingSlotDriverId} onValueChange={setEditingSlotDriverId}>
                <SelectTrigger style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="Select driver" />
                </SelectTrigger>
                <SelectContent className="z-[10002]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <SelectItem value="null">No Driver</SelectItem>
                  {(drivers || []).map((driver) =>
                  <SelectItem key={driver.id} value={driver.id} style={{ color: 'var(--text-slate-900)' }}>
                      {driver.user_name || driver.full_name}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditingSlot(null)} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSlotDriverSave} className="bg-emerald-600 hover:bg-emerald-700">
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>);

}