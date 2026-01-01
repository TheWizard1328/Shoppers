import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Edit, Trash2, Palette, Save, X, Copy, Check, DollarSign, Calendar } from "lucide-react";
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

export default function StoreCard({ store, onEdit, onDelete, onSave, currentUser, drivers, onSelect, isSelected }) {
  const [editingColor, setEditingColor] = useState(false);
  const [editableStore, setEditableStore] = useState({ ...store });
  const [copiedId, setCopiedId] = useState(false);
  const [copiedDispatcherId, setCopiedDispatcherId] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [editingDateType, setEditingDateType] = useState(null); // 'start' or 'end'

  // Generate color locally if missing (don't auto-save to avoid infinite loops)
  const displayColor = store.color || getStoreColor(store);

  useEffect(() => {
    setEditableStore({ ...store });
  }, [store]);

  const handleColorSave = async (newColor) => {
    try {
      // Only update the color field, don't pass the entire store object
      await onSave({ ...store, color: newColor });
      setEditableStore({ ...store, color: newColor });
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
        className={`overflow-hidden border-slate-200 hover:border-emerald-400 transition-all duration-200 bg-white hover:shadow-lg cursor-pointer h-full ${isSelected ? 'ring-2 ring-emerald-500 border-emerald-500' : ''}`}
        onClick={() => onSelect?.(store)}>

        <CardContent className="p-4 flex flex-col justify-between h-full">
          <div>
            {/* Header with Store Name, Address, Phone, and Edit Button */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-slate-900 text-base truncate">
                    {store.name}
                  </h3>
                  {store.abbreviation &&
                  <Badge className="bg-primary text-primary-foreground px-2.5 py-0.5 text-xs font-semibold rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent shadow hover:bg-primary/80"

                  style={{ backgroundColor: currentStoreColor, color: 'white' }}>

                      {store.abbreviation}
                    </Badge>
                  }
                </div>
                <p className="text-sm text-slate-600">{store.address}</p>
                {store.phone &&
                <p className="text-sm text-slate-500 mt-1">
                    {formatPhoneNumber(store.phone)}
                  </p>
                }
                </div>
                <div className="flex flex-col gap-1 items-center">
                <Button variant="ghost" size="sm" onClick={(e) => {e.stopPropagation();onEdit(store);}} className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:bg-accent h-8 rounded-md px-3 text-xs text-red-600 hover:text-accent-foreground flex-shrink-0">
                  <Edit className="w-4 h-4" />
                </Button>
                {currentUser && userHasRole(currentUser, 'admin') &&
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
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
                </div>
            </div>

            {/* Coordinates display */}
            {store.latitude && store.longitude &&
            <div className="text-xs text-slate-500 mb-4">
                GPS Location: {store.latitude.toFixed(4)}, {store.longitude.toFixed(4)}
              </div>
            }

            {/* Pays App Fees Checkbox */}
            {currentUser && userHasRole(currentUser, 'admin') && (() => {
              const history = store.app_fee_history || [];
              const sortedHistory = [...history].sort((a, b) => 
                new Date(b.effective_date) - new Date(a.effective_date)
              );
              
              // Find current active period (most recent entry where pays_app_fees is true)
              const currentPeriod = sortedHistory.find(h => h.pays_app_fees);
              const endPeriod = currentPeriod ? sortedHistory.find(h => 
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
                  updatedHistory = existingHistory.map(h => 
                    h === currentPeriod ? { ...h, effective_date: dateStr } : h
                  );
                } else if (type === 'end' && endPeriod) {
                  // Update the end date
                  updatedHistory = existingHistory.map(h => 
                    h === endPeriod ? { ...h, effective_date: dateStr } : h
                  );
                }
                
                // Use Store entity directly to update
                const { Store } = await import('@/entities/Store');
                await Store.update(store.id, { app_fee_history: updatedHistory });
                if (onSave) {
                  await onSave({ ...store, app_fee_history: updatedHistory });
                }
                
                setShowDatePicker(false);
                setEditingDateType(null);
              };

              return (
                <div className="flex flex-col gap-1 mb-4 p-2 bg-amber-50 rounded-lg border border-amber-200">
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
                          // Use Store entity directly to update
                          const { Store } = await import('@/entities/Store');
                          await Store.update(store.id, {
                            pays_app_fees: checked,
                            app_fee_history: [...existingHistory, historyEntry]
                          });
                          // Trigger refresh via onSave callback
                          if (onSave) {
                            await onSave({
                              ...store,
                              pays_app_fees: checked,
                              app_fee_history: [...existingHistory, historyEntry]
                            });
                          }
                        } catch (error) {
                          console.error("Error updating app fees status:", error);
                        }
                      }}
                    />
                    <label
                      htmlFor={`pays-fees-${store.id}`}
                      className="text-sm font-medium text-amber-800 cursor-pointer flex items-center gap-1"
                    >
                      <DollarSign className="w-3.5 h-3.5" />
                      Pays App Fees
                    </label>
                  </div>
                  
                  {/* Effective Date Range Display */}
                  {currentPeriod && (
                    <Popover open={showDatePicker} onOpenChange={setShowDatePicker}>
                      <PopoverTrigger asChild>
                        <button
                          className="text-xs text-amber-700 hover:text-amber-900 flex items-center gap-1 ml-6 underline decoration-dotted"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Calendar className="w-3 h-3" />
                          (Effective: {formatEffectiveDate(currentPeriod.effective_date)} → {endPeriod ? formatEffectiveDate(endPeriod.effective_date) : 'Present'})
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-3 z-[100]" onClick={(e) => e.stopPropagation()}>
                        <div className="space-y-3">
                          <div className="text-sm font-medium text-slate-700">Edit Date Range</div>
                          <div className="flex gap-2">
                            <Button
                              variant={editingDateType === 'start' ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => setEditingDateType('start')}
                            >
                              Start Date
                            </Button>
                            <Button
                              variant={editingDateType === 'end' ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => setEditingDateType('end')}
                              disabled={!endPeriod && store.pays_app_fees}
                            >
                              End Date
                            </Button>
                          </div>
                          {editingDateType && (
                            <CalendarComponent
                              mode="single"
                              selected={editingDateType === 'start' 
                                ? parseISO(currentPeriod.effective_date) 
                                : endPeriod ? parseISO(endPeriod.effective_date) : new Date()
                              }
                              onSelect={(date) => handleDateSelect(date, editingDateType)}
                              className="rounded-md border"
                            />
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              );
            })()}

            {/* Color Selector */}
            <div className="flex items-center gap-2 mb-4">
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
                className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800">

                  <div
                  className="w-4 h-4 rounded-full border border-slate-300"
                  style={{ backgroundColor: currentStoreColor }}>
                  </div>
                  <Palette className="w-3 h-3" />
                  <span>Store Color</span>
                </button>
              }
            </div>

            {/* Full Schedule Drivers - FIXED TO RESPECT ENABLED FLAGS */}
            <div className="bg-slate-50 pt-4 space-y-4 border-t border-slate-200">
              <h4 className="font-semibold text-slate-800 text-sm">Driver Assignments & Pickup Times</h4>

              {(() => {
                const getDriverName = (driverId, fallbackName) => {
                  if (driverId && drivers && drivers.length > 0) {
                    const driver = drivers.find((d) => d && d.id === driverId);
                    if (driver) {
                      return driver.user_name || driver.full_name || fallbackName || 'Unknown';
                    }
                  }
                  return fallbackName || 'No driver';
                };

                return (
                  <>
                    {/* AM ROW */}
                    <div className="bg-transparent space-y-1">
                      <h5 className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">
                        AM Drivers & Pickup Windows
                      </h5>
                      <div className="grid grid-cols-3 gap-4">
                        {/* Weekdays AM */}
                        <div
                          className="bg-slate-100 p-2 rounded space-y-1 transition-all duration-200"
                          style={getSlotBgStyle(store.weekday_am_enabled, store.weekday_am_driver_id || store.driver_weekday_am)}>

                          <div className="text-xs font-medium text-slate-700">Weekdays</div>
                          {store.weekday_am_enabled !== false && (store.weekday_am_driver_id || store.driver_weekday_am) ?
                          <>
                              <div className="text-sm font-medium text-slate-900">
                                {getDriverName(store.weekday_am_driver_id, store.driver_weekday_am).split(' ')[0]}
                              </div>
                              {store.weekday_am_start && store.weekday_am_end &&
                            <div className="text-xs text-slate-500">
                                  {store.weekday_am_start} - {store.weekday_am_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs text-slate-400 italic">
                              {store.weekday_am_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>

                        {/* Saturdays AM */}
                        <div
                          className="bg-slate-100 p-2 rounded space-y-1 transition-all duration-200"
                          style={getSlotBgStyle(store.saturday_am_enabled, store.saturday_am_driver_id || store.saturday_am_driver)}>

                          <div className="text-xs font-medium text-slate-700">Saturdays</div>
                          {store.saturday_am_enabled !== false && (store.saturday_am_driver_id || store.saturday_am_driver) ?
                          <>
                              <div className="text-sm font-medium text-slate-900">
                                {getDriverName(store.saturday_am_driver_id, store.saturday_am_driver).split(' ')[0]}
                              </div>
                              {store.saturday_am_start && store.saturday_am_end &&
                            <div className="text-xs text-slate-500">
                                  {store.saturday_am_start} - {store.saturday_am_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs text-slate-400 italic">
                              {store.saturday_am_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>

                        {/* Sundays AM */}
                        <div
                          className="bg-slate-100 p-2 rounded space-y-1 transition-all duration-200"
                          style={getSlotBgStyle(store.sunday_am_enabled, store.sunday_am_driver_id || store.driver_sunday_am)}>

                          <div className="text-xs font-medium text-slate-700">Sundays</div>
                          {store.sunday_am_enabled !== false && (store.sunday_am_driver_id || store.driver_sunday_am) ?
                          <>
                              <div className="text-sm font-medium text-slate-900">
                                {getDriverName(store.sunday_am_driver_id, store.driver_sunday_am).split(' ')[0]}
                              </div>
                              {store.sunday_am_start && store.sunday_am_end &&
                            <div className="text-xs text-slate-500">
                                  {store.sunday_am_start} - {store.sunday_am_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs text-slate-400 italic">
                              {store.sunday_am_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>
                      </div>
                    </div>

                    {/* PM ROW */}
                    <div>
                      <h5 className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">
                        PM Drivers & Pickup Windows
                      </h5>
                      <div className="grid grid-cols-3 gap-4">
                        {/* Weekdays PM */}
                        <div
                          className="bg-slate-100 p-2 rounded space-y-1 transition-all duration-200"
                          style={getSlotBgStyle(store.weekday_pm_enabled, store.weekday_pm_driver_id || store.driver_weekday_pm)}>

                          <div className="text-xs font-medium text-slate-700">Weekdays</div>
                          {store.weekday_pm_enabled !== false && (store.weekday_pm_driver_id || store.driver_weekday_pm) ?
                          <>
                              <div className="text-sm font-medium text-slate-900">
                                {getDriverName(store.weekday_pm_driver_id, store.driver_weekday_pm).split(' ')[0]}
                              </div>
                              {store.weekday_pm_start && store.weekday_pm_end &&
                            <div className="text-xs text-slate-500">
                                  {store.weekday_pm_start} - {store.weekday_pm_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs text-slate-400 italic">
                              {store.weekday_pm_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>

                        {/* Saturdays PM */}
                        <div
                          className="bg-slate-100 p-2 rounded space-y-1 transition-all duration-200"
                          style={getSlotBgStyle(store.saturday_pm_enabled, store.saturday_pm_driver_id || store.saturday_pm_driver)}>

                          <div className="text-xs font-medium text-slate-700">Saturdays</div>
                          {store.saturday_pm_enabled !== false && (store.saturday_pm_driver_id || store.saturday_pm_driver) ?
                          <>
                              <div className="text-sm font-medium text-slate-900">
                                {getDriverName(store.saturday_pm_driver_id, store.saturday_pm_driver).split(' ')[0]}
                              </div>
                              {store.saturday_pm_start && store.saturday_pm_end &&
                            <div className="text-xs text-slate-500">
                                  {store.saturday_pm_start} - {store.saturday_pm_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs text-slate-400 italic">
                              {store.saturday_pm_enabled === false ? 'Disabled' : 'No driver'}
                            </div>
                          }
                        </div>

                        {/* Sundays PM */}
                        <div
                          className="bg-slate-100 p-2 rounded space-y-1 transition-all duration-200"
                          style={getSlotBgStyle(store.sunday_pm_enabled, store.sunday_pm_driver_id || store.driver_sunday_pm)}>

                          <div className="text-xs font-medium text-slate-700">Sundays</div>
                          {store.sunday_pm_enabled !== false && (store.sunday_pm_driver_id || store.driver_sunday_pm) ?
                          <>
                              <div className="text-sm font-medium text-slate-900">
                                {getDriverName(store.sunday_pm_driver_id, store.driver_sunday_pm).split(' ')[0]}
                              </div>
                              {store.sunday_pm_start && store.sunday_pm_end &&
                            <div className="text-xs text-slate-500">
                                  {store.sunday_pm_start} - {store.sunday_pm_end}
                                </div>
                            }
                            </> :

                          <div className="text-xs text-slate-400 italic">
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

          {/* Bottom Actions - Store ID, Dispatcher ID and Delete button */}
          <div className="pt-1 border-t border-slate-100 space-y-1">
            {/* Store ID with Copy */}
            <div className="flex items-center">
              <span className="text-xs text-slate-500 font-mono w-28 flex-shrink-0">Store ID:</span>
              <span className="text-xs text-slate-500 font-mono truncate flex-1 mr-2" title={store.id}>
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

                <Copy className="w-3 h-3 text-slate-400" />
                }
              </Button>
            </div>

            {/* Dispatcher ID with Copy */}
            {store.dispatcher_id &&
            <div className="flex items-center">
              <span className="text-xs text-slate-500 font-mono w-28 flex-shrink-0">Dispatcher ID:</span>
              <span className="text-xs text-slate-500 font-mono truncate flex-1 mr-2" title={store.dispatcher_id}>
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

                <Copy className="w-3 h-3 text-slate-400" />
                }
              </Button>
            </div>
            }
          </div>
        </CardContent>
      </Card>
    </motion.div>);

}