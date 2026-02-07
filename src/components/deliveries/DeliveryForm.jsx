import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { X, Save, Package, Search, Clock, Plus, Trash2, CheckCircle, Edit2, Camera, Phone, Bell, BellOff, Mailbox, StickyNote, Copy, MapPin, AlertCircle } from "lucide-react";
import { formatPhoneNumber } from '../utils/phoneFormatter';
import PatientMatchPopup from './PatientMatchPopup';
import { sortUsers } from "../utils/sorting";
import { Badge } from "@/components/ui/badge";
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { generateStopId, formatId } from '../utils/idGenerator';
import { getDriverDisplayName, getDriverNameForStorage } from '../utils/driverUtils';
import { PhoneInput } from "@/components/ui/phone-input";
import { determineDeliveryAMPM, getStoreAssignedTimeSlot, getPickupStopIdForDelivery, calculateInitialDeliveryTimeStart } from '../utils/ampmUtils';
import { base44 } from "@/api/base44Client";
import { getStoreColor, hexToRgba } from '../utils/colorGenerator';
import { useAppData } from '../utils/AppDataContext';
import { getUserAgentInfo } from '../utils/deviceUtils';
import { shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { sendDeliveryMessage } from '../utils/deliveryMessaging';
import { reorderStops } from '../utils/stopReorderer';
import {
  createPatient as createPatientLocal,
  updatePatient as updatePatientLocal,
  createDelivery as createDeliveryLocal,
  updateDelivery as updateDeliveryLocal,
  deleteDelivery as deleteDeliveryLocal,
  batchCreateDeliveries as batchCreateDeliveriesLocal,
  setBatchFormSaving
} from '../utils/entityMutations';
import DeliveryFormStaged from './DeliveryFormStaged';
import { checkPayrollLock } from '../utils/payrollLockManager';

const CheckboxField = ({ id, label, checked, onChange, disabled }) => (
  <div className="flex items-center space-x-2">
    <Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={id} className={`text-sm font-medium leading-none ${disabled ? 'text-slate-400' : ''}`}>
      {label}
    </Label>
  </div>
);


const statusColorMap = {
  'Staged': 'text-purple-700 bg-purple-100 border-purple-200',
  'pending': 'text-slate-500 bg-slate-100 border-slate-200',
  'Ready For Pickup': 'text-amber-700 bg-amber-100 border-amber-200',
  'in_transit': 'text-blue-700 bg-blue-100 border-blue-100',
  'completed': 'text-emerald-700 bg-emerald-100 border-emerald-200',
  'failed': 'text-red-700 bg-red-100 border-red-200',
  'cancelled': 'text-red-700 bg-red-100 border-red-200',
  'en_route': 'text-blue-700 bg-blue-100 border-blue-100',
  'returned': 'text-red-700 bg-red-100 border-red-200'
};

const getStatusColorClass = (status) => statusColorMap[status] || 'text-slate-700 bg-slate-100 border-slate-200';

const userHasRole = (user, role) => {
  if (!user || !role) return false;
  if (Array.isArray(user.app_roles)) return user.app_roles.includes(role);
  if (user.app_role === role) return true;
  return false;
};

const sortStores = (stores) => {
  if (!stores) return [];
  return [...stores].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
  Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export default function DeliveryForm({
  delivery,
  patients,
  stores,
  drivers,
  onSave,
  onCancel,
  initialPatientId,
  suggestedDate,
  currentUser,
  allDeliveries,
  initialDriverId,
  defaultToPickupMode = false,
  closeOnSave = false,
  onCreatePatient
}) {
  const { setIsFormOverlayOpen } = useAppData();
  
  // CRITICAL: Load fresh stores from offline DB on mount to prevent "Store information missing" error
  const [freshStores, setFreshStores] = useState(stores);
  
  useEffect(() => {
    const loadFreshStores = async () => {
      try {
        const { offlineDB } = await import('../utils/offlineDatabase');
        const offlineStores = await offlineDB.getAll(offlineDB.STORES.STORES);
        
        if (offlineStores && offlineStores.length > 0) {
          console.log('✅ [DeliveryForm] Loaded fresh stores from offline DB:', offlineStores.length);
          setFreshStores(offlineStores);
        } else {
          console.log('📦 [DeliveryForm] Using stores from props:', stores?.length || 0);
          setFreshStores(stores);
        }
      } catch (error) {
        console.warn('⚠️ [DeliveryForm] Failed to load stores from offline DB:', error);
        setFreshStores(stores);
      }
    };
    
    loadFreshStores();
  }, []);

  const allDrivers = useMemo(() => {
    // Layout already filters drivers correctly via getActiveDriversForCity
    // Just ensure they have user_name - no additional role filtering needed
    const sorted = sortUsers(drivers || []);
    return sorted.filter((driver) => driver && driver.user_name);
  }, [drivers]);

  const [formData, setFormData] = useState(() => {
    const initialState = {
      patient_id: "",
      delivery_date: suggestedDate || format(new Date(), 'yyyy-MM-dd'),
      delivery_time_start: "", delivery_time_end: "", delivery_time_eta: "",
      time_window_start: "", time_window_end: "", status: "Staged",
      driver_name: "", driver_id: "", prescription_number: "",
      delivery_instructions: "", delivery_notes: "",
      cod_total_amount_required: 0, cod_payments: [],
      cod_payment_type: "No Payment", cod_amount: "",
      tracking_number: "", delivery_stop_id: "", stop_id: "", puid: "",
      paid_km_override: null,
      patient_name: "", patient_phone: "", unit_number: "", store_phone: "", store_id: "",
      mailbox_ok: false, call_upon_arrival: false, ring_bell: false,
      dont_ring_bell: false, back_door: false, signature_needed: false,
      fridge_item: false, oversized: false, after_hours_pickup: false, no_charge: false, extra_time: 0,
      recurring: false, recurring_daily: false,
      recurring_weekly_mon: false, recurring_weekly_tue: false, recurring_weekly_wed: false,
      recurring_weekly_thu: false, recurring_weekly_fri: false, recurring_weekly_sat: false,
      recurring_weekly_sun: false, recurring_biweekly: false, recurring_weekly_x4: false,
      recurring_monthly: false, recurring_bimonthly: false
    };

    if (!delivery && currentUser && stores && drivers) {
      const isDriver = userHasRole(currentUser, 'driver');
      const isDispatcher = userHasRole(currentUser, 'dispatcher');
      const isAdmin = userHasRole(currentUser, 'admin');

      if (isDriver && !isAdmin && !isDispatcher) {
        const currentUserDriver = allDrivers.find((d) => d.id === currentUser.id);
        if (currentUserDriver) {
          initialState.driver_id = currentUser.id;
          initialState.driver_name = getDriverNameForStorage(currentUserDriver);
        }
      } else if (isDispatcher && !isDriver && !isAdmin) {
        const dispatcherStoreIds = currentUser.store_ids || [];
        if (dispatcherStoreIds.length === 1) {
          const dispatcherStore = stores.find((s) => s && s.id === dispatcherStoreIds[0]);
          if (dispatcherStore) {
            const selectedDate = new Date(initialState.delivery_date + 'T00:00:00');
            const dayOfWeek = selectedDate.getDay();
            let driverIdField = '';
            if (dayOfWeek === 6) {
              driverIdField = 'saturday_am_driver_id';
            } else if (dayOfWeek === 0) {
              driverIdField = 'sunday_am_driver_id';
            } else {
              driverIdField = 'weekday_am_driver_id';
            }
            const driverId = dispatcherStore[driverIdField];
            if (driverId) {
              const driver = drivers.find((d) => d && d.id === driverId);
              if (driver) {
                initialState.driver_id = driverId;
                initialState.driver_name = getDriverNameForStorage(driver);
              }
            }
          }
        }
      }
    }

    return initialState;
  });

  const [patientSearch, setPatientSearch] = useState("");
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [selectedPatientIds, setSelectedPatientIds] = useState(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedPickupOption, setSelectedPickupOption] = useState('');
  const [isPickupMode, setIsPickupMode] = useState(defaultToPickupMode);
  const [selectedStoreForPickup, setSelectedStoreForPickup] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [highlightedPatientIndex, setHighlightedPatientIndex] = useState(-1);
  const patientSearchInputRef = useRef(null);
  const codAmountInputRef = useRef(null);
  const addPatientButtonRef = useRef(null);
  const patientNameInputRef = useRef(null);
  const patientAddressInputRef = useRef(null);
  
  // State for creating new patient from existing patient data
  const [newPatientMode, setNewPatientMode] = useState(null); // 'duplicate' | 'new_address' | null
  const [stagedDeliveries, setStagedDeliveries] = useState([]);
  const [projectedDeliveries, setProjectedDeliveries] = useState([]);
  const [isLoadingPredictions, setIsLoadingPredictions] = useState(false);
  const [predictionTrigger, setPredictionTrigger] = useState(0);
  const [showDayPopup, setShowDayPopup] = useState(false);
  const [activeRecurringType, setActiveRecurringType] = useState(null);
  const [editingStagedId, setEditingStagedId] = useState(null);
  const [completionTime, setCompletionTime] = useState(() => {
    if (delivery?.actual_delivery_time) {
      return format(new Date(delivery.actual_delivery_time), 'HH:mm');
    }
    return format(new Date(), 'HH:mm');
  });
  const [showStagedPanel, setShowStagedPanel] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState({ show: false, staged: null });
  const [isDeletingPending, setIsDeletingPending] = useState(false);
  const [isPatientFormOpen, setIsPatientFormOpen] = useState(false);
  const { deviceType } = getUserAgentInfo();
  const isMobileDevice = deviceType === 'Mobile';
  const hasLoadedPending = useRef(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMatches, setScanMatches] = useState([]);
  const [showMatchPopup, setShowMatchPopup] = useState(false);
  const [extractedData, setExtractedData] = useState(null);
  const [hasPendingDeletes, setHasPendingDeletes] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [isPayrollLocked, setIsPayrollLocked] = useState(false);
  const [payrollLockMessage, setPayrollLockMessage] = useState(null);

  // Camera state
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [showCameraOverlay, setShowCameraOverlay] = useState(false);


  // Responsive layout state
  const [screenWidth, setScreenWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024);
  const [screenHeight, setScreenHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 768);
  const formRef = useRef(null);

  // Desktop form width threshold (max-w-4xl = 896px + padding)
  const DESKTOP_FORM_WIDTH = 825;

  // Rule 1: Use mobile layout (hidden staged panel) only if screen width < desktop form width
  // This is PURELY screen-width based - wide mobile screens should show the staged panel
  const useMobileLayout = screenWidth < DESKTOP_FORM_WIDTH;

  // Rule 2: Use fullscreen layout ONLY if screen is too narrow AND on a mobile device
  // Wide mobile screens should get desktop-style layout with visible staged panel
  const useFullscreen = useMobileLayout && isMobileDevice;

  // Track screen dimensions
  useEffect(() => {
    const handleResize = () => {
      setScreenWidth(window.innerWidth);
      setScreenHeight(window.innerHeight);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ... keep existing code (state and useEffect hooks for form operations) ...

  // Handler for "Duplicate Patient" button - opens PatientForm to create new patient
  const handleDuplicatePatient = useCallback((patient) => {
    if (!patient || !onCreatePatient) return;
    
    const fullPatient = patients.find((p) => p && p.id === patient.id) || patient;
    if (isAppOwner(currentUser)) { console.log('DEBUG: Duplicating patient:', fullPatient); }
    
    setNewPatientMode('duplicate');
    setSelectedPatient(null);
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    
    const patientWithoutName = {
      ...fullPatient,
      full_name: '',
      _duplicateSource: true,
      _isNew: true,
      _focusName: !isMobileDevice
    };
    
    setSelectedPatient(patientWithoutName);
    setIsPatientFormOpen(true);
    onCreatePatient((createdPatient) => {
      setIsPatientFormOpen(false);
      setNewPatientMode(null);
      // CRITICAL: Auto-add new patient to staged
      handlePatientSelect(createdPatient, true);
    }, patientWithoutName);
  }, [onCreatePatient, handlePatientSelect, patients, isMobileDevice, currentUser]);

  // Handler for "New Address" button - opens PatientForm to create new patient
  const handleNewAddressPatient = useCallback((patient) => {
    if (!patient || !onCreatePatient) return;
    
    const fullPatient = patients.find((p) => p && p.id === patient.id) || patient;
    if (isAppOwner(currentUser)) { console.log('DEBUG: Creating new address for patient:', fullPatient); }
    
    setNewPatientMode('new_address');
    setSelectedPatient(null);
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    
    const patientWithoutAddress = {
      ...fullPatient,
      address: '',
      unit_number: '',
      _newAddressSource: true,
      _isNew: true,
      _focusAddress: !isMobileDevice
    };
    
    setSelectedPatient(patientWithoutAddress);
    setIsPatientFormOpen(true);
    onCreatePatient((createdPatient) => {
      setIsPatientFormOpen(false);
      setNewPatientMode(null);
      // CRITICAL: Auto-add new patient to staged
      handlePatientSelect(createdPatient, true);
    }, patientWithoutAddress);
  }, [onCreatePatient, handlePatientSelect, patients, isMobileDevice, currentUser]);

  // ... keep existing code (remaining functions and hooks) ...

  return (
    <div>Placeholder - Full component content needs to be restored</div>
  );
}