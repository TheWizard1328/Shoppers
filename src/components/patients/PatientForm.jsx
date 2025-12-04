import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Save, UserPlus, MapPin } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { generatePatientId, validateId, formatId } from '@/components/utils/idGenerator';
import { PhoneInput } from "@/components/ui/phone-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { sortStores } from "@/components/utils/sorting";
import { userHasRole } from '@/components/utils/userRoles';
import { base44 } from "@/api/base44Client";
import { useAppData } from '@/components/utils/AppDataContext';

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
  cities = [],
  allPatients = [],
  returnPatientOnSave = false
}) {
  const { setIsFormOverlayOpen } = useAppData();

  const [formData, setFormData] = useState({
    patient_id: "",
    full_name: "",
    phone: "",
    address: "",
    unit_number: "",
    notes: "",
    store_id: "",
    time_window_start: "",
    time_window_end: "",
    status: "active",
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

  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [deviceLocation, setDeviceLocation] = useState(null);
  const addressInputRef = useRef(null);
  const suggestionsRef = useRef(null);
  const hasUserTypedAddress = useRef(false);

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setDeviceLocation({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
          });
        },
        (error) => {
          console.log('Geolocation not available:', error);
        }
      );
    }
  }, []);

  const getSearchLocation = useCallback(() => {
    if (deviceLocation) {
      return deviceLocation;
    }

    if (currentUser?.home_latitude && currentUser?.home_longitude) {
      return {
        latitude: currentUser.home_latitude,
        longitude: currentUser.home_longitude
      };
    }

    if (formData.store_id) {
      const selectedStore = stores.find((s) => s.id === formData.store_id);
      if (selectedStore?.latitude && selectedStore?.longitude) {
        return {
          latitude: selectedStore.latitude,
          longitude: selectedStore.longitude
        };
      }
    }

    if (currentUser?.city_id) {
      const userCity = cities.find((c) => c.id === currentUser.city_id);
      if (userCity?.latitude && userCity?.longitude) {
        return {
          latitude: userCity.latitude,
          longitude: userCity.longitude
        };
      }
    }

    return null;
  }, [deviceLocation, currentUser, formData.store_id, stores, cities]);

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
        address: patient.address || "",
        unit_number: patient.unit_number || "",
        notes: patient.notes || "",
        store_id: patient.store_id || "",
        time_window_start: patient.time_window_start || "",
        time_window_end: patient.time_window_end || "",
        status: patient.status || "active",
        mailbox_ok: patient.mailbox_ok || false,
        call_upon_arrival: patient.call_upon_arrival || false,
        ring_bell: patient.ring_bell || false,
        dont_ring_bell: patient.dont_ring_bell || false,
        back_door: patient.back_door || false
      });

      setIsRecurring(hasRecurring);
      setFrequency(initialFrequency);
      setWeeklyDays(initialWeeklyDays);
      setShowWeeklyDays(false); // Don't show popup on form load
      
      // Mark initial load complete after state is set
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
    const handleClickOutside = (event) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target) &&
        addressInputRef.current &&
        !addressInputRef.current.contains(event.target)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    const fetchAddressSuggestions = async (input) => {
      if (input.length < 3) {
        setAddressSuggestions([]);
        setShowSuggestions(false);
        return;
      }

      setIsLoadingSuggestions(true);
      try {
        const location = getSearchLocation();
        const params = { input };

        if (location) {
          params.latitude = location.latitude;
          params.longitude = location.longitude;
        }

        const response = await base44.functions.invoke('googlePlacesAutocomplete', params);
        if (response.data && response.data.predictions) {
          setAddressSuggestions(response.data.predictions);
          setShowSuggestions(response.data.predictions.length > 0);
        }
      } catch (error) {
        console.error('Error fetching address suggestions:', error);
        setAddressSuggestions([]);
        setShowSuggestions(false);
      } finally {
        setIsLoadingSuggestions(false);
      }
    };

    const timeoutId = setTimeout(() => {
      if (formData.address && hasUserTypedAddress.current) {
        fetchAddressSuggestions(formData.address);
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [formData.address, getSearchLocation]);

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

  const handleAddressSelect = async (suggestion) => {
    hasUserTypedAddress.current = false;
    try {
      const response = await base44.functions.invoke('googlePlaceDetails', {
        place_id: suggestion.place_id
      });

      if (response.data) {
        const { address } = response.data;
        const abbreviatedAddress = abbreviateAddress(address || suggestion.description);

        setFormData((prev) => ({
          ...prev,
          address: abbreviatedAddress
        }));
      }
    } catch (error) {
      console.error('Error fetching place details:', error);
      const abbreviatedAddress = abbreviateAddress(suggestion.description);
      setFormData((prev) => ({
        ...prev,
        address: abbreviatedAddress
      }));
    }

    setShowSuggestions(false);
    setAddressSuggestions([]);
  };

  const handleAddressChange = (e) => {
    const value = e.target.value;
    hasUserTypedAddress.current = true;
    setFormData((prev) => ({ ...prev, address: value }));
  };

  const handleAddressBlur = () => {
    if (formData.address) {
      const abbreviatedAddress = abbreviateAddress(formData.address);
      if (abbreviatedAddress !== formData.address) {
        setFormData((prev) => ({
          ...prev,
          address: abbreviatedAddress
        }));
      }
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

  const handleWeeklyDaysDone = () => {
    setShowWeeklyDays(false);
  };

  useEffect(() => {
    // Don't clear weeklyDays during initial patient data load
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

    if (returnPatientOnSave && !patient) {
      onSave(dataToSave, true);
    } else {
      onSave(dataToSave);
    }
  };

  const isFormValid = formData.full_name && formData.address && formData.store_id;

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const target = e.target;
      if (target.tagName === 'TEXTAREA') {
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

        <Card className="bg-white border-slate-200 shadow-xl flex flex-col overflow-hidden">
          <CardHeader className="px-4 py-2 flex flex-col space-y-1.5 border-b border-slate-200 flex-shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-emerald-600" />
                {patient ? 'Edit Patient' : 'Add New Patient'}
              </CardTitle>
              <Button variant="ghost" size="icon" onClick={onCancel}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </CardHeader>

          <CardContent className="px-2 py-2 overflow-y-auto flex-1">
            <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="space-y-2">
              {/* Container 1: Store/ID/Status and Time Windows */}
              <div className="bg-slate-100 px-2 py-2 rounded-[10px] space-y-2">
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="store_id" className="text-sm font-medium">Assigned Store *</Label>
                    <Select
                      value={formData.store_id}
                      onValueChange={(value) => setFormData((prev) => ({ ...prev, store_id: value }))}
                      disabled={isStoreDisabled}>
                      <SelectTrigger className="h-10 md:h-9 text-sm border-slate-300 bg-white">
                        <SelectValue placeholder="Select store..." />
                      </SelectTrigger>
                      <SelectContent className="max-h-[300px] overflow-y-auto z-[99999]">
                        {availableStores.map((store) =>
                          <SelectItem key={store.id} value={store.id}>
                            {store.name}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="patient_id" className="text-sm font-medium">Patient ID (PID) *</Label>
                    <Input
                      id="patient_id"
                      value={formData.patient_id}
                      onChange={(e) => setFormData((prev) => ({ ...prev, patient_id: e.target.value.trim() }))}
                      placeholder="5-char ID"
                      className={`h-10 md:h-9 text-sm border-slate-300 bg-white ${pidBackgroundColor}`}
                      maxLength={5} />
                    {formData.patient_id && !validateId(formData.patient_id, 5) &&
                      <p className="text-xs text-red-600">Must be 5 chars</p>
                    }
                  </div>

                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="status" className="text-sm font-medium">Status</Label>
                    <Select
                      value={formData.status}
                      onValueChange={(value) => setFormData((prev) => ({ ...prev, status: value }))}>
                      <SelectTrigger className="h-10 md:h-9 text-sm border-slate-300 bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-[200px] overflow-y-auto">
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="inactive">Inactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-6 space-y-1">
                    <Label htmlFor="time_window_start" className="text-sm font-medium">Deliver After</Label>
                    <Input
                      id="time_window_start"
                      type="time"
                      value={formData.time_window_start}
                      onChange={(e) => setFormData((prev) => ({ ...prev, time_window_start: e.target.value }))}
                      className="h-10 md:h-9 text-sm border-slate-300 bg-white" />
                  </div>

                  <div className="col-span-6 space-y-1">
                    <Label htmlFor="time_window_end" className="text-sm font-medium">Deliver Before</Label>
                    <Input
                      id="time_window_end"
                      type="time"
                      value={formData.time_window_end}
                      onChange={(e) => setFormData((prev) => ({ ...prev, time_window_end: e.target.value }))}
                      className="h-10 md:h-9 text-sm border-slate-300 bg-white" />
                  </div>
                </div>
              </div>

              {/* Container 2: Name/Phone and Address/Unit */}
              <div className="bg-slate-100 px-2 py-2 rounded-[10px] space-y-2">
                <div className="grid grid-cols-12 gap-2">
                  <div className="px-1 col-span-8 space-y-1">
                    <Label htmlFor="full_name" className="text-sm font-medium">Full Name *</Label>
                    <Input
                      id="full_name"
                      value={formData.full_name}
                      onChange={(e) => setFormData((prev) => ({ ...prev, full_name: capitalizeName(e.target.value) }))}
                      required
                      className="h-10 md:h-9 text-sm border-slate-300 bg-white" />
                  </div>

                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="phone" className="text-sm font-medium">Phone Number</Label>
                    <PhoneInput
                      id="phone"
                      value={formData.phone}
                      onChange={(value) => setFormData((prev) => ({ ...prev, phone: value }))}
                      placeholder="Phone number"
                      className="h-10 md:h-9 text-sm border-slate-300 bg-white" />
                  </div>
                </div>

                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-8 space-y-1 relative">
                    <Label htmlFor="address" className="text-sm font-medium">Address *</Label>
                    <div className="relative">
                      <Input
                        ref={addressInputRef}
                        id="address"
                        value={formData.address}
                        onChange={handleAddressChange}
                        onBlur={handleAddressBlur}
                        onFocus={() => {
                          if (addressSuggestions.length > 0) {
                            setShowSuggestions(true);
                          }
                        }}
                        required
                        placeholder="Start typing address..."
                        className="h-10 md:h-9 text-sm border-slate-300 bg-white pr-8" />
                      <MapPin className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    </div>

                    {showSuggestions && (addressSuggestions.length > 0 || isLoadingSuggestions) &&
                      <div
                        ref={suggestionsRef}
                        className="absolute z-[100000] w-full mt-1 bg-white border border-slate-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                        {isLoadingSuggestions ?
                          <div className="p-3 text-sm text-slate-500">Loading suggestions...</div> :

                          addressSuggestions.map((suggestion, index) =>
                            <div
                              key={index}
                              onClick={() => handleAddressSelect(suggestion)}
                              className="p-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0 text-sm">
                              <div className="flex items-start gap-2">
                                <MapPin className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                                <span className="text-slate-700">{suggestion.description}</span>
                              </div>
                            </div>
                          )
                        }
                      </div>
                    }
                  </div>

                  <div className="col-span-4 space-y-1">
                    <Label htmlFor="unit_number" className="text-sm font-medium">Unit/Apt #</Label>
                    <Input
                      id="unit_number"
                      value={formData.unit_number}
                      onChange={(e) => setFormData((prev) => ({ ...prev, unit_number: e.target.value }))}
                      className="h-10 md:h-9 text-sm border-slate-300 bg-white" />
                  </div>
                </div>
              </div>

              {/* Container 3: Patient Notes */}
              <div className="bg-slate-100 px-1 py-1 rounded-[10px]">
                <div className="px-2 py-2 space-y-1">
                  <Label htmlFor="notes" className="text-sm font-medium">Patient Notes</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                    placeholder="Special delivery instructions, preferences, etc."
                    className="h-24 md:h-32 text-sm border-slate-300 bg-white resize-none" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-100 px-3 py-2 rounded-[10px]">
                  <div className="border-b border-slate-200 pb-2 mb-3">
                    <h3 className="text-sm font-semibold text-slate-700">Delivery Preferences</h3>
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

                <div className="bg-slate-100 px-3 py-2 rounded-[10px] relative">
                  <div className="border-b border-slate-200 pb-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="recurring"
                        checked={isRecurring}
                        onCheckedChange={handleRecurringChange} />
                      <Label htmlFor="recurring" className="text-sm font-medium">
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
                      <Label htmlFor="daily" className={`text-sm ${!isRecurring ? 'text-slate-400' : ''}`}>
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
                        className={`text-sm cursor-pointer ${!isRecurring ? 'text-slate-400' : ''}`}
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
                        className={`text-sm cursor-pointer ${!isRecurring ? 'text-slate-400' : ''}`}
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
                      <Label htmlFor="weekly-x4" className={`text-sm ${!isRecurring ? 'text-slate-400' : ''}`}>
                        Weekly x4
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="monthly" id="monthly" disabled={!isRecurring} />
                      <Label htmlFor="monthly" className={`text-sm ${!isRecurring ? 'text-slate-400' : ''}`}>
                        Monthly
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="bi-monthly" id="bi-monthly" disabled={!isRecurring} />
                      <Label htmlFor="bi-monthly" className={`text-sm ${!isRecurring ? 'text-slate-400' : ''}`}>
                        Bi-Monthly
                      </Label>
                    </div>
                  </RadioGroup>

                  {showWeeklyDays && isRecurring && (frequency === 'weekly' || frequency === 'bi-weekly') &&
                    <div className="absolute left-0 top-[-120px] w-full bg-white border-2 border-emerald-400 rounded-lg p-4 shadow-xl z-20">
                      <p className="text-sm font-semibold text-slate-700 mb-3">Select Days:</p>
                      <div className="space-y-2">
                        {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) =>
                          <div key={day} className="flex items-center space-x-2">
                            <Checkbox
                              id={`day-${day}`}
                              checked={weeklyDays.includes(day)}
                              onCheckedChange={() => handleWeeklyDayToggle(day)} />

                            <Label htmlFor={`day-${day}`} className="text-sm capitalize cursor-pointer">
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

          <CardFooter className="bg-slate-50 px-4 py-2 border-t border-slate-200 flex items-center justify-end flex-shrink-0">
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={onCancel} className="bg-white">
                Cancel
              </Button>
              <Button type="button" onClick={handleSubmit} disabled={!isFormValid} className="bg-emerald-600 hover:bg-emerald-700 gap-2">
                <Save className="w-3 h-3" />
                {patient ? 'Update Patient' : 'Create Patient'}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </motion.div>
    </div>);

}