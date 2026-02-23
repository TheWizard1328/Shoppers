import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { Building, MapPin, X, CreditCard, Plus, Trash2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { sortUsers } from '../utils/sorting';
import { PhoneInput } from "@/components/ui/phone-input";
import { motion } from 'framer-motion';
import { useAppData } from '../utils/AppDataContext';
import { base44 } from '@/api/base44Client';

export default function StoreForm({ store, cities = [], drivers = [], allUsers = [], onSave, onCancel }) {
  // Safely get context - may not be available if rendered outside AppDataProvider
  const appDataContext = useAppData();
  const setIsFormOverlayOpen = appDataContext?.setIsFormOverlayOpen;
  
  const [squareLocationConfigs, setSquareLocationConfigs] = useState([]);
  
  useEffect(() => {
    const loadSquareConfigs = async () => {
      try {
        const configs = await base44.entities.SquareLocationConfig.filter({ status: 'active' });
        setSquareLocationConfigs(configs || []);
      } catch (error) {
        console.error('Failed to load Square location configs:', error);
      }
    };
    loadSquareConfigs();
  }, []);
  
  // Helper to find driver ID based on name, for backward compatibility during initialization
  const findDriverIdFromName = (driverName, allDrivers) => {
    if (!driverName || !allDrivers || allDrivers.length === 0) return null;

    // Try to match by full name first
    let matchedDriver = allDrivers.find((d) => d && (d.user_name === driverName || d.full_name === driverName));
    if (matchedDriver) return matchedDriver.id;

    // If not found, try by first name
    const firstName = driverName.split(' ')[0].toLowerCase().trim();
    matchedDriver = allDrivers.find((d) => {
      if (!d || (!d.user_name && !d.full_name)) return false;
      const driverFirstName = (d.user_name || d.full_name).split(' ')[0].toLowerCase().trim();
      return driverFirstName === firstName;
    });
    return matchedDriver ? matchedDriver.id : null;
  };

  // Helper to find dispatcher by checking both User ID and AppUser ID
  const findDispatcherFromStore = (dispatcherId, users) => {
    if (!dispatcherId || !users || users.length === 0) return null;

    // First try to match by User ID (correct way)
    let dispatcher = users.find((u) => u && u.id === dispatcherId);

    // If not found, try to match by AppUser record ID (legacy/incorrect way)
    if (!dispatcher) {
      const appUser = users.find((u) => u && u._appUserId === dispatcherId);
      if (appUser) {
        console.warn('[StoreForm] Found dispatcher by AppUser ID (legacy). Store data needs migration.');
        dispatcher = appUser;
      }
    }

    return dispatcher;
  };

  // Helper to find dispatcher ID based on name, for backward compatibility
  const findDispatcherIdFromName = (dispatcherName, users) => {
    if (!dispatcherName || !users || users.length === 0) return null;
    let matchedUser = users.find((u) => u && (u.user_name === dispatcherName || u.full_name === dispatcherName));
    return matchedUser ? matchedUser.id : null;
  };

  const [formData, setFormData] = useState(() => {
    const defaultData = {
      id: '',
      name: "",
      abbreviation: "",
      address: "",
      phone: "",
      latitude: null,
      longitude: null,
      city_id: "",
      sort_order: null,
      color: "", // This field was removed from the outline, but keeping it in defaultData and `store` merge for robustness.
      dispatcher_name: "",
      dispatcher_id: null,
      square_location_config_id: null,
      patient_scan_day: null,
      status: "active",
      pays_app_fees: false,
      app_fee_history: [],
      // Weekday fields
      weekday_am_start: "09:00",
      weekday_am_end: "12:00",
      weekday_am_enabled: true,
      weekday_am_driver: "", // Legacy name field
      weekday_am_driver_id: null,
      weekday_pm_start: "13:00",
      weekday_pm_end: "17:00",
      weekday_pm_enabled: true,
      weekday_pm_driver: "", // Legacy name field
      weekday_pm_driver_id: null,
      // Saturday fields
      saturday_am_start: "09:00",
      saturday_am_end: "12:00",
      saturday_am_enabled: true,
      saturday_am_driver: "", // Legacy name field
      saturday_am_driver_id: null,
      saturday_pm_start: "13:00",
      saturday_pm_end: "17:00",
      saturday_pm_enabled: true,
      saturday_pm_driver: "", // Legacy name field
      saturday_pm_driver_id: null,
      // Sunday fields
      sunday_am_start: "09:00",
      sunday_am_end: "12:00",
      sunday_am_enabled: true,
      sunday_am_driver: "", // Legacy name field
      sunday_am_driver_id: null,
      sunday_pm_start: "13:00",
      sunday_pm_end: "17:00",
      sunday_pm_enabled: true,
      sunday_pm_driver: "", // Legacy name field
      sunday_pm_driver_id: null
    };

    if (store) {
      const initialData = { ...defaultData, ...store };

      // Ensure sort_order, latitude, longitude are null if not provided
      initialData.sort_order = store.sort_order ?? null;
      initialData.latitude = store.latitude ?? null;
      initialData.longitude = store.longitude ?? null;

      // Handle dispatcher ID resolution
      if (initialData.dispatcher_id) {
        const foundDispatcher = findDispatcherFromStore(initialData.dispatcher_id, allUsers);
        if (foundDispatcher) {
          initialData.dispatcher_id = foundDispatcher.id;
          initialData.dispatcher_name = foundDispatcher.user_name || foundDispatcher.full_name;
        } else if (initialData.dispatcher_name) {
          initialData.dispatcher_id = findDispatcherIdFromName(initialData.dispatcher_name, allUsers);
          if (!initialData.dispatcher_id) initialData.dispatcher_id = null;
        } else {
          initialData.dispatcher_id = null;
          initialData.dispatcher_name = "";
        }
      } else if (initialData.dispatcher_name) {
        initialData.dispatcher_id = findDispatcherIdFromName(initialData.dispatcher_name, allUsers);
      }

      // CRITICAL FIX: Load driver IDs from correct schema field names
      initialData.weekday_am_driver_id = store.weekday_am_driver_id ?? null;
      initialData.weekday_pm_driver_id = store.weekday_pm_driver_id ?? null;
      initialData.saturday_am_driver_id = store.saturday_am_driver_id ?? null;
      initialData.saturday_pm_driver_id = store.saturday_pm_driver_id ?? null;
      initialData.sunday_am_driver_id = store.sunday_am_driver_id ?? null;
      initialData.sunday_pm_driver_id = store.sunday_pm_driver_id ?? null;

      // Enabled flags should default to true if not explicitly set in store
      initialData.weekday_am_enabled = store.weekday_am_enabled ?? true;
      initialData.weekday_pm_enabled = store.weekday_pm_enabled ?? true;
      initialData.saturday_am_enabled = store.saturday_am_enabled ?? true;
      initialData.saturday_pm_enabled = store.saturday_pm_enabled ?? true;
      initialData.sunday_am_enabled = store.sunday_am_enabled ?? true;
      initialData.sunday_pm_enabled = store.sunday_pm_enabled ?? true;

      // Backward compatibility: if _id is still null but name exists, try to find ID
      const timeSlotMappings = [
        { slot: 'weekday_am', idField: 'weekday_am_driver_id', nameField: 'weekday_am_driver' },
        { slot: 'weekday_pm', idField: 'weekday_pm_driver_id', nameField: 'weekday_pm_driver' },
        { slot: 'saturday_am', idField: 'saturday_am_driver_id', nameField: 'saturday_am_driver' },
        { slot: 'saturday_pm', idField: 'saturday_pm_driver_id', nameField: 'saturday_pm_driver' },
        { slot: 'sunday_am', idField: 'sunday_am_driver_id', nameField: 'sunday_am_driver' },
        { slot: 'sunday_pm', idField: 'sunday_pm_driver_id', nameField: 'sunday_pm_driver' }
      ];

      timeSlotMappings.forEach(({ idField, nameField }) => {
        if (!initialData[idField] && initialData[nameField]) {
          initialData[idField] = findDriverIdFromName(initialData[nameField], drivers);
        }
        if (initialData[idField] === '') {
          initialData[idField] = null;
        }
      });

      return initialData;
    }
    return defaultData;
  });

  // Sort drivers, users and cities for display
  const sortedDrivers = sortUsers(drivers);
  const sortedUsers = sortUsers(allUsers);
  const sortedCities = [...cities].sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    if (setIsFormOverlayOpen) {
      setIsFormOverlayOpen(true);
      return () => {
        setIsFormOverlayOpen(false);
      };
    }
  }, [setIsFormOverlayOpen]);


  const handleSelectChange = (name, value) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  // Enhanced handleDriverSelect with correct field mapping
  const handleDriverSelect = (driverId, timeSlot) => {
    const selectedDriver = sortedDrivers.find((d) => d && d.id === driverId);

    console.log('[StoreForm] Driver selected:', {
      timeSlot,
      driverId,
      driverName: selectedDriver?.user_name || selectedDriver?.full_name
    });

    // Map time slots to correct schema field names
    const fieldMappings = {
      'weekday_am': { idField: 'weekday_am_driver_id', nameField: 'weekday_am_driver' },
      'weekday_pm': { idField: 'weekday_pm_driver_id', nameField: 'weekday_pm_driver' },
      'saturday_am': { idField: 'saturday_am_driver_id', nameField: 'saturday_am_driver' },
      'saturday_pm': { idField: 'saturday_pm_driver_id', nameField: 'saturday_pm_driver' },
      'sunday_am': { idField: 'sunday_am_driver_id', nameField: 'sunday_am_driver' },
      'sunday_pm': { idField: 'sunday_pm_driver_id', nameField: 'sunday_pm_driver' }
    };

    const mapping = fieldMappings[timeSlot];
    if (!mapping) {
      console.error('[StoreForm] Unknown time slot:', timeSlot);
      return;
    }

    setFormData((prev) => {
      const updated = {
        ...prev,
        [mapping.idField]: driverId === "null" ? null : driverId,
        [mapping.nameField]: selectedDriver ? selectedDriver.user_name || selectedDriver.full_name : ""
      };

      console.log('[StoreForm] Updated formData:', {
        [mapping.idField]: updated[mapping.idField],
        [mapping.nameField]: updated[mapping.nameField]
      });

      return updated;
    });
  };

  const handleDispatcherSelect = (dispatcherId) => {
    const selectedDispatcher = sortedUsers.find((u) => u && u.id === dispatcherId);

    console.log('[StoreForm] Dispatcher selected:', {
      userId: selectedDispatcher?.id,
      userName: selectedDispatcher?.user_name || selectedDispatcher?.full_name,
      dispatcherId: dispatcherId
    });

    setFormData((prev) => ({
      ...prev,
      dispatcher_id: dispatcherId === "null" ? null : dispatcherId,
      dispatcher_name: selectedDispatcher ? selectedDispatcher.user_name || selectedDispatcher.full_name : ""
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    // Prepare data for saving
    const dataToSave = {
      ...formData,
      sort_order: formData.sort_order !== null && formData.sort_order !== '' ? parseInt(formData.sort_order, 10) : null,
      latitude: formData.latitude !== null && formData.latitude !== '' ? parseFloat(formData.latitude) : null,
      longitude: formData.longitude !== null && formData.longitude !== '' ? parseFloat(formData.longitude) : null
    };

    // Clear driver/time data when toggle is off
    const timeSlots = [
      { enabled: 'weekday_am_enabled', driverId: 'weekday_am_driver_id', driverName: 'weekday_am_driver', start: 'weekday_am_start', end: 'weekday_am_end' },
      { enabled: 'weekday_pm_enabled', driverId: 'weekday_pm_driver_id', driverName: 'weekday_pm_driver', start: 'weekday_pm_start', end: 'weekday_pm_end' },
      { enabled: 'saturday_am_enabled', driverId: 'saturday_am_driver_id', driverName: 'saturday_am_driver', start: 'saturday_am_start', end: 'saturday_am_end' },
      { enabled: 'saturday_pm_enabled', driverId: 'saturday_pm_driver_id', driverName: 'saturday_pm_driver', start: 'saturday_pm_start', end: 'saturday_pm_end' },
      { enabled: 'sunday_am_enabled', driverId: 'sunday_am_driver_id', driverName: 'sunday_am_driver', start: 'sunday_am_start', end: 'sunday_am_end' },
      { enabled: 'sunday_pm_enabled', driverId: 'sunday_pm_driver_id', driverName: 'sunday_pm_driver', start: 'sunday_pm_start', end: 'sunday_pm_end' }
    ];


    timeSlots.forEach((slot) => {
      // Check if enabled is explicitly false or undefined (which means it's off or not set to true)
      // The defaultData initializes enabled flags to true, so if it's explicitly set to false by user, we clear.
      if (dataToSave[slot.enabled] === false) {
        // If toggle is off, clear the driver and times
        dataToSave[slot.driverId] = null;
        dataToSave[slot.driverName] = ''; // Or can set to null based on backend schema
        dataToSave[slot.start] = '';
        dataToSave[slot.end] = '';
      }
    });

    console.log('🏪 [StoreForm] Submitting form data:', dataToSave);
    onSave(dataToSave);
  };

  return (
    <div className="space-y-6">
            <form onSubmit={handleSubmit} className="space-y-8">
                {/* Basic Information Section */}
                <div className="space-y-4">
                    <h3 className="text-lg font-semibold pb-2" style={{ color: 'var(--text-slate-900)', borderBottom: '1px solid var(--border-slate-200)' }}>Basic Information</h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <Label htmlFor="name" style={{ color: 'var(--text-slate-900)' }}>Store Name *</Label>
                            <Input
                id="name"
                name="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }} />

                        </div>

                        <div>
                            <Label htmlFor="abbreviation" style={{ color: 'var(--text-slate-900)' }}>Abbreviation (2 chars) *</Label>
                            <Input
                id="abbreviation"
                name="abbreviation"
                value={formData.abbreviation || ''}
                onChange={(e) => setFormData({ ...formData, abbreviation: e.target.value.substring(0, 2).toUpperCase() })}
                maxLength={2}
                required
                style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }} />

                        </div>

                        <div>
                            <Label htmlFor="status" style={{ color: 'var(--text-slate-900)' }}>Store Status</Label>
                            <div className="flex items-center gap-3 h-10 mt-1">
                                <Switch
                                    id="status"
                                    checked={formData.status !== 'inactive'}
                                    onCheckedChange={(checked) => setFormData({ ...formData, status: checked ? 'active' : 'inactive' })}
                                />
                                <Label htmlFor="status" className={`font-medium ${formData.status === 'inactive' ? 'text-red-600' : 'text-green-600'}`}>
                                    {formData.status === 'inactive' ? 'Inactive' : 'Active'}
                                </Label>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                            <Label htmlFor="address" style={{ color: 'var(--text-slate-900)' }}>Address *</Label>
                            <Input
              id="address"
              name="address"
              value={formData.address}
              onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              required
              style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }} />

                        </div>
                        
                        <div>
                            <Label htmlFor="phone" style={{ color: 'var(--text-slate-900)' }}>Phone Number *</Label>
                            <PhoneInput
                id="phone"
                value={formData.phone}
                onChange={(value) => setFormData({ ...formData, phone: value })}
                required
                className="text-sm" />

                        </div>

                        <div>
                            <Label htmlFor="city_id" style={{ color: 'var(--text-slate-900)' }}>City *</Label>
                            <Select
                value={formData.city_id || ''}
                onValueChange={(value) => setFormData({ ...formData, city_id: value })}
                required>

                                <SelectTrigger style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                                    <SelectValue placeholder="Select city..." />
                                </SelectTrigger>
                                <SelectContent className="z-[10001]" position="popper" sideOffset={4} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                                    {sortedCities.map((city) =>
                  <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>
                                            {city.name}
                                        </SelectItem>
                  )}
                                </SelectContent>
                            </Select>
                        </div>

                        <div>
                            <Label htmlFor="sort_order" style={{ color: 'var(--text-slate-900)' }}>Sort Order</Label>
                            <Input
                id="sort_order"
                name="sort_order"
                type="number"
                value={formData.sort_order ?? ''}
                onChange={(e) => setFormData({ ...formData, sort_order: e.target.value })}
                placeholder="Optional"
                style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }} />

                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                            <Label htmlFor="latitude" style={{ color: 'var(--text-slate-900)' }}>Latitude</Label>
                            <Input
                id="latitude"
                name="latitude"
                type="number"
                step="any"
                value={formData.latitude ?? ''}
                onChange={(e) => setFormData({ ...formData, latitude: e.target.value })}
                placeholder="e.g., 49.2827"
                style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }} />

                        </div>

                        <div>
                            <Label htmlFor="longitude" style={{ color: 'var(--text-slate-900)' }}>Longitude</Label>
                            <Input
                id="longitude"
                name="longitude"
                type="number"
                step="any"
                value={formData.longitude ?? ''}
                onChange={(e) => setFormData({ ...formData, longitude: e.target.value })}
                placeholder="e.g., -123.1207"
                style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }} />

                        </div>

                        <div>
                            <Label htmlFor="dispatcher_id" style={{ color: 'var(--text-slate-900)' }}>Assigned Dispatcher</Label>
                            <Select
                              value={formData.dispatcher_id || 'null'}
                              onValueChange={handleDispatcherSelect}>
                                <SelectTrigger style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                                    <SelectValue placeholder="Select dispatcher...">
                                        {formData.dispatcher_id ?
                                          sortedUsers.find((u) => u.id === formData.dispatcher_id)?.user_name || sortedUsers.find((u) => u.id === formData.dispatcher_id)?.full_name :
                                          "Select dispatcher..."}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent className="z-[10001]" position="popper" sideOffset={4} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                                    <SelectItem value="null" style={{ color: 'var(--text-slate-900)' }}>No Dispatcher</SelectItem>
                                    {sortedUsers
                                        .filter((u) => u && u.app_roles && u.app_roles.includes('dispatcher'))
                                        .map((dispatcher) =>
                                            <SelectItem key={dispatcher.id} value={dispatcher.id} style={{ color: 'var(--text-slate-900)' }}>
                                                {dispatcher.user_name || dispatcher.full_name}
                                            </SelectItem>
                                        )}
                                </SelectContent>
                            </Select>
                        </div>

                        <div>
                            <Label htmlFor="patient_scan_day" style={{ color: 'var(--text-slate-900)' }}>Patient Scan Day</Label>
                            <Select
                              value={formData.patient_scan_day !== null && formData.patient_scan_day !== undefined ? String(formData.patient_scan_day) : 'null'}
                              onValueChange={(value) => setFormData({ ...formData, patient_scan_day: value === 'null' ? null : parseInt(value) })}>
                              <SelectTrigger style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                                <SelectValue placeholder="No scan day" />
                              </SelectTrigger>
                              <SelectContent className="z-[10001]" position="popper" sideOffset={4} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                                <SelectItem value="null" style={{ color: 'var(--text-slate-900)' }}>No Scheduled Scan</SelectItem>
                                <SelectItem value="0">Sunday</SelectItem>
                                <SelectItem value="1">Monday</SelectItem>
                                <SelectItem value="2">Tuesday</SelectItem>
                                <SelectItem value="3">Wednesday</SelectItem>
                                <SelectItem value="4">Thursday</SelectItem>
                                <SelectItem value="5">Friday</SelectItem>
                                <SelectItem value="6">Saturday</SelectItem>
                              </SelectContent>
                            </Select>
                        </div>

                        <div>
                          <Label htmlFor="square_location_config_id" style={{ color: 'var(--text-slate-900)' }}>
                            <span className="flex items-center gap-2">
                              <CreditCard className="w-4 h-4" />
                              Square Location
                            </span>
                          </Label>
                          <Select
                            value={formData.square_location_config_id || 'null'}
                            onValueChange={(value) => setFormData({ ...formData, square_location_config_id: value === 'null' ? null : value })}>
                            <SelectTrigger style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                              <SelectValue placeholder="Select Square location...">
                                {formData.square_location_config_id
                                  ? squareLocationConfigs.find((c) => c.id === formData.square_location_config_id)?.name
                                  : "None"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent className="z-[10001]" position="popper" sideOffset={4} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                              <SelectItem value="null" style={{ color: 'var(--text-slate-900)' }}>No Square location</SelectItem>
                              {squareLocationConfigs.map((config) => (
                                <SelectItem key={config.id} value={config.id} style={{ color: 'var(--text-slate-900)' }}>
                                  {config.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                    </div>

                    {/* App Fee History Manager */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <Label style={{ color: 'var(--text-slate-900)' }}>App Fee Status & History</Label>
                            <div className="flex items-center gap-2">
                                <Switch
                                    id="pays_app_fees"
                                    checked={formData.pays_app_fees || false}
                                    onCheckedChange={(checked) => setFormData({ ...formData, pays_app_fees: checked })}
                                />
                                <Label htmlFor="pays_app_fees" className={`text-sm font-medium ${formData.pays_app_fees ? 'text-green-600' : 'text-slate-500'}`}>
                                    {formData.pays_app_fees ? 'Currently Paying Fees' : 'Not Paying Fees'}
                                </Label>
                            </div>
                        </div>

                        {/* App Fee History List */}
                        {formData.app_fee_history && formData.app_fee_history.length > 0 && (
                            <div className="border rounded-lg p-3 space-y-2" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
                                <p className="text-xs font-semibold text-slate-600 mb-2">Fee Payment History:</p>
                                {formData.app_fee_history
                                    .slice()
                                    .sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date))
                                    .map((entry, idx) => (
                                        <div key={idx} className="flex items-center justify-between bg-white p-2 rounded border" style={{ borderColor: 'var(--border-slate-200)' }}>
                                            <div className="flex items-center gap-3">
                                                <Input
                                                    type="date"
                                                    value={entry.effective_date}
                                                    onChange={(e) => {
                                                        const updated = [...formData.app_fee_history];
                                                        updated[idx] = { ...entry, effective_date: e.target.value };
                                                        setFormData({ ...formData, app_fee_history: updated });
                                                    }}
                                                    className="w-36 h-8 text-xs"
                                                    style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)' }}
                                                />
                                                <Select
                                                    value={entry.pays_app_fees ? 'true' : 'false'}
                                                    onValueChange={(value) => {
                                                        const updated = [...formData.app_fee_history];
                                                        updated[idx] = { ...entry, pays_app_fees: value === 'true' };
                                                        setFormData({ ...formData, app_fee_history: updated });
                                                    }}>
                                                    <SelectTrigger className="w-32 h-8" style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)' }}>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent className="z-[10001]">
                                                        <SelectItem value="true">Paying</SelectItem>
                                                        <SelectItem value="false">Not Paying</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                                {entry.changed_by && (
                                                    <span className="text-xs text-slate-500">by {entry.changed_by}</span>
                                                )}
                                            </div>
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => {
                                                    const updated = formData.app_fee_history.filter((_, i) => i !== idx);
                                                    setFormData({ ...formData, app_fee_history: updated });
                                                }}
                                                className="h-7 w-7 p-0">
                                                <Trash2 className="w-4 h-4 text-red-500" />
                                            </Button>
                                        </div>
                                    ))}
                            </div>
                        )}

                        {/* Add New History Entry */}
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                                const newEntry = {
                                    effective_date: new Date().toISOString().split('T')[0],
                                    pays_app_fees: formData.pays_app_fees || false,
                                    changed_by: 'Admin'
                                };
                                setFormData({
                                    ...formData,
                                    app_fee_history: [...(formData.app_fee_history || []), newEntry]
                                });
                            }}
                            className="gap-2">
                            <Plus className="w-4 h-4" />
                            Add History Entry
                        </Button>
                    </div>
                </div>

                {/* Driver Assignments & Pickup Times Section - NEW TABLE LAYOUT */}
                <div className="space-y-2">
                    <h3 className="text-lg font-semibold pb-2" style={{ color: 'var(--text-slate-900)', borderBottom: '1px solid var(--border-slate-200)' }}>
                        Driver Assignments & Pickup Times
                    </h3>

                    {/* Table Header */}
                    <div className="grid grid-cols-7 gap-2 text-sm font-semibold pb-1" style={{ color: 'var(--text-slate-700)', borderBottom: '1px solid var(--border-slate-200)' }}>
                        <div className="col-span-1">Day</div>
                        <div className="col-span-3 text-center">AM Shift</div>
                        <div className="col-span-3 text-center">PM Shift</div>
                    </div>

                    {/* Weekdays Row */}
                    <div className="grid grid-cols-7 gap-2 items-start" style={{ borderBottom: '1px solid var(--border-slate-100)' }}>
                        <div className="col-span-1 font-medium pt-2" style={{ color: 'var(--text-slate-700)' }}>
                            Mon-Fri
                        </div>
                        
                        {/* AM Column */}
                        <div className="col-span-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Switch
                  id="weekday-am-enabled"
                  checked={formData.weekday_am_enabled !== false}
                  onCheckedChange={(checked) => setFormData({ ...formData, weekday_am_enabled: checked })} />

                                <Label htmlFor="weekday-am-enabled" className="text-xs font-medium">
                                    {formData.weekday_am_enabled !== false ? 'On' : 'Off'}
                                </Label>
                            </div>
                            
                            {formData.weekday_am_enabled !== false &&
              <>
                                    <Select
                  value={formData.weekday_am_driver_id || 'null'}
                  onValueChange={(value) => handleDriverSelect(value, "weekday_am")}>

                                        <SelectTrigger className="h-9" style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                                            <SelectValue placeholder="Select driver...">
                                                {formData.weekday_am_driver_id ?
                      sortedDrivers.find((d) => d.id === formData.weekday_am_driver_id)?.user_name || sortedDrivers.find((d) => d.id === formData.weekday_am_driver_id)?.full_name :
                      "Select driver..."}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent className="z-[10001]" position="popper" sideOffset={4} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                                            <SelectItem value="null" style={{ color: 'var(--text-slate-900)' }}>No Driver</SelectItem>
                                            {sortedDrivers.map((driver) =>
                    <SelectItem key={driver.id} value={driver.id} style={{ color: 'var(--text-slate-900)' }}>
                                                    {driver.user_name || driver.full_name}
                                                </SelectItem>
                    )}
                                        </SelectContent>
                                    </Select>
                                    
                                    <div className="grid grid-cols-2 gap-2">
                                        <Input
                    type="time"
                    value={formData.weekday_am_start || ''}
                    onChange={(e) => setFormData({ ...formData, weekday_am_start: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="Start"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }} />

                                        <Input
                    type="time"
                    value={formData.weekday_am_end || ''}
                    onChange={(e) => setFormData({ ...formData, weekday_am_end: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="End"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }} />

                                    </div>
                                </>
              }
                        </div>

                        {/* PM Column */}
                        <div className="col-span-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Switch
                  id="weekday-pm-enabled"
                  checked={formData.weekday_pm_enabled !== false}
                  onCheckedChange={(checked) => setFormData({ ...formData, weekday_pm_enabled: checked })} />

                                <Label htmlFor="weekday-pm-enabled" className="text-xs font-medium">
                                    {formData.weekday_pm_enabled !== false ? 'On' : 'Off'}
                                </Label>
                            </div>
                            
                            {formData.weekday_pm_enabled !== false &&
              <>
                                    <Select
                  value={formData.weekday_pm_driver_id || 'null'}
                  onValueChange={(value) => handleDriverSelect(value, "weekday_pm")}>

                                        <SelectTrigger className="h-9">
                                            <SelectValue placeholder="Select driver...">
                                                {formData.weekday_pm_driver_id ?
                      sortedDrivers.find((d) => d.id === formData.weekday_pm_driver_id)?.user_name || sortedDrivers.find((d) => d.id === formData.weekday_pm_driver_id)?.full_name :
                      "Select driver..."}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent className="z-[10001]" position="popper" sideOffset={4}>
                                            <SelectItem value="null">No Driver</SelectItem>
                                            {sortedDrivers.map((driver) =>
                    <SelectItem key={driver.id} value={driver.id}>
                                                    {driver.user_name || driver.full_name}
                                                </SelectItem>
                    )}
                                        </SelectContent>
                                    </Select>
                                    
                                    <div className="grid grid-cols-2 gap-2">
                                        <Input
                    type="time"
                    value={formData.weekday_pm_start || ''}
                    onChange={(e) => setFormData({ ...formData, weekday_pm_start: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="Start" />

                                        <Input
                    type="time"
                    value={formData.weekday_pm_end || ''}
                    onChange={(e) => setFormData({ ...formData, weekday_pm_end: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="End" />

                                    </div>
                                </>
              }
                        </div>
                    </div>

                    {/* Saturday Row */}
                    <div className="grid grid-cols-7 gap-2 items-start" style={{ borderBottom: '1px solid var(--border-slate-100)' }}>
                        <div className="col-span-1 font-medium pt-2" style={{ color: 'var(--text-slate-700)' }}>
                            Saturday
                        </div>
                        
                        {/* AM Column */}
                        <div className="col-span-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Switch
                  id="saturday-am-enabled"
                  checked={formData.saturday_am_enabled !== false}
                  onCheckedChange={(checked) => setFormData({ ...formData, saturday_am_enabled: checked })} />

                                <Label htmlFor="saturday-am-enabled" className="text-xs font-medium">
                                    {formData.saturday_am_enabled !== false ? 'On' : 'Off'}
                                </Label>
                            </div>
                            
                            {formData.saturday_am_enabled !== false &&
              <>
                                    <Select
                  value={formData.saturday_am_driver_id || 'null'}
                  onValueChange={(value) => handleDriverSelect(value, "saturday_am")}>

                                        <SelectTrigger className="h-9">
                                            <SelectValue placeholder="Select driver...">
                                                {formData.saturday_am_driver_id ?
                      sortedDrivers.find((d) => d.id === formData.saturday_am_driver_id)?.user_name || sortedDrivers.find((d) => d.id === formData.saturday_am_driver_id)?.full_name :
                      "Select driver..."}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent className="z-[10001]" position="popper" sideOffset={4}>
                                            <SelectItem value="null">No Driver</SelectItem>
                                            {sortedDrivers.map((driver) =>
                    <SelectItem key={driver.id} value={driver.id}>
                                                    {driver.user_name || driver.full_name}
                                                </SelectItem>
                    )}
                                        </SelectContent>
                                    </Select>
                                    
                                    <div className="grid grid-cols-2 gap-2">
                                        <Input
                    type="time"
                    value={formData.saturday_am_start || ''}
                    onChange={(e) => setFormData({ ...formData, saturday_am_start: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="Start" />

                                        <Input
                    type="time"
                    value={formData.saturday_am_end || ''}
                    onChange={(e) => setFormData({ ...formData, saturday_am_end: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="End" />

                                    </div>
                                </>
              }
                        </div>

                        {/* PM Column */}
                        <div className="col-span-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Switch
                  id="saturday-pm-enabled"
                  checked={formData.saturday_pm_enabled !== false}
                  onCheckedChange={(checked) => setFormData({ ...formData, saturday_pm_enabled: checked })} />

                                <Label htmlFor="saturday-pm-enabled" className="text-xs font-medium">
                                    {formData.saturday_pm_enabled !== false ? 'On' : 'Off'}
                                </Label>
                            </div>
                            
                            {formData.saturday_pm_enabled !== false &&
              <>
                                    <Select
                  value={formData.saturday_pm_driver_id || 'null'}
                  onValueChange={(value) => handleDriverSelect(value, "saturday_pm")}>

                                        <SelectTrigger className="h-9">
                                            <SelectValue placeholder="Select driver...">
                                                {formData.saturday_pm_driver_id ?
                      sortedDrivers.find((d) => d.id === formData.saturday_pm_driver_id)?.user_name || sortedDrivers.find((d) => d.id === formData.saturday_pm_driver_id)?.full_name :
                      "Select driver..."}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent className="z-[10001]" position="popper" sideOffset={4}>
                                            <SelectItem value="null">No Driver</SelectItem>
                                            {sortedDrivers.map((driver) =>
                    <SelectItem key={driver.id} value={driver.id}>
                                                    {driver.user_name || driver.full_name}
                                                </SelectItem>
                    )}
                                        </SelectContent>
                                    </Select>
                                    
                                    <div className="grid grid-cols-2 gap-2">
                                        <Input
                    type="time"
                    value={formData.saturday_pm_start || ''}
                    onChange={(e) => setFormData({ ...formData, saturday_pm_start: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="Start" />

                                        <Input
                    type="time"
                    value={formData.saturday_pm_end || ''}
                    onChange={(e) => setFormData({ ...formData, saturday_pm_end: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="End" />

                                    </div>
                                </>
              }
                        </div>
                    </div>

                    {/* Sunday Row */}
                    <div className="grid grid-cols-7 gap-2 items-start">
                        <div className="col-span-1 font-medium pt-2" style={{ color: 'var(--text-slate-700)' }}>
                            Sunday
                        </div>
                        
                        {/* AM Column */}
                        <div className="col-span-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Switch
                  id="sunday-am-enabled"
                  checked={formData.sunday_am_enabled !== false}
                  onCheckedChange={(checked) => setFormData({ ...formData, sunday_am_enabled: checked })} />

                                <Label htmlFor="sunday-am-enabled" className="text-xs font-medium">
                                    {formData.sunday_am_enabled !== false ? 'On' : 'Off'}
                                </Label>
                            </div>
                            
                            {formData.sunday_am_enabled !== false &&
              <>
                                    <Select
                  value={formData.sunday_am_driver_id || 'null'}
                  onValueChange={(value) => handleDriverSelect(value, "sunday_am")}>

                                        <SelectTrigger className="h-9">
                                            <SelectValue placeholder="Select driver...">
                                                {formData.sunday_am_driver_id ?
                      sortedDrivers.find((d) => d.id === formData.sunday_am_driver_id)?.user_name || sortedDrivers.find((d) => d.id === formData.sunday_am_driver_id)?.full_name :
                      "Select driver..."}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent className="z-[10001]" position="popper" sideOffset={4}>
                                            <SelectItem value="null">No Driver</SelectItem>
                                            {sortedDrivers.map((driver) =>
                    <SelectItem key={driver.id} value={driver.id}>
                                                    {driver.user_name || driver.full_name}
                                                </SelectItem>
                    )}
                                        </SelectContent>
                                    </Select>
                                    
                                    <div className="grid grid-cols-2 gap-2">
                                        <Input
                    type="time"
                    value={formData.sunday_am_start || ''}
                    onChange={(e) => setFormData({ ...formData, sunday_am_start: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="Start" />

                                        <Input
                    type="time"
                    value={formData.sunday_am_end || ''}
                    onChange={(e) => setFormData({ ...formData, sunday_am_end: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="End" />

                                    </div>
                                </>
              }
                        </div>

                        {/* PM Column */}
                        <div className="col-span-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Switch
                  id="sunday-pm-enabled"
                  checked={formData.sunday_pm_enabled !== false}
                  onCheckedChange={(checked) => setFormData({ ...formData, sunday_pm_enabled: checked })} />

                                <Label htmlFor="sunday-pm-enabled" className="text-xs font-medium">
                                    {formData.sunday_pm_enabled !== false ? 'On' : 'Off'}
                                </Label>
                            </div>
                            
                            {formData.sunday_pm_enabled !== false &&
              <>
                                    <Select
                  value={formData.sunday_pm_driver_id || 'null'}
                  onValueChange={(value) => handleDriverSelect(value, "sunday_pm")}>

                                        <SelectTrigger className="h-9">
                                            <SelectValue placeholder="Select driver...">
                                                {formData.sunday_pm_driver_id ?
                      sortedDrivers.find((d) => d.id === formData.sunday_pm_driver_id)?.user_name || sortedDrivers.find((d) => d.id === formData.sunday_pm_driver_id)?.full_name :
                      "Select driver..."}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent className="z-[10001]" position="popper" sideOffset={4}>
                                            <SelectItem value="null">No Driver</SelectItem>
                                            {sortedDrivers.map((driver) =>
                    <SelectItem key={driver.id} value={driver.id}>
                                                    {driver.user_name || driver.full_name}
                                                </SelectItem>
                    )}
                                        </SelectContent>
                                    </Select>
                                    
                                    <div className="grid grid-cols-2 gap-2">
                                        <Input
                    type="time"
                    value={formData.sunday_pm_start || ''}
                    onChange={(e) => setFormData({ ...formData, sunday_pm_start: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="Start" />

                                        <Input
                    type="time"
                    value={formData.sunday_pm_end || ''}
                    onChange={(e) => setFormData({ ...formData, sunday_pm_end: e.target.value })}
                    className="h-9 text-xs"
                    placeholder="End" />

                                    </div>
                                </>
              }
                        </div>
                    </div>
                </div>

                {/* Form Actions */}
                <div className="flex justify-end gap-3 pt-4" style={{ borderTop: '1px solid var(--border-slate-200)' }}>
                    <Button type="button" variant="outline" onClick={onCancel} style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
                        Cancel
                    </Button>
                    <Button
            type="submit"
            disabled={!formData.name || !formData.address || !formData.phone || !formData.city_id}
            className="bg-emerald-600 hover:bg-emerald-700">

                        {store ? 'Update Store' : 'Create Store'}
                    </Button>
                </div>
            </form>
        </div>);

}