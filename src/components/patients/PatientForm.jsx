import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useDevice } from '@/components/utils/DeviceContext';
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Save, UserPlus, Plus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { generatePatientId, validateId, formatId } from '@/components/utils/idGenerator';
import { PhoneInput } from "@/components/ui/phone-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { sortStores } from "@/components/utils/sorting";
import { userHasRole, isAppOwner } from '@/components/utils/userRoles';
import { useAppData } from '@/components/utils/AppDataContext';
import { GoogleAddressAutocomplete } from "@/components/ui/google-address-autocomplete";
import { realtimeSync } from "@/components/utils/realtimeSync";
import { base44 } from "@/api/base44Client";
import { createPatientLocal, updatePatientLocal } from '../utils/entityMutations';
import { offlineDB } from '../utils/offlineDatabase';
import { canAutoFocusFormFields } from '@/components/utils/deviceUtils';
import { globalFilters } from '@/components/utils/globalFilters';
import { abbreviateAddressDirections, normalizeStreetTypes } from '@/components/utils/addressCleaner';

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

// Full address abbreviation: compass directions + street types (both shared utils)
const abbreviateAddress = (address) => {
  if (!address) return '';
  return normalizeStreetTypes(abbreviateAddressDirections(address));
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

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const calculateDistanceKm = (from, to) => {
  const fromLat = toFiniteNumber(from?.latitude);
  const fromLon = toFiniteNumber(from?.longitude);
  const toLat = toFiniteNumber(to?.latitude);
  const toLon = toFiniteNumber(to?.longitude);

  if ([fromLat, fromLon, toLat, toLon].some((value) => value === null)) {
    return null;
  }

  const toRadians = (value) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(toLat - fromLat);
  const dLon = toRadians(toLon - fromLon);
  const a =
  Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) *
  Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return parseFloat((earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));
};

export default function PatientForm({
  patient,
  stores = [],
  onSave,
  onCancel,
  currentUser,
  cities: citiesProp = [],
  allPatients = [],
  returnPatientOnSave = false,
  duplicateMode = null,
  onCreateDuplicate = null,
  forceAppOwnerView = false
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
    email: "",
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
    back_door: false,
    last_delivery_date: ""
  });

  const [isRecurring, setIsRecurring] = useState(false);
  const [frequency, setFrequency] = useState('');
  const [weeklyDays, setWeeklyDays] = useState([]);
  const [showWeeklyDays, setShowWeeklyDays] = useState(false);
  const [isAddressLookupActive, setIsAddressLookupActive] = useState(false);
  const isInitialLoad = useRef(true);
  const allPatientsRef = useRef(allPatients);

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

  // Keep ref in sync with latest allPatients without triggering re-renders
  useEffect(() => {allPatientsRef.current = allPatients;}, [allPatients]);

  // CRITICAL: Generate unique PID immediately on mount for new patients
  useEffect(() => {
    if (!patient) {
      const newPID = generatePatientId(allPatientsRef.current.map((p) => p?.patient_id).filter(Boolean));
      setFormData((prev) => ({ ...prev, patient_id: newPID }));
    }
  }, [patient]);

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
        // CRITICAL: Load the weekly x4 day if it exists
        if (patient.recurring_weekly_x4_day) {
          initialWeeklyDays = [patient.recurring_weekly_x4_day];
        }
      } else if (patient.recurring_bimonthly) {
        initialFrequency = 'bi-monthly';
      } else if (patient.recurring_monthly) {
        initialFrequency = 'monthly';
      } else if (initialWeeklyDays.length > 0) {
        initialFrequency = 'weekly';
      }

      const hasRecurring = initialFrequency !== '';

      // Generate new patient ID for duplicate modes
      let newPID = patient.patient_id || "";
      if (duplicateMode === 'newAddress' || duplicateMode === 'duplicate') {
        newPID = generatePatientId(allPatientsRef.current.map((p) => p.patient_id));
      }

      setFormData({
        patient_id: newPID,
        full_name: duplicateMode === 'duplicate' ? "" : patient.full_name || "",
        email: duplicateMode === 'duplicate' ? "" : patient.email || "",
        phone: duplicateMode === 'duplicate' ? "" : patient.phone || "",
        phone_secondary: duplicateMode === 'duplicate' ? "" : patient.phone_secondary || "",
        address: duplicateMode === 'newAddress' ? "" : abbreviateAddressDirections(patient.address || ""),
        unit_number: duplicateMode === 'newAddress' ? "" : patient.unit_number || "",
        notes: patient.notes || "",
        store_id: patient.store_id || "",
        time_window_start: patient.time_window_start || "",
        time_window_end: patient.time_window_end || "",
        status: patient.status || "active",
        latitude: duplicateMode === 'newAddress' ? null : patient.latitude || null,
        longitude: duplicateMode === 'newAddress' ? null : patient.longitude || null,
        distance_from_store: duplicateMode === 'newAddress' ? null : patient.distance_from_store || null,
        mailbox_ok: patient.mailbox_ok || false,
        call_upon_arrival: patient.call_upon_arrival || false,
        ring_bell: patient.ring_bell || false,
        dont_ring_bell: patient.dont_ring_bell || false,
        back_door: patient.back_door || false,
        last_delivery_date: patient.last_delivery_date || ""
      });

      setIsRecurring(hasRecurring);
      setFrequency(initialFrequency);
      setWeeklyDays(initialWeeklyDays);
      setShowWeeklyDays(false);

      setTimeout(() => {
        isInitialLoad.current = false;
      }, 0);
    }
  }, [patient, duplicateMode]);

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

  const handleAddressSelect = async (addressData) => {
    setIsAddressLookupActive(false);
    const street = addressData.street_number && addressData.route ?
    `${addressData.street_number} ${addressData.route}` :
    addressData.street_address || addressData.full_address || '';
    const abbreviatedAddress = abbreviateAddress(street);
    const prefilledUnit = addressData.unit ? String(addressData.unit).replace(/^#\s*/, '') : formData.unit_number;

    let latitude = toFiniteNumber(addressData.latitude ?? addressData.lat);
    let longitude = toFiniteNumber(addressData.longitude ?? addressData.lng);

    const roundedLatitude = latitude !== null ? parseFloat(latitude.toFixed(7)) : null;
    const roundedLongitude = longitude !== null ? parseFloat(longitude.toFixed(7)) : null;

    // Set address immediately (no haversine placeholder — we wait for Google Distance Matrix)
    setFormData((prev) => ({
      ...prev,
      address: abbreviatedAddress,
      unit_number: prefilledUnit || prev.unit_number,
      latitude: roundedLatitude,
      longitude: roundedLongitude,
      distance_from_store: null
    }));

    // Fetch actual driving distance via Google Distance Matrix (non-blocking)
    if (roundedLatitude && roundedLongitude && cityCenter?.latitude && cityCenter?.longitude) {
      base44.functions.invoke('getGoogleDrivingDistance', {
        originLat: cityCenter.latitude,
        originLng: cityCenter.longitude,
        destLat: roundedLatitude,
        destLng: roundedLongitude
      }).then((res) => {
        const drivingKm = res?.data?.distance_km ?? res?.distance_km;
        if (Number.isFinite(drivingKm)) {
          setFormData((prev) => ({ ...prev, distance_from_store: drivingKm }));
          console.log(`📍 [PatientForm] Driving distance from store: ${drivingKm} km (Google Distance Matrix)`);
        }
      }).catch((err) => {
        console.warn('[PatientForm] Google driving distance fetch failed:', err?.message);
      });
    }

    if (shouldAutoFocusFields) {
      setTimeout(() => {
        unitNumberRef.current?.focus();
      }, 100);
    }
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

  const handleWeeklyX4Click = () => {
    setFrequency('weekly-x4');
    setShowWeeklyDays(true);
  };

  const handleWeeklyDaysDone = () => {
    setShowWeeklyDays(false);
  };

  useEffect(() => {
    if (isInitialLoad.current) {
      return;
    }

    if (frequency !== 'weekly' && frequency !== 'bi-weekly' && frequency !== 'weekly-x4') {
      setShowWeeklyDays(false);
      setWeeklyDays([]);
    }
  }, [frequency]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    let dataToSave = { ...formData };
    dataToSave.latitude = dataToSave.latitude !== null && dataToSave.latitude !== undefined && dataToSave.latitude !== '' ? Number(dataToSave.latitude) : null;
    dataToSave.longitude = dataToSave.longitude !== null && dataToSave.longitude !== undefined && dataToSave.longitude !== '' ? Number(dataToSave.longitude) : null;
    dataToSave.distance_from_store = dataToSave.distance_from_store !== null && dataToSave.distance_from_store !== undefined && dataToSave.distance_from_store !== '' ? Number(dataToSave.distance_from_store) : null;

    console.log('📝 [PatientForm] handleSubmit - dataToSave.patient_id:', dataToSave.patient_id);
    console.log('📝 [PatientForm] handleSubmit - patient:', patient);
    console.log('📝 [PatientForm] handleSubmit - duplicateMode:', duplicateMode);

    // CRITICAL: For new patients, ensure unique PID by city
    if (!patient && !dataToSave.patient_id) {
      console.log('🔄 [PatientForm] Generating new PID for new patient...');
      // Filter allPatients to only those in the user's current city
      const cityId = currentUser?.city_id;
      const patientsInCity = allPatients.filter((p) => {
        if (!cityId) return true; // If no city filter, include all
        const storeForPatient = stores?.find((s) => s?.id === p?.store_id);
        return storeForPatient?.city_id === cityId;
      });

      const existingPIDsInCity = patientsInCity.map((p) => p?.patient_id).filter(Boolean);
      dataToSave.patient_id = generatePatientId(existingPIDsInCity);
      console.log(`🆔 [PatientForm] Generated unique PID: ${dataToSave.patient_id} (city: ${cityId})`);
    } else if (dataToSave.patient_id) {
      console.log('🆔 [PatientForm] Using existing PID:', dataToSave.patient_id);
    } else {
      console.log('⚠️ [PatientForm] WARNING - No PID available!');
    }

    // If distance is still null at save time (e.g. address was typed manually without selecting),
    // fall back to haversine as a last resort so the field is never empty.
    if (!dataToSave.distance_from_store && dataToSave.store_id && dataToSave.latitude && dataToSave.longitude && stores) {
      const assignedStore = stores.find((s) => s && s.id === dataToSave.store_id);
      if (assignedStore?.latitude && assignedStore?.longitude) {
        dataToSave.distance_from_store = calculateDistanceKm(
          { latitude: assignedStore.latitude, longitude: assignedStore.longitude },
          { latitude: dataToSave.latitude, longitude: dataToSave.longitude }
        );
      }
    }

    dataToSave.recurring = isRecurring;
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
          // CRITICAL: Also save the selected day for weekly x4
          if (weeklyDays.length > 0) {
            const day = weeklyDays[0]; // Use the first selected day
            dataToSave.recurring_weekly_x4_day = day;
          }
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
      let savedPatientId;
      let backendPatient;

      // Determine if we're updating or creating
      const isUpdating = patient && patient.id && !duplicateMode;

      // Detect significant location change (>100m) for existing patient updates
      const hasMoved100m = (() => {
        if (!isUpdating) return false;
        const oldLat = Number(patient.latitude);
        const oldLng = Number(patient.longitude);
        const newLat = Number(dataToSave.latitude);
        const newLng = Number(dataToSave.longitude);
        if (!Number.isFinite(oldLat) || !Number.isFinite(oldLng) || !Number.isFinite(newLat) || !Number.isFinite(newLng)) return false;
        const R = 6371000; // metres
        const dLat = (newLat - oldLat) * Math.PI / 180;
        const dLng = (newLng - oldLng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(oldLat * Math.PI / 180) * Math.cos(newLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        const distMetres = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        console.log(`📍 [PatientForm] Location change: ${distMetres.toFixed(1)}m`);
        return distMetres > 100;
      })();

      if (isUpdating) {
        // STEP 1: Update existing patient via offline mutations
        await updatePatientLocal(patient.id, dataToSave);
        savedPatientId = patient.id;
        console.log('  ✅ Updated patient locally');
        const selectedDate = globalFilters.getSelectedDate();
        const selectedDriverId = globalFilters.getSelectedDriverId();
        if (selectedDate && selectedDriverId && selectedDriverId !== 'all') {
          setTimeout(() => {
            base44.functions.invoke('syncRoutePatients', {
              patientId: savedPatientId,
              driverId: selectedDriverId,
              deliveryDate: selectedDate
            }).catch((syncError) => console.warn('⚠️ [PatientForm] Route sync skipped:', syncError?.message || syncError));
          }, 0);
        }

        // STEP 1b: If patient moved >100m, re-optimize the active route
        if (hasMoved100m) {
          console.log('🔄 [PatientForm] Patient moved >100m — triggering route re-optimization');
          const selectedDate = globalFilters.getSelectedDate();
          const selectedDriverId = globalFilters.getSelectedDriverId();
          if (selectedDate && selectedDriverId && selectedDriverId !== 'all') {
            setTimeout(async () => {
              try {
                // Find deliveries for this patient on the active route
                const affectedDeliveries = await base44.entities.Delivery.filter({
                  patient_id: savedPatientId,
                  driver_id: selectedDriverId,
                  delivery_date: selectedDate
                });
                // Clear isNextDelivery and origin lat/lng on affected deliveries
                await Promise.all(affectedDeliveries.map((d) =>
                base44.entities.Delivery.update(d.id, {
                  isNextDelivery: false,
                  first_leg_origin_lat: null,
                  first_leg_origin_lng: null
                }).catch(() => {})
                ));
                console.log(`  🧹 Cleared isNextDelivery + origin on ${affectedDeliveries.length} delivery/deliveries`);

                // Run route optimizer from driver's current GPS location
                const driverAppUsers = await base44.entities.AppUser.filter({ user_id: selectedDriverId });
                const driverAppUser = driverAppUsers?.[0];
                const currentLocation = driverAppUser?.current_latitude && driverAppUser?.current_longitude ?
                { lat: Number(driverAppUser.current_latitude), lon: Number(driverAppUser.current_longitude) } :
                null;

                const optimizeResult = await base44.functions.invoke('optimizeRemainingStops', {
                  driverId: selectedDriverId,
                  deliveryDate: selectedDate,
                  forceFullRemainingRouteOptimization: true,
                  bypassDeduplication: true,
                  bypassDriverStatus: true,
                  triggerSource: 'patient_address_change',
                  ...(currentLocation ? { currentLocation } : {})
                });
                console.log('  ✅ Route re-optimized after patient location change:', optimizeResult?.data?.optimizedCount, 'stops');

                // Dispatch UI update event
                window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                  detail: { triggeredBy: 'patient_address_change', fullReplacement: false }
                }));

                // Trigger polyline regeneration
                if (optimizeResult?.data?.shouldRefreshPolylines) {
                  base44.functions.invoke('purgeAndRegeneratePolylines', {
                    driverId: selectedDriverId,
                    deliveryDate: selectedDate
                  }).catch(() => {});
                  console.log('  🗺️ Polyline regeneration triggered');
                }
              } catch (reoptErr) {
                console.warn('⚠️ [PatientForm] Re-optimization after address change failed:', reoptErr?.message || reoptErr);
              }
            }, 500); // Small delay to allow patient save to propagate
          }
        }

        // Instant local broadcast so UI + offline DB cascade immediately
        try {realtimeSync.broadcast('Patient', 'update', savedPatientId, { id: savedPatientId, ...(patient || {}), ...dataToSave });} catch {}
      } else {
        // STEP 1: Create new patient through shared mutation flow
        console.log('  📝 Creating new patient with realtime sync...');

        backendPatient = await createPatientLocal(dataToSave);
        savedPatientId = backendPatient.id;
        console.log('  ✅ Patient created:', savedPatientId);

        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [backendPatient]);
        console.log('  ✅ Patient synced to offline DB');

        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('patientsUpdated', {
            detail: {
              patients: [backendPatient],
              fromPatientFormCreate: true,
              fullReplacement: false,
              preserveLocalState: true
            }
          }));
        }

        if (returnPatientOnSave) {
          const completePatient = {
            ...backendPatient,
            ...dataToSave,
            id: backendPatient.id
          };
          console.log('  📤 Returning complete patient data with location:', {
            id: completePatient.id,
            full_name: completePatient.full_name,
            latitude: completePatient.latitude,
            longitude: completePatient.longitude,
            distance_from_store: completePatient.distance_from_store,
            store_id: completePatient.store_id
          });
          onSave?.(completePatient);
          onCancel?.();
          return;
        }
      }

      // STEP 2: Broadcast change to other devices (non-blocking)
      if (patient) {
        try {
          const { base44 } = await import('@/api/base44Client');
          await base44.functions.invoke('broadcastEntityChange', {
            entity_name: 'Patient',
            operation: 'update',
            metadata: { id: savedPatientId }
          });
          console.log('  📡 Broadcasted to other devices');
        } catch (broadcastError) {
          console.warn('  ⚠️ Broadcast failed (non-critical):', broadcastError.message);
        }
      }

      // STEP 3: Fetch latest data if updating (for updates, refetch to ensure offline DB is fresh)
      if (patient) {
        const { base44 } = await import('@/api/base44Client');
        console.log('  🔄 Fetching latest patient data...');
        const freshPatient = await base44.entities.Patient.get(savedPatientId);
        console.log('  ✅ Fresh patient data fetched');

        // Update offline database with fresh data
        const { offlineDB } = await import('../utils/offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [freshPatient]);
        console.log('  ✅ Offline DB updated with fresh data');
      }

      // STEP 4: Invalidate cache and trigger UI update
      const { invalidate } = await import('../utils/dataManager');
      invalidate('Patient');
      console.log('  ✅ Cache invalidated');

      // STEP 5: Close form and pass patient data to parent
      if (returnPatientOnSave) {
        const completePatient = {
          ...dataToSave,
          ...backendPatient,
          id: savedPatientId
        };
        onSave?.(completePatient);
        onCancel?.();
      } else {
        if (onSave) {
          const completePatient = {
            ...dataToSave,
            ...backendPatient,
            id: savedPatientId
          };
          await onSave(completePatient);
        }
      }
    } catch (error) {
      console.error('❌ [PatientForm] Save error:', error);
      alert(`Failed to save patient: ${error.message}`);
    }
  };

  const isFormValid = formData.full_name && formData.address && formData.store_id;
  const disableOtherFieldsDuringAddressLookup = isAddressLookupActive;
  const storeSelectRef = useRef(null);
  const addressInputRef = useRef(null);
  const unitNumberRef = useRef(null);
  const shouldAutoFocusFields = canAutoFocusFormFields();
  const { isMobile } = useDevice();

  // Auto-focus store dropdown if no store selected on new patient
  useEffect(() => {
    if (!patient && !formData.store_id && storeSelectRef.current && shouldAutoFocusFields) {
      setTimeout(() => {
        storeSelectRef.current?.click();
      }, 200);
    }
  }, [patient, formData.store_id, shouldAutoFocusFields]);

  // Auto-focus address or name field based on duplicateMode for non-mobile devices
  useEffect(() => {
    if (!shouldAutoFocusFields || !duplicateMode) return;

    if (duplicateMode === 'newAddress' && addressInputRef.current) {
      setTimeout(() => {
        const inputElement = addressInputRef.current instanceof HTMLInputElement ?
        addressInputRef.current :
        addressInputRef.current?.querySelector('input');
        if (inputElement) {
          inputElement.focus();
          inputElement.select?.();
        }
      }, 100);
    } else if (duplicateMode === 'duplicate') {
      // Find the full_name input and focus it
      setTimeout(() => {
        const fullNameInput = document.querySelector('input[id="full_name"]');
        if (fullNameInput) {
          fullNameInput.focus();
          fullNameInput.select?.();
        }
      }, 100);
    }
  }, [duplicateMode, shouldAutoFocusFields]);

  // Auto-focus address field after store is selected (non-mobile only)
  useEffect(() => {
    if (shouldAutoFocusFields && formData.store_id) {
      setTimeout(() => {
        if (addressInputRef.current) {
          const inputElement = addressInputRef.current instanceof HTMLInputElement ?
          addressInputRef.current :
          addressInputRef.current?.querySelector('input');

          if (inputElement) {
            inputElement.focus();
            inputElement.select?.();
          }
        }
      }, 100);
    }
  }, [formData.store_id, shouldAutoFocusFields]);

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
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !isAdmin;
  const isDispatcher = currentUser && userHasRole(currentUser, 'dispatcher') && !isAdmin && !isDriver;
  const dispatcherStoreIds = isDispatcher ? currentUser.store_ids || [] : [];
  // Lock address field for dispatchers and drivers when editing an existing patient
  const isAddressLocked = !!patient && !duplicateMode && (isDispatcher || isDriver) && !isAdmin;
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

  const getWeeklyX4Label = () => {
    if (frequency === 'weekly-x4' && weeklyDays.length > 0) {
      const daysStr = weeklyDays.map((d) => dayAbbrevs[d] || d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
      return `Weekly x4 (${daysStr})`;
    }
    return 'Weekly x4';
  };

  const isPIDValid = formData.patient_id ? validateId(formData.patient_id, 5) : null;
  const pidBackgroundColor = isPIDValid === null ? '' : isPIDValid ? 'bg-emerald-50' : 'bg-red-50';
  const mobileHeaderHeight = typeof document !== 'undefined' ? document.querySelector('[data-mobile-header]')?.offsetHeight || 0 : 0;
  const mobileBottomNavHeight = typeof document !== 'undefined' ? document.querySelector('[data-mobile-bottom-nav]')?.offsetHeight || 0 : 0;
  const mobileFormInsetStyle = isMobile ? {
    top: `${mobileHeaderHeight}px`,
    bottom: `${mobileBottomNavHeight}px`
  } : undefined;

  return (
    <div className={`fixed inset-0 bg-black/60 flex items-center justify-center ${isMobile ? 'p-0 items-start' : 'p-4 pt-20 lg:pt-4'} z-[10020] lg:pl-64`}
    style={mobileFormInsetStyle}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className={`flex flex-col ${isMobile ? 'w-screen rounded-none h-full max-h-full' : 'w-full max-w-[30rem] max-h-[90vh] rounded-lg'}`}>

        <Card className="shadow-xl flex flex-col overflow-hidden" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)', height: '100%', maxHeight: '100%' }}>
          <CardHeader className="px-4 py-2 flex flex-col space-y-1.5 border-b flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl font-bold flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
                <UserPlus className="w-5 h-5 text-emerald-600" />
                {duplicateMode === 'duplicate' || duplicateMode === 'newAddress' ? 'Add New Patient' : patient ? 'Edit Patient' : 'Add New Patient'}
              </CardTitle>
              <Button variant="ghost" size="icon" onClick={onCancel}>
                <X className="w-4 h-4" style={{ color: 'var(--text-slate-700)' }} />
              </Button>
            </div>
          </CardHeader>

          <CardContent className="px-2 py-2 overflow-y-auto flex-1" style={{ background: 'var(--bg-white)' }}>
            <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="space-y-2">
              {/* AppOwner Only: GPS & Distance Section */}
              {(isAppOwner(currentUser) || forceAppOwnerView) &&
              <div className="border-2 px-2 py-2 rounded-[10px] space-y-2" style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-slate-200)' }}>
                  <div className="flex items-center gap-2 mb-1">
                    <Label className="text-xs font-semibold uppercase" style={{ color: 'var(--text-slate-700)' }}>App Owner Controls</Label>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-none w-[75px] space-y-1">
                        <Label htmlFor="patient_id_appowner" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>PID</Label>
                      <Input
                      id="patient_id_appowner"
                      value={formData.patient_id}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(e) => setFormData((prev) => ({ ...prev, patient_id: e.target.value.trim() }))}
                      placeholder="5-chr"
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
                      maxLength={5} />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1" style={{ maxWidth: 'calc(50% - 60px)' }}>
                      <Label htmlFor="latitude" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Latitude</Label>
                      <Input
                      id="latitude"
                      type="number"
                      disabled={disableOtherFieldsDuringAddressLookup}
                      step="any"
                      value={Number.isFinite(formData.latitude) ? formData.latitude : ''}
                      onChange={(e) => setFormData((prev) => ({ ...prev, latitude: toFiniteNumber(e.target.value) }))}
                      placeholder="GPS Lat"
                      className="h-10 md:h-9 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1" style={{ maxWidth: 'calc(50% - 60px)' }}>
                      <Label htmlFor="longitude" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Longitude</Label>
                      <Input
                      id="longitude"
                      type="number"
                      disabled={disableOtherFieldsDuringAddressLookup}
                      step="any"
                      value={Number.isFinite(formData.longitude) ? formData.longitude : ''}
                      onChange={(e) => setFormData((prev) => ({ ...prev, longitude: toFiniteNumber(e.target.value) }))}
                      placeholder="GPS Lon"
                      className="h-10 md:h-9 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                    </div>
                    <div className="flex-none w-[75px] space-y-1">
                      <Label htmlFor="distance" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Dist</Label>
                      <Input
                      id="distance"
                      type="number"
                      disabled={disableOtherFieldsDuringAddressLookup}
                      step="0.01"
                      value={Number.isFinite(formData.distance_from_store) ? formData.distance_from_store : ''}
                      onChange={(e) => setFormData((prev) => ({ ...prev, distance_from_store: toFiniteNumber(e.target.value) }))}
                      placeholder="km"
                      className="h-10 md:h-9 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                    </div>
                  </div>
                  {/* System Record ID + Last Delivery Date - only shown when editing existing patient */}
                  {patient?.id &&
                <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs font-medium" style={{ color: 'var(--text-slate-500)' }}>System Record ID</Label>
                      <div
                      className="px-3 flex items-center rounded-md text-xs font-mono select-all cursor-text overflow-x-auto h-9"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', border: '1px solid var(--border-slate-300)', color: 'var(--text-slate-500)' }}>
                        {patient.id}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="last_delivery_date" className="text-xs font-medium" style={{ color: 'var(--text-slate-500)' }}>Last Delivery Date</Label>
                      <Input
                      id="last_delivery_date"
                      type="date"
                      value={formData.last_delivery_date || ""}
                      onChange={(e) => setFormData((prev) => ({ ...prev, last_delivery_date: e.target.value }))}
                      className="h-9 text-xs"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                    </div>
                  </div>
                }
                </div>
              }

              {/* Container 1: Store/Status/Time Windows */}
              <div className="px-2 py-2 rounded-[10px] space-y-2" style={{ background: 'var(--bg-slate-100)' }}>
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-6 space-y-1">
                    <Label htmlFor="store_id" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Assigned Store *</Label>
                    <Select
                      value={formData.store_id}
                      onValueChange={(value) => setFormData((prev) => ({ ...prev, store_id: value }))}
                      disabled={isStoreDisabled || disableOtherFieldsDuringAddressLookup}>
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

                  <div className="col-span-6 space-y-1">
                    <Label htmlFor="status" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Status</Label>
                    <Select
                      value={formData.status}
                      onValueChange={(value) => setFormData((prev) => ({ ...prev, status: value }))}
                      disabled={!formData.store_id || disableOtherFieldsDuringAddressLookup}>
                      <SelectTrigger className="h-10 md:h-9 text-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-[200px] overflow-y-auto z-[99999]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="inactive">Inactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                </div>

    

              {/* Container 3: Address/Unit, Name/Phone, and Time Windows */}
              <div className="rounded-[10px] space-y-2 pr-2 pb-2 pl-2 pt-2" style={{ background: 'var(--bg-slate-100)', opacity: !formData.store_id ? '0.5' : '1', pointerEvents: !formData.store_id ? 'none' : 'auto' }}>
                <div className="grid grid-cols-12 gap-x-2 gap-y-0">
                  {/* Label row — + New Address is absolute so it adds zero height */}
                  <div className="col-span-8 relative pb-3" style={{ height: '2rem' }}>
                    <Label htmlFor="address" className="text-sm font-medium leading-none" style={{ color: 'var(--text-slate-900)' }}>Address *</Label>
                    {patient && !duplicateMode && onCreateDuplicate &&
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => onCreateDuplicate(patient)}
                      onKeyDown={(e) => e.key === 'Enter' && onCreateDuplicate(patient)}
                      className="absolute right-0 top-0 cursor-pointer select-none"
                      style={{ lineHeight: '1.25rem' }}>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border border-emerald-300 transition-colors">
                        Change Address
                      </span>
                    </span>
                    }
                  </div>
                  <div className="col-span-4 pb-3" style={{ height: '2rem' }}>
                    <Label htmlFor="unit_number" className="text-sm font-medium leading-none" style={{ color: 'var(--text-slate-900)' }}>Unit/Apt #</Label>
                  </div>
                  {/* Input row */}
                  <div className="col-span-8">
                    <GoogleAddressAutocomplete
                      ref={addressInputRef}
                      value={formData.address}
                      onChange={(value) => !isAddressLocked && setFormData((prev) => ({ ...prev, address: value }))}
                      onAddressSelect={handleAddressSelect}
                      onSearchStateChange={!isAddressLocked ? setIsAddressLookupActive : undefined}
                      cityCenter={cityCenter}
                      placeholder="Start typing address..."
                      className="h-10 md:h-9 text-sm"
                      disabled={isAddressLocked} />
                  </div>
                  <div className="col-span-4">
                    <Input
                      ref={unitNumberRef}
                      id="unit_number"
                      disabled={disableOtherFieldsDuringAddressLookup}
                      value={formData.unit_number}
                      onChange={(e) => setFormData((prev) => ({ ...prev, unit_number: e.target.value }))}
                      className={`h-10 md:h-9 text-sm ${duplicateMode === 'duplicate' ? 'ring-2 ring-amber-400' : ''}`}
                      style={{ background: duplicateMode === 'duplicate' ? 'var(--bg-amber-50)' : 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>
                </div>

                {/* Row 1: Full Name + Email (50/50) */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="full_name" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Full Name *</Label>
                    <Input
                      id="full_name"
                      value={formData.full_name}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(e) => setFormData((prev) => ({ ...prev, full_name: capitalizeName(e.target.value) }))}
                      required
                      className={`h-10 md:h-9 text-sm ${duplicateMode === 'duplicate' ? 'ring-2 ring-amber-400' : ''}`}
                      style={{ background: duplicateMode === 'duplicate' ? 'var(--bg-amber-50)' : 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="email" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Email Address</Label>
                    <Input
                      id="email"
                      type="email"
                      value={formData.email || ''}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                      placeholder="Email address"
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>
                </div>

                {/* Row 2: Phone + Alt. Phone (50/50) */}
                <div className="grid grid-cols-2 gap-2">
                  <div className={`space-y-1 ${duplicateMode === 'duplicate' ? 'ring-2 ring-amber-400 rounded p-1' : ''}`}>
                    <Label htmlFor="phone" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Phone Number</Label>
                    <PhoneInput
                      id="phone"
                      value={formData.phone}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(value) => setFormData((prev) => ({ ...prev, phone: value }))}
                      placeholder="Phone number"
                      className="h-10 md:h-9 text-sm"
                      style={{ background: duplicateMode === 'duplicate' ? 'var(--bg-amber-50)' : 'var(--bg-white)' }} />
                  </div>
                  <div className={`space-y-1 ${duplicateMode === 'duplicate' ? 'ring-2 ring-amber-400 rounded p-1' : ''}`}>
                    <Label htmlFor="phone_secondary" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Alt. Phone</Label>
                    <PhoneInput
                      id="phone_secondary"
                      value={formData.phone_secondary}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(value) => setFormData((prev) => ({ ...prev, phone_secondary: value }))}
                      placeholder="Alt. phone"
                      className="h-10 md:h-9 text-sm"
                      style={{ background: duplicateMode === 'duplicate' ? 'var(--bg-amber-50)' : 'var(--bg-white)' }} />
                  </div>
                </div>

                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-6 space-y-1">
                    <Label htmlFor="time_window_start" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Deliver After</Label>
                    <Input
                      id="time_window_start"
                      type="time"
                      value={formData.time_window_start}
                      onChange={(e) => setFormData((prev) => ({ ...prev, time_window_start: e.target.value }))}
                      disabled={!formData.store_id || disableOtherFieldsDuringAddressLookup}
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>

                  <div className="col-span-6 space-y-1">
                    <Label htmlFor="time_window_end" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Deliver Before</Label>
                    <Input
                      id="time_window_end"
                      type="time"
                      value={formData.time_window_end}
                      onChange={(e) => setFormData((prev) => ({ ...prev, time_window_end: e.target.value }))}
                      disabled={!formData.store_id || disableOtherFieldsDuringAddressLookup}
                      className="h-10 md:h-9 text-sm"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                  </div>
                </div>
              </div>

              {/* Container 4: Patient Notes */}
              <div className="px-1 py-1 rounded-[10px]" style={{ background: 'var(--bg-slate-100)', opacity: !formData.store_id || disableOtherFieldsDuringAddressLookup ? '0.5' : '1', pointerEvents: !formData.store_id || disableOtherFieldsDuringAddressLookup ? 'none' : 'auto' }}>
                <div className="px-2 py-2 space-y-1">
                  <Label htmlFor="notes" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Patient Notes</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    disabled={disableOtherFieldsDuringAddressLookup}
                    onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                    placeholder="Special delivery instructions, preferences, etc."
                    className="h-24 md:h-32 text-sm resize-none"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2" style={{ opacity: !formData.store_id || disableOtherFieldsDuringAddressLookup ? '0.5' : '1', pointerEvents: !formData.store_id || disableOtherFieldsDuringAddressLookup ? 'none' : 'auto' }}>
                    <div className="px-3 py-2 rounded-[10px]" style={{ background: 'var(--bg-slate-200)' }}>
                      <div className="border-b pb-2 mb-3" style={{ borderColor: 'var(--border-slate-300)' }}>
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Preferences</h3>
                      </div>

                  <div className="space-y-3">
                    <CheckboxField
                      id="mailbox_ok"
                      label="Mailbox OK"
                      checked={formData.mailbox_ok}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, mailbox_ok: checked }))} />

                  <CheckboxField
                      id="ring_bell"
                      label="Ring Bell"
                      checked={formData.ring_bell}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, ring_bell: checked }))} />

                  <CheckboxField
                      id="back_door"
                      label="Back Door"
                      checked={formData.back_door}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, back_door: checked }))} />

                  <CheckboxField
                      id="call_upon_arrival"
                      label="Call Upon Arrival"
                      checked={formData.call_upon_arrival}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, call_upon_arrival: checked }))} />

                    <CheckboxField
                      id="dont_ring_bell"
                      label="DON'T Ring Bell"
                      checked={formData.dont_ring_bell}
                      disabled={disableOtherFieldsDuringAddressLookup}
                      onChange={(checked) => setFormData((prev) => ({ ...prev, dont_ring_bell: checked }))} />
                  </div>
                </div>

                <div className="px-3 py-2 rounded-[10px] relative" style={{ background: 'var(--bg-slate-200)' }}>
                  <div className="border-b pb-2" style={{ borderColor: 'var(--border-slate-300)' }}>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                        id="recurring"
                        checked={isRecurring}
                        disabled={disableOtherFieldsDuringAddressLookup}
                        onCheckedChange={handleRecurringChange} />
                          <Label htmlFor="recurring" className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                            Recurring
                          </Label>
                        </div>
                      </div>

                      <RadioGroup
                    value={frequency}
                    onValueChange={setFrequency}
                    disabled={!isRecurring || disableOtherFieldsDuringAddressLookup}>

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
                          <RadioGroupItem
                        value="weekly-x4"
                        id="weekly-x4"
                        disabled={!isRecurring}
                        onClick={(e) => {
                          if (isRecurring) {
                            e.preventDefault();
                            handleWeeklyX4Click();
                          }
                        }} />
                          <Label
                        htmlFor="weekly-x4"
                        className="text-sm cursor-pointer"
                        style={{ color: !isRecurring ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}
                        onClick={(e) => {
                          if (isRecurring) {
                            e.preventDefault();
                            handleWeeklyX4Click();
                          }
                        }}>
                            {getWeeklyX4Label()}
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

                  {showWeeklyDays && isRecurring && (frequency === 'weekly' || frequency === 'bi-weekly' || frequency === 'weekly-x4') &&
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
              <Button type="button" onClick={handleSubmit} disabled={!isFormValid || disableOtherFieldsDuringAddressLookup} className="bg-emerald-600 hover:bg-emerald-700 gap-2 text-white">
                <Save className="w-3 h-3" />
                {returnPatientOnSave ? 'Save & Return' : patient ? 'Update Patient' : 'Create Patient'}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </motion.div>
    </div>);

}