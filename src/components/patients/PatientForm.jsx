import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Save, UserPlus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { generatePatientId, validateId, formatId } from '@/components/utils/idGenerator';
import { PhoneInput } from "@/components/ui/phone-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { sortStores } from "@/components/utils/sorting";
import { userHasRole, isAppOwner } from '@/components/utils/userRoles';
import { useAppData } from '@/components/utils/AppDataContext';
import { GoogleAddressAutocomplete } from "@/components/ui/google-address-autocomplete";
import { createPatientLocal, updatePatientLocal } from '../utils/offlineMutations';
import { isMobileDevice } from '@/components/utils/deviceUtils';

const CheckboxField = ({ id, label, checked, onChange, disabled }) =>
<div className="flex items-center space-x-2">
    <Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={id} className="text-sm font-normal no-underline leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
      {label}
    </Label>
  </div>;

const capitalizeName = (name) => {
  if (!name) return '';
  return name.
  split(' ').
  map((word) => word.charAt(0).toUpperCase() + word.slice(1)).
  join(' ');
};

const abbreviateAddress = (address) => {
  if (!address) return '';

  const abbreviations = {
    'Northwest': 'NW',
    'Northeast': 'NE',
    'Southwest': 'SW',
    'Southeast': 'SE',
    'North': 'N',
    'South': 'S',
    'East': 'E',
    'West': 'W',
    'Boulevard': 'Blvd',
    'Drive': 'Dr',
    'Road': 'Rd',
    'Lane': 'Ln',
    'Court': 'Ct',
    'Place': 'Pl',
    'Terrace': 'Ter'
  };

  let abbreviated = address;

  Object.entries(abbreviations).forEach(([full, abbrev]) => {
    const regex = new RegExp(`\\b${full}\\b`, 'gi');
    abbreviated = abbreviated.replace(regex, abbrev);
  });

  return abbreviated;
};

const dayAbbrevs = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun'
};

export default function PatientForm({
  patient,
  stores = [],
  onSave,
  onCancel,
  currentUser,
  cities: citiesProp = [],
  allPatients = [],
  returnPatientOnSave = false
}) {
  const { setIsFormOverlayOpen, cities: contextCities = [] } = useAppData();

  // CRITICAL: Use cities from context if available, otherwise fall back to prop
  const cities = contextCities.length > 0 ? contextCities : citiesProp;

  // CRITICAL DEBUG: Log props on mount
  useEffect(() => {
    console.log('🔍 [PatientForm] Component mounted with props:');
    console.log('   cities:', cities);
    console.log('   cities.length:', cities?.length);
    console.log('   currentUser:', currentUser);
    console.log('   currentUser.city_id:', currentUser?.city_id);
  }, []);

  const [formData, setFormData] = useState({
    patient_id: "",
    full_name: "",
    phone: "",
    phone_secondary: "",
    address: "",
    unit_number: "",
    notes: "",
    store_id: "",
    time_window_start: "",
    time_window_end: "",
    status: "active",
    latitude: null,
    longitude: null,
    distance_from_store: null,
    mailbox_ok: false,
    call_upon_arrival: false,
    ring_bell: false,
    dont_ring_bell: false,
    back_door: false
  });

  const [isRecurring, setIsRecurring] = useState(false);
  const [frequency, setFrequency] = useState('');
  const [weeklyDays, setWeeklyDays] = useState([]);
  const [showWeeklyDays, setShowWeeklyDays] = useState(false);
  const isInitialLoad = useRef(true);

  const cityCenter = useMemo(() => {
    // PRIORITY: If a store is assigned, ALWAYS use that store's coordinates for distance calculations
    if (formData.store_id && stores && stores.length > 0) {
      const assignedStore = stores.find((s) => s && s.id === formData.store_id);
      if (assignedStore?.latitude && assignedStore?.longitude) {
        return {
          latitude: assignedStore.latitude,
          longitude: assignedStore.longitude
        };
      }
    }

    // Fallback: For dispatchers without assigned store, use first dispatcher store
    const isDispatcher = currentUser && userHasRole(currentUser, 'dispatcher');
    if (isDispatcher && !userHasRole(currentUser, 'admin') && stores && stores.length > 0) {
      if (currentUser.store_ids && currentUser.store_ids.length > 0) {
        const targetStore = stores.find((s) => s && s.id === currentUser.store_ids[0]);
        if (targetStore?.latitude && targetStore?.longitude) {
          return {
            latitude: targetStore.latitude,
            longitude: targetStore.longitude
          };
        }
      }
    }

    // Final fallback: Use city center
    if (currentUser?.city_id && cities && cities.length > 0) {
      const userCity = cities.find((c) => c && c.id === currentUser.city_id);
      if (userCity?.latitude && userCity?.longitude) {
        return {
          latitude: userCity.latitude,
          longitude: userCity.longitude
        };
      }
    }

    return null;
  }, [currentUser, cities, stores, formData.store_id]);

  useEffect(() => {
    if (!patient && !formData.patient_id) {
      const newPID = generatePatientId(allPatients.map((p) => p.patient_id));
      setFormData((prev) => ({ ...prev, patient_id: newPID }));
    }
  }, [patient, allPatients]);

  useEffect(() => {
    const isAdmin = currentUser && userHasRole(currentUser, 'admin');
    const isDriver = currentUser && userHasRole(currentUser, 'driver');
    const isDispatcher = currentUser && userHasRole(currentUser, 'dispatcher') && !isAdmin && !isDriver;

    if (!patient && currentUser && isDispatcher) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (dispatcherStoreIds.length === 1) {
        setFormData((prev) => ({ ...prev, store_id: dispatcherStoreIds[0] }));
      }
    }
  }, [patient, currentUser]);

  useEffect(() => {
    if (patient) {
      const dayMap = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      let initialWeeklyDays = [];
      dayMap.forEach((day) => {
        if (patient[`recurring_weekly_${day}`]) {
          initialWeeklyDays.push(day);
        }
      });

      let initialFrequency = '';
      if (patient.recurring_daily) {
        initialFrequency = 'daily';
      } else if (patient.recurring_biweekly) {
        initialFrequency = 'bi-weekly';
      } else if (patient.recurring_weekly_x4) {
        initialFrequency = 'weekly-x4';
      } else if (patient.recurring_bimonthly) {
        initialFrequency = 'bi-monthly';
      } else if (patient.recurring_monthly) {
        initialFrequency = 'monthly';
      } else if (initialWeeklyDays.length > 0) {
        initialFrequency = 'weekly';
      }

      const hasRecurring = initialFrequency !== '';

      setFormData({
        patient_id: patient.patient_id || "",
        full_name: patient.full_name || "",
        phone: patient.phone || "",
        phone_secondary: patient.phone_secondary || "",
        address: patient.address || "",
        unit_number: patient.unit_number || "",
        notes: patient.notes || "",
        store_id: patient.store_id || "",
        time_window_start: patient.time_window_start || "",
        time_window_end: patient.time_window_end || "",
        status: patient.status || "active",
        latitude: patient.latitude || null,
        longitude: patient.longitude || null,
        distance_from_store: patient.distance_from_store || null,
        mailbox_ok: patient.mailbox_ok || false,
        call_upon_arrival: patient.call_upon_arrival || false,
        ring_bell: patient.ring_bell || false,
        dont_ring_bell: patient.dont_ring_bell || false,
        back_door: patient.back_door || false
      });

      setIsRecurring(hasRecurring);
      setFrequency(initialFrequency);
      setWeeklyDays(initialWeeklyDays);
      setShowWeeklyDays(false);

      setTimeout(() => {
        isInitialLoad.current = false;
      }, 0);
    }
  }, [patient]);

  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleEscKey);
    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [onCancel]);

  useEffect(() => {
    if (setIsFormOverlayOpen) {
      setIsFormOverlayOpen(true);
    }
    return () => {
      if (setIsFormOverlayOpen) {
        setIsFormOverlayOpen(false);
      }
    };
  }, [setIsFormOverlayOpen]);

  const handleAddressSelect = (addressData) => {
    // Use street_address which preserves directionals (NW, SE, etc.)
    const abbreviatedAddress = abbreviateAddress(addressData.street_address || addressData.full_address);

    // Calculate distance from assigned store if store is selected
    let distanceFromStore = null;
    if (formData.store_id && stores) {
      const assignedStore = stores.find((s) => s && s.id === formData.store_id);

      if (assignedStore?.latitude && assignedStore?.longitude && addressData.latitude && addressData.longitude) {
        // Haversine formula for distance
        const R = 6371; // Earth's radius in km
        const dLat = (addressData.latitude - assignedStore.latitude) * Math.PI / 180;
        const dLon = (addressData.longitude - assignedStore.longitude) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(assignedStore.latitude * Math.PI / 180) * Math.cos(addressData.latitude * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distanceFromStore = parseFloat((R * c).toFixed(2)); // Round to 2 decimal places
      }
    }

    const newFormData = {
      ...formData,
      address: abbreviatedAddress,
      latitude: parseFloat(addressData.latitude.toFixed(7)), // Round to 7 decimal places
      longitude: parseFloat(addressData.longitude.toFixed(7)), // Round to 7 decimal places
      distance_from_store: distanceFromStore
    };

    setFormData(newFormData);
  };

  const handleWeeklyDayToggle = (day) => {
    setWeeklyDays((prev) => {
      if (prev.includes(day)) {
        return prev.filter((d) => d !== day);
      } else {
        return [...prev, day];
      }
    });
  };

  const handleRecurringChange = (checked) => {
    setIsRecurring(checked);
    if (!checked) {
      setFrequency('');
      setWeeklyDays([]);
      setShowWeeklyDays(false);
    }
  };

  const handleWeeklyClick = () => {
    setFrequency('weekly');
    setShowWeeklyDays(true);
  };

  const handleBiWeeklyClick = () => {
    setFrequency('bi-weekly');
    setShowWeeklyDays(true);
  };

  const handleWeeklyDaysDone = () => {
    setShowWeeklyDays(false);
  };

  useEffect(() => {
    if (isInitialLoad.current) {
      return;
    }

    if (frequency !== 'weekly' && frequency !== 'bi-weekly') {
      setShowWeeklyDays(false);
      setWeeklyDays([]);
    }
  }, [frequency]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    let dataToSave = { ...formData };

    // Recalculate distance from store before saving (in case store changed)
    // UNLESS it was manually edited by app owner (preserve manual edits)
    if (dataToSave.store_id && dataToSave.latitude && dataToSave.longitude && stores) {
      const assignedStore = stores.find((s) => s && s.id === dataToSave.store_id);
      if (assignedStore?.latitude && assignedStore?.longitude) {
        // Only auto-calculate if distance is null or if not editing existing patient
        const shouldRecalculate = dataToSave.distance_from_store === null || !patient;
        if (shouldRecalculate) {
          const R = 6371;
          const dLat = (dataToSave.latitude - assignedStore.latitude) * Math.PI / 180;
          const dLon = (dataToSave.longitude - assignedStore.longitude) * Math.PI / 180;
          const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(assignedStore.latitude * Math.PI / 180) * Math.cos(dataToSave.latitude * Math.PI / 180) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          dataToSave.distance_from_store = parseFloat((R * c).toFixed(2)); // Round to 2 decimal places
        }
        // Otherwise preserve the manually edited value
      }
    }

    dataToSave.recurring_daily = false;
    dataToSave.recurring_biweekly = false;
    dataToSave.recurring_weekly_x4 = false;
    dataToSave.recurring_bimonthly = false;
    dataToSave.recurring_monthly = false;
    const dayMap = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    dayMap.forEach((day) => {
      dataToSave[`recurring_weekly_${day}`] = false;
    });

    if (isRecurring) {
      switch (frequency) {
        case 'daily':
          dataToSave.recurring_daily = true;
          break;
        case 'bi-weekly':
          dataToSave.recurring_biweekly = true;
          weeklyDays.forEach((day) => {
            dataToSave[`recurring_weekly_${day}`] = true;
          });
          break;
        case 'weekly-x4':
          dataToSave.recurring_weekly_x4 = true;
          break;
        case 'bi-monthly':
          dataToSave.recurring_bimonthly = true;
          break;
        case 'monthly':
          dataToSave.recurring_monthly = true;
          break;
        case 'weekly':
          weeklyDays.forEach((day) => {
            dataToSave[`recurring_weekly_${day}`] = true;
          });
          break;
        default:
          break;
      }
    }

    if (!patient && !dataToSave.patient_id) {
      const existingPatients = allPatients;
      dataToSave.patient_id = generatePatientId(existingPatients.map((p) => p.patient_id));
    }

    if (dataToSave.patient_id) {
      dataToSave.patient_id = formatId(dataToSave.patient_id);
    }

    dataToSave.mailbox_ok = !!dataToSave.mailbox_ok;
    dataToSave.call_upon_arrival = !!dataToSave.call_upon_arrival;
    dataToSave.ring_bell = !!dataToSave.ring_bell;
    dataToSave.dont_ring_bell = !!dataToSave.dont_ring_bell;
    dataToSave.back_door = !!dataToSave.back_door;

    console.log('💾 [PatientForm] Saving patient...');

    try {
      // STEP 1: Save to offline database (creates mutation)
      let savedPatientId;
      if (patient) {
        await updatePatientLocal(patient.id, dataToSave);
        savedPatientId = patient.id;
        console.log('  ✅ Updated patient in offline DB');
      } else {
        const savedPatient = await createPatientLocal(dataToSave);
        savedPatientId = savedPatient.id;
        console.log('  ✅ Created patient in offline DB');
        if (returnPatientOnSave) {
          // CRITICAL: Merge saved patient with dataToSave to ensure ALL fields are passed back
          // This ensures location data (latitude, longitude, distance_from_store) is included
          const completePatient = {
            ...dataToSave,
            ...savedPatient,
            id: savedPatient.id
          };
          console.log('  📤 Returning complete patient data with location:', {
            id: completePatient.id,
            latitude: completePatient.latitude,
            longitude: completePatient.longitude,
            distance_from_store: completePatient.distance_from_store
          });
          onSave(completePatient, true);
          return;
        }
      }

      // STEP 2: Trigger immediate sync to backend
      const { processPendingMutations } = await import('../utils/offlineSync');
      console.log('  🔄 Syncing to backend...');
      await processPendingMutations();
      console.log('  ✅ Synced to backend');

      // STEP 3: Broadcast change to other devices (non-blocking)
      try {
        const { base44 } = await import('@/api/base44Client');
        await base44.functions.invoke('broadcastEntityChange', {
          entity_name: 'Patient',
          operation: patient ? 'update' : 'create',
          metadata: { id: savedPatientId }
        });
        console.log('  📡 Broadcasted to other devices');
      } catch (broadcastError) {
        console.warn('  ⚠️ Broadcast failed (non-critical):', broadcastError.message);
      }

      // STEP 4: Force refresh from backend to get latest data
      const { base44 } = await import('@/api/base44Client');
      console.log('  🔄 Fetching latest patient data...');
      const freshPatient = await base44.entities.Patient.get(savedPatientId);
      console.log('  ✅ Fresh patient data fetched');

      // STEP 5: Update offline database with fresh data
      const { offlineDB } = await import('../utils/offlineDatabase');
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [freshPatient]);
      console.log('  ✅ Offline DB updated with fresh data');

      // STEP 6: Invalidate cache and trigger UI update
      const { invalidate } = await import('../utils/dataManager');
      invalidate('Patient');
      console.log('  ✅ Cache invalidated');

      // STEP 7: Call parent onSave if provided (triggers parent refresh)
      if (onSave && !returnPatientOnSave) {
        await onSave(dataToSave);
      }
      
      onCancel();
    } catch (error) {
      console.error('❌ [PatientForm] Save error:', error);
      alert(`Failed to save patient: ${error.message}`);
    }
  };

  const isFormValid = formData.full_name && formData.address && formData.store_id;
  const storeSelectRef = useRef(null);
  const addressInputRef = useRef(null);

  // Auto-focus store dropdown if no store selected on new patient
  useEffect(() => {
    if (!patient && !formData.store_id && storeSelectRef.current) {
      setTimeout(() => {
        storeSelectRef.current?.click();
      }, 200);
    }
  }, [patient, formData.store_id]);

  // Auto-focus address field after store is selected (non-mobile only)
  useEffect(() => {
    const isMobile = isMobileDevice();
    
    // Only auto-focus on non-mobile devices when store is selected
    if (!isMobile && formData.store_id) {
      setTimeout(() => {
        if (addressInputRef.current) {
          const inputElement = addressInputRef.current instanceof HTMLInputElement 
            ? addressInputRef.current 
            : addressInputRef.current?.querySelector('input');
          
          if (inputElement) {
            inputElement.focus();
            inputElement.select?.();
          }
        }
      }, 100);
    }
  }, [formData.store_id]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const target = e.target;
      if (target.tagName === 'TEXTAREA') {
        return;
      }
      // CRITICAL: Don't prevent Enter on buttons or comboboxes (Select components)
      if (target.tagName === 'BUTTON' || target.getAttribute('role') === 'combobox') {
        return;
      }

      e.preventDefault();
      if (isFormValid) {
        handleSubmit(e);
      }
    }
  };

  const sortedStores = sortStores(stores);

  const isAdmin = currentUser && userHasRole(currentUser, 'admin');
  const isDriver = currentUser && userHasRole(currentUser, 'driver');
  const isDispatcher = currentUser && userHasRole(currentUser, 'dispatcher') && !isAdmin && !isDriver;
  const dispatcherStoreIds = isDispatcher ? currentUser.store_ids || [] : [];
  const isStoreDisabled = isDispatcher && dispatcherStoreIds.length === 1;

  const availableStores = useMemo(() => {
    if (!currentUser) return sortedStores;

    if (isAdmin || isDriver) {
      return sortedStores;
    }

    if (isDispatcher) {
      return sortedStores.filter((store) => dispatcherStoreIds.includes(store.id));
    }

    return sortedStores;
  }, [currentUser, sortedStores, isAdmin, isDriver, isDispatcher, dispatcherStoreIds]);

  const getWeeklyLabel = () => {
    if (frequency === 'weekly' && weeklyDays.length > 0) {
      const daysStr = weeklyDays.map((d) => dayAbbrevs[d] || d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
      return `Weekly (${daysStr})`;
    }
    return 'Weekly';
  };

  const getBiWeeklyLabel = () => {
    if (frequency === 'bi-weekly' && weeklyDays.length > 0) {
      const daysStr = weeklyDays.map((d) => dayAbbrevs[d] || d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
      return `Bi-Weekly (${daysStr})`;
    }
    return 'Bi-Weekly';
  };

  const isPIDValid = formData.patient_id ? validateId(formData.patient_id, 5) : null;
  const pidBackgroundColor = isPIDValid === null ? '' : isPIDValid ? 'bg-emerald-50' : 'bg-red-50';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 pt-20 lg:pt-4 z-[10020] lg:pl-64">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-[30rem] max-h-[90vh] flex flex-col">

        <Card className="shadow-xl flex flex-col overflow-hidden" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          <CardHeader className="px-4 py-2 flex flex-col space-y-1.5 border-b flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl font-bold flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
                <UserPlus className="w-5 h-5 text-emerald-600" />
                {patient ? 'Edit Patient' : 'Add New Patient'}
              </CardTitle>
              <Button variant="ghost" size="icon" onClick={onCancel}>
                <X className="w-4 h-4" style={{ color: 'var(--text-slate-700)' }} />
              </Button>
            </div>
          </CardHeader>

          <CardContent className="px-2 py-2 overflow-y-auto flex-1" style={{ background: 'var(--bg-white)' }}>
            <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="space-y-2">
              {/* AppOwner Only: GPS & Distance Section */}
              {isAppOwner(currentUser) &&
              <div className="border-2 px-2 py-2 rounded-[10px] space-y-2" style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-slate-200)' }}>
                  <div className="flex items-center gap-2 mb-1">
                    <Label className="text-xs font-semibold uppercase" style={{ color: 'var(--text-slate-700)' }}>App Owner Controls</Label>
                  </div>
                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-2 space-y-1">
                        <Label htmlFor="patient_id_appowner" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>PID</Label>
                      <Input
                      id="patient_id_appowner"
                      value={formData.patient_id}
                      onChange={(e) => setFormData((prev) => ({ ...prev, patient_id: e.target.value.trim() }))}
                      placeholder="5-char"
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
                      maxLength={5} />
                    </div>
                    <div className="col-span-4 space-y-1">
                      <Label htmlFor="latitude" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Latitude</Label>
                      <Input
                      id="latitude"
                      type="number"
                      step="any"
                      value={formData.latitude !== null && formData.latitude !== undefined ? formData.latitude : ''}
                      onChange={(e) => setFormData((prev) => ({ ...prev, latitude: e.target.value ? parseFloat(e.target.value) : null }))}
                      placeholder="GPS Lat"
                      className="h-10 md:h-9 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                    </div>
                    <div className="col-span-4 space-y-1">
                      <Label htmlFor="longitude" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Longitude</Label>
                      <Input
                      id="longitude"
                      type="number"
                      step="any"
                      value={formData.longitude !== null && formData.longitude !== undefined ? formData.longitude : ''}
                      onChange={(e) => setFormData((prev) => ({ ...prev, longitude: e.target.value ? parseFloat(e.target.value) : null }))}
                      placeholder="GPS Lon"
                      className="h-10 md:h-9 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                    </div>
                    <div className="col-span-2 space-y-1">
                      <Label htmlFor="distance" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Dist (km)</Label>
                      <Input
                      id="distance"
                      type="number"
                      step="0.01"
                      value={formData.distance_from_store !== null && formData.distance_from_store !== undefined ? formData.distance_from_store : ''}
                      onChange={(e) => setFormData((prev) => ({ ...prev, distance_from_store: e.target.value ? parseFloat(e.target.value) : null }))}
                      placeholder="km"
                      className="h-10 md:h-9 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                    </div>
                  </div>
                </div>
              }

              {/* Container 1: Store/Status/Time Windows */}
              <div className="px-2 py-2 rounded-[10px] space-y-2" style={{ background: 'var(--bg-slate-100)' }}>
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="status" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Status</Label>
                    <Select
                      value={formData.status}
                      onValueChange={(value) => setFormData((prev) => ({ ...prev, status: value }))}>
                      <SelectTrigger className="h-10 md:h-9 text-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-[200px] overflow-y-auto z-[99999]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="inactive">Inactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="time_window_start" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Deliver After</Label>
                    <Input
                      id="time_window_start"
                      type="time"
                      value={formData.time_window_start}
                      onChange={(e) => setFormData((prev) => ({ ...prev, time_window_start: e.target.value }))}
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>

                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="time_window_end" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Deliver Before</Label>
                    <Input
                      id="time_window_end"
                      type="time"
                      value={formData.time_window_end}
                      onChange={(e) => setFormData((prev) => ({ ...prev, time_window_end: e.target.value }))}
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>
                </div>

                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-6 space-y-1">
                    <Label htmlFor="store_id" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Assigned Store *</Label>
                    <Select
                      value={formData.store_id}
                      onValueChange={(value) => setFormData((prev) => ({ ...prev, store_id: value }))}
                      disabled={isStoreDisabled}>
                      <SelectTrigger ref={storeSelectRef} className="h-10 md:h-9 text-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                        <SelectValue placeholder="Select store..." />
                      </SelectTrigger>
                      <SelectContent className="max-h-[300px] overflow-y-auto z-[99999]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                        {availableStores.map((store) =>
                        <SelectItem key={store.id} value={store.id}>
                            {store.name}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  {!isAppOwner(currentUser) &&
                  <div className="col-span-6 space-y-1">
                    <Label htmlFor="patient_id" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Patient ID (PID) *</Label>
                    <Input
                      id="patient_id"
                      value={formData.patient_id}
                      onChange={(e) => setFormData((prev) => ({ ...prev, patient_id: e.target.value.trim() }))}
                      placeholder="5-char ID"
                      className={`h-10 md:h-9 text-sm ${pidBackgroundColor}`}
                      style={{ background: pidBackgroundColor || 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
                      maxLength={5} />
                    {formData.patient_id && !validateId(formData.patient_id, 5) &&
                      <p className="text-xs text-red-600">Must be 5 chars</p>
                    }
                  </div>
                  }
                </div>
              </div>

              {/* Container 2: Name/Phone and Address/Unit */}
              <div className="px-2 py-2 rounded-[10px] space-y-2" style={{ background: 'var(--bg-slate-100)' }}>
                <div className="grid grid-cols-10 gap-2">
                  <div className="px-1 col-span-4 space-y-1">
                    <Label htmlFor="full_name" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Full Name *</Label>
                    <Input
                      id="full_name"
                      value={formData.full_name}
                      onChange={(e) => setFormData((prev) => ({ ...prev, full_name: capitalizeName(e.target.value) }))}
                      required
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>

                  <div className="col-span-3 space-y-1">
                    <Label htmlFor="phone" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Phone Number</Label>
                    <PhoneInput
                      id="phone"
                      value={formData.phone}
                      onChange={(value) => setFormData((prev) => ({ ...prev, phone: value }))}
                      placeholder="Phone number"
                      className="h-10 md:h-9 text-sm" />
                  </div>

                  <div className="col-span-3 space-y-1">
                    <Label htmlFor="phone_secondary" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Alt. Phone</Label>
                    <PhoneInput
                      id="phone_secondary"
                      value={formData.phone_secondary}
                      onChange={(value) => setFormData((prev) => ({ ...prev, phone_secondary: value }))}
                      placeholder="Alt. phone"
                      className="h-10 md:h-9 text-sm" />
                  </div>
                </div>

                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-8 space-y-1">
                    <Label htmlFor="address" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Address *</Label>
                    <GoogleAddressAutocomplete
                      ref={addressInputRef}
                      value={formData.address}
                      onChange={(value) => setFormData((prev) => ({ ...prev, address: value }))}
                      onAddressSelect={handleAddressSelect}
                      cityCenter={cityCenter}
                      placeholder="Start typing address..."
                      className="h-10 md:h-9 text-sm" />

                  </div>

                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="unit_number" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Unit/Apt #</Label>
                    <Input
                      id="unit_number"
                      value={formData.unit_number}
                      onChange={(e) => setFormData((prev) => ({ ...prev, unit_number: e.target.value }))}
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>
                </div>
              </div>

              {/* Container 3: Patient Notes */}
              <div className="px-1 py-1 rounded-[10px]" style={{ background: 'var(--bg-slate-100)' }}>
                <div className="px-2 py-2 space-y-1">
                  <Label htmlFor="notes" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Patient Notes</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                    placeholder="Special delivery instructions, preferences, etc."
                    className="h-24 md:h-32 text-sm resize-none"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                    <div className="px-3 py-2 rounded-[10px]" style={{ background: 'var(--bg-slate-200)' }}>
                      <div className="border-b pb-2 mb-3" style={{ borderColor: 'var(--border-slate-300)' }}>
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Preferences</h3>
                      </div>

                  <div className="space-y-3">
                    <CheckboxField
                      id="mailbox_ok"
                      label="Mailbox OK"
                      checked={formData.mailbox_ok}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, mailbox_ok: checked }))} />

                  <CheckboxField
                      id="ring_bell"
                      label="Ring Bell"
                      checked={formData.ring_bell}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, ring_bell: checked }))} />

                  <CheckboxField
                      id="back_door"
                      label="Back Door"
                      checked={formData.back_door}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, back_door: checked }))} />

                  <CheckboxField
                      id="call_upon_arrival"
                      label="Call Upon Arrival"
                      checked={formData.call_upon_arrival}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, call_upon_arrival: checked }))} />

                    <CheckboxField
                      id="dont_ring_bell"
                      label="DON'T Ring Bell"
                      checked={formData.dont_ring_bell}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, dont_ring_bell: checked }))} />
                  </div>
                </div>

                <div className="px-3 py-2 rounded-[10px] relative" style={{ background: 'var(--bg-slate-200)' }}>
                  <div className="border-b pb-2" style={{ borderColor: 'var(--border-slate-300)' }}>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="recurring"
                            checked={isRecurring}
                            onCheckedChange={handleRecurringChange} />
                          <Label htmlFor="recurring" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                            Recurring
                          </Label>
                        </div>
                      </div>

                      <RadioGroup
                        value={frequency}
                        onValueChange={setFrequency}
                        disabled={!isRecurring}>

                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="daily" id="daily" disabled={!isRecurring} />
                          <Label htmlFor="daily" className="text-sm" style={{ color: !isRecurring ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}>
                            Daily
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem
                            value="weekly"
                            id="weekly"
                            disabled={!isRecurring}
                            onClick={(e) => {
                              if (isRecurring) {
                                e.preventDefault();
                                handleWeeklyClick();
                              }
                            }} />
                          <Label
                            htmlFor="weekly"
                            className="text-sm cursor-pointer"
                            style={{ color: !isRecurring ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}
                            onClick={(e) => {
                              if (isRecurring) {
                                e.preventDefault();
                                handleWeeklyClick();
                              }
                            }}>
                            {getWeeklyLabel()}
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem
                            value="bi-weekly"
                            id="bi-weekly"
                            disabled={!isRecurring}
                            onClick={(e) => {
                              if (isRecurring) {
                                e.preventDefault();
                                handleBiWeeklyClick();
                              }
                            }} />
                          <Label
                            htmlFor="bi-weekly"
                            className="text-sm cursor-pointer"
                            style={{ color: !isRecurring ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}
                            onClick={(e) => {
                              if (isRecurring) {
                                e.preventDefault();
                                handleBiWeeklyClick();
                              }
                            }}>
                            {getBiWeeklyLabel()}
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="weekly-x4" id="weekly-x4" disabled={!isRecurring} />
                          <Label htmlFor="weekly-x4" className="text-sm" style={{ color: !isRecurring ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}>
                            Weekly x4
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="monthly" id="monthly" disabled={!isRecurring} />
                          <Label htmlFor="monthly" className="text-sm" style={{ color: !isRecurring ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}>
                            Monthly
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="bi-monthly" id="bi-monthly" disabled={!isRecurring} />
                          <Label htmlFor="bi-monthly" className="text-sm" style={{ color: !isRecurring ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}>
                            Bi-Monthly
                          </Label>
                        </div>
                      </RadioGroup>

                  {showWeeklyDays && isRecurring && (frequency === 'weekly' || frequency === 'bi-weekly') &&
                  <div className="absolute left-0 top-[-120px] w-full border-2 border-emerald-400 rounded-lg p-4 shadow-xl z-20" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
                      <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-slate-900)' }}>Select Days:</p>
                      <div className="space-y-2">
                        {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) =>
                      <div key={day} className="flex items-center space-x-2">
                            <Checkbox
                          id={`day-${day}`}
                          checked={weeklyDays.includes(day)}
                          onCheckedChange={() => handleWeeklyDayToggle(day)} />

                            <Label htmlFor={`day-${day}`} className="text-sm capitalize cursor-pointer" style={{ color: 'var(--text-slate-900)' }}>
                              {day.charAt(0).toUpperCase() + day.slice(1)}
                            </Label>
                          </div>
                      )}
                      </div>
                      <Button
                      type="button"
                      onClick={handleWeeklyDaysDone}
                      size="sm"
                      className="w-full mt-3 bg-emerald-600 hover:bg-emerald-700 text-white">

                        Done
                      </Button>
                    </div>
                  }
                </div>
              </div>
            </form>
          </CardContent>

          <CardFooter className="px-4 py-2 border-t flex items-center justify-end flex-shrink-0" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={onCancel} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSubmit} disabled={!isFormValid} className="bg-emerald-600 hover:bg-emerald-700 gap-2 text-white">
                <Save className="w-3 h-3" />
                {patient ? 'Update Patient' : 'Create Patient'}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </motion.div>
    </div>);

}