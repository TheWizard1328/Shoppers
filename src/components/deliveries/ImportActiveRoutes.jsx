import React, { useState, useCallback, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Upload, CheckCircle, XCircle, AlertCircle, X, ArrowLeft, Loader2, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";
import { sortUsers } from '../utils/sorting';
import { getDriverDisplayName } from '../utils/driverUtils';
import { motion } from 'framer-motion';
import { getData } from '../utils/dataManager';
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { batchUpdateAMPM, determineDeliveryAMPM } from '../utils/ampmUtils';
import { getAllDriverUsers } from '../utils/driverSelectors';
import { offlineDB } from '../utils/offlineDatabase';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { driverLocationPoller } from '../utils/driverLocationPoller';

// Utility function for delay
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Utility function for retrying operations with exponential backoff
const retryWithBackoff = async (fn, retries = 5, delayMs = 500, factor = 1.5) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i < retries - 1) {
        const waitTime = Math.round(delayMs * Math.pow(factor, i));
        console.warn(`⚠️ Operation failed, retrying in ${waitTime}ms... (Attempt ${i + 1}/${retries})`);
        console.warn(`Error: ${error.message}`);
        await delay(waitTime);
      } else {
        console.error(`❌ All ${retries} retry attempts failed.`);
        throw error;
      }
    }
  }
};

// Generate unique delivery IDs
const generateDeliveryId = (existingIds = []) => {
  let newId;
  let isUnique = false;
  const existingIdsSet = new Set(existingIds);
  while (!isUnique) {
    const timestamp = Date.now().toString(36);
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    newId = `DID-${timestamp}-${randomSuffix}`.toUpperCase();
    if (!existingIdsSet.has(newId)) {
      isUnique = true;
    }
  }
  return newId;
};

// Check if delivery is a return
const isReturnDelivery = (delivery, patients, stores) => {
  if (!delivery || typeof delivery !== 'object') return false;
  const validPatients = Array.isArray(patients) ? patients : [];
  const validStores = Array.isArray(stores) ? stores : [];
  const notesLower = (delivery.delivery_notes || '').toLowerCase();
  const patient = validPatients.find((p) => p.id === delivery.patient_id);
  const patientNameLower = (patient?.full_name || delivery.patient_name || '').toLowerCase();

  if (notesLower.includes('return') || notesLower.includes('(rtn)')) return true;
  if (patientNameLower.includes('return') || patientNameLower.includes('(rtn)')) return true;
  
  if (!delivery.patient_id) {
    const store = validStores.find((s) => s.id === delivery.store_id);
    if (store && (notesLower.includes('return') || store.name?.toLowerCase().includes('return'))) {
      return true;
    }
  }
  
  return false;
};

// Parse CSV line handling quoted fields
const parseCSVLine = (line) => {
  const result = [];
  let inQuote = false;
  let currentField = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuote = !inQuote;
      if (!inQuote && line[i + 1] === '"') {
        currentField += '"';
        i++;
      }
    } else if (char === ',' && !inQuote) {
      result.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  result.push(currentField.trim());
  return result;
};

// Helper function to format address with unit number
const formatAddressWithUnit = (address, unit_number) => {
  if (!address) return '';
  if (unit_number && unit_number.trim()) {
    const trimmedUnit = unit_number.trim();
    const lowerAddress = address.toLowerCase();
    if (
      lowerAddress.includes(`unit ${trimmedUnit.toLowerCase()}`) ||
      lowerAddress.includes(`apt ${trimmedUnit.toLowerCase()}`) ||
      lowerAddress.includes(`#${trimmedUnit.toLowerCase()}`) ||
      lowerAddress.includes(`suite ${trimmedUnit.toLowerCase()}`)
    ) {
      return address;
    }
    return `${address}, #${trimmedUnit}`;
  }
  return address;
};

// Helper function to clean delivery data before saving
const cleanDeliveryData = (deliveryData) => {
  const cleanData = { ...deliveryData };
  if (cleanData.patient_id === '') cleanData.patient_id = null;
  if (cleanData.stop_id === '') cleanData.stop_id = null;
  if (cleanData.puid === '') cleanData.puid = null;
  if (cleanData.dispatcher_id === '') cleanData.dispatcher_id = null;
  if (cleanData.delivery_notes === '') cleanData.delivery_notes = null;
  if (cleanData.delivery_instructions === '') cleanData.delivery_instructions = null;
  if (cleanData.unit_number === '') cleanData.unit_number = null;
  if (cleanData.cod_amount === '') cleanData.cod_amount = null;
  if (cleanData.cod_total_amount_required === 0) cleanData.cod_total_amount_required = null;
  if (cleanData.ampm_deliveries === '') cleanData.ampm_deliveries = null;
  delete cleanData._changes;
  delete cleanData.action;
  delete cleanData._matchReason;
  return cleanData;
};

export default function ImportActiveRoutes({
  onImportComplete,
  onCancel,
  stores,
  allUsers,
  currentUser,
  allDeliveries
}) {
  const [files, setFiles] = useState([]);
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState({ deliveriesToCreate: [], deliveriesToUpdate: [], skippedItems: [], errors: [] });
  const [isParsing, setIsParsing] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [showProgress, setShowProgress] = useState(false);
  const [patients, setPatients] = useState([]);

  const [previewFilterDriver, setPreviewFilterDriver] = useState('all');
  const [previewFilterDate, setPreviewFilterDate] = useState('all');
  const [importError, setImportError] = useState(null);

  const [importProgress, setImportProgress] = useState({
    current: 0,
    total: 0,
    phase: '',
    created: 0,
    updated: 0,
    errors: 0,
    currentFile: '',
    filesCompleted: 0,
    totalFiles: 0
  });

  const userHasRole = useCallback((user, role) => {
    return user && user.app_roles && user.app_roles.includes(role);
  }, []);

  const [allStores, setAllStores] = useState([]);
  const [allDriverUsers, setAllDriverUsers] = useState([]);
  const freshStoresRef = React.useRef([]);

  const findStoreByAbbreviation = useCallback((abbr, storesOverride = null) => {
    if (!abbr) return null;
    const storesToSearch = storesOverride || freshStoresRef.current || allStores || stores || [];
    if (!Array.isArray(storesToSearch) || storesToSearch.length === 0) {
      console.warn(`[ImportActiveRoutes] No stores available to search for abbreviation "${abbr}"`);
      return null;
    }
    const found = storesToSearch.find((s) => s.abbreviation?.toLowerCase() === abbr.toLowerCase());
    if (!found) {
      console.warn(`[ImportActiveRoutes] Store abbreviation "${abbr}" not found`);
    }
    return found;
  }, [allStores, stores]);

  const findDispatcherByStore = useCallback((store) => {
    if (!store) return null;

    const usersToSearch = allDriverUsers.length > 0 ? allDriverUsers : allUsers || [];

    if (store.dispatcher_id) {
      const dispatcher = usersToSearch.find((u) => u.id === store.dispatcher_id);
      if (dispatcher) {
        return dispatcher;
      }
    }

    if (store.dispatcher_name) {
      const dispatcherNameLower = store.dispatcher_name.toLowerCase().trim();
      const dispatcher = usersToSearch.find((u) => {
        const userName = (u.user_name || u.full_name || '').toLowerCase().trim();
        return u.app_roles?.includes('dispatcher') && userName === dispatcherNameLower;
      });

      if (dispatcher) {
        return dispatcher;
      }
    }

    return null;
  }, [allDriverUsers, allUsers]);

  const matchDeliveryToExisting = useCallback((importedDelivery, existingDeliveries, patientsData) => {
    if (!importedDelivery || !existingDeliveries || !Array.isArray(existingDeliveries) || !patientsData || !Array.isArray(patientsData)) {
      return null;
    }

    const importedDeliveryStopId = (importedDelivery.stop_id || '').trim();
    const importedDeliveryPatientId = (importedDelivery.patient_id || '').trim();
    const importedDeliveryDate = importedDelivery.delivery_date;
    const importedDriverName = (importedDelivery.driver_name || '').trim().toLowerCase();
    const importedTrackingNumber = (importedDelivery.tracking_number || '').trim();
    const importedDriverId = importedDelivery.driver_id;

    const sameDateDeliveries = existingDeliveries.filter((d) => {
      if (d.delivery_date !== importedDeliveryDate) return false;

      if (importedDriverId && d.driver_id) {
        return d.driver_id === importedDriverId;
      }

      const existingDriverName = (d.driver_name || '').trim().toLowerCase();
      const driverMatch = !existingDriverName || existingDriverName === importedDriverName;

      return driverMatch;
    });

    // Priority 1: Match by Stop ID (SID) - must be unique
    if (importedDeliveryStopId) {
      const sidMatches = sameDateDeliveries.filter((d) => {
        const existingSID = (d.stop_id || '').trim();
        return existingSID === importedDeliveryStopId;
      });
      if (sidMatches.length === 1) {
        return { match: sidMatches[0], reason: `SID Match (${importedDeliveryStopId})` };
      }
    }

    // Priority 2: Match by Tracking Number (TR#) - exact match or same 20-digit range
    if (importedTrackingNumber && importedTrackingNumber !== '') {
      const importedTRInt = parseInt(importedTrackingNumber, 10);
      if (!isNaN(importedTRInt)) {
        const importedTRRange = Math.floor(importedTRInt / 20);
        
        const trackingNumberMatch = sameDateDeliveries.find((d) => {
          const existingTR = (d.tracking_number || '').trim();
          if (existingTR === importedTrackingNumber) return true; // Exact match
          
          // Range match: 0-19, 20-39, 40-59, etc.
          const existingTRInt = parseInt(existingTR, 10);
          if (!isNaN(existingTRInt)) {
            const existingTRRange = Math.floor(existingTRInt / 20);
            return existingTRRange === importedTRRange;
          }
          
          return false;
        });
        
        if (trackingNumberMatch) {
          return { match: trackingNumberMatch, reason: `TR# Match (${importedTrackingNumber})` };
        }
      }
    }

    // Priority 3: Match by Patient ID (PID) only
    if (importedDeliveryPatientId) {
      const patientIdMatch = sameDateDeliveries.find((d) => {
        const existingPID = (d.patient_id || '').trim();
        return existingPID === importedDeliveryPatientId;
      });

      if (patientIdMatch) {
        return { match: patientIdMatch, reason: `PID Match (${importedDeliveryPatientId})` };
      }
    }

    // Priority 4: Match for pickups (abbreviation + AM/PM)
    if (!importedDeliveryPatientId && importedDelivery.store_id) {
      const pickupMatch = sameDateDeliveries.find((d) =>
        d.store_id === importedDelivery.store_id &&
        (!d.patient_id || d.patient_id === '') &&
        d.ampm_deliveries === importedDelivery.ampm_deliveries
      );

      if (pickupMatch) {
        return { match: pickupMatch, reason: `Pickup Match (Abbr + AM/PM)` };
      }
    }

    return { match: null, reason: 'No match found' };
  }, []);

  const detectChanges = useCallback((existingDelivery, importedDelivery) => {
    const changes = [];

    const fieldsToCompare = [
      { key: 'stop_id', label: 'SID' },
      { key: 'tracking_number', label: 'TR#' },
      { key: 'status', label: 'Status' },
      { key: 'actual_delivery_time', label: 'Time' },
      { key: 'stop_order', label: 'Order' },
      { key: 'cod_total_amount_required', label: 'COD Amount' },
      { key: 'signature_needed', label: 'Signature' },
      { key: 'fridge_item', label: 'Fridge' },
      { key: 'oversized', label: 'Oversized' },
      { key: 'after_hours_pickup', label: 'After Hrs' },
      { key: 'ampm_deliveries', label: 'AM/PM' },
      { key: 'first_delivery', label: 'First Delivery' },
      { key: 'travel_dist', label: 'Travel Dist' }
    ];

    fieldsToCompare.forEach((field) => {
      const existingValue = existingDelivery[field.key];
      const importedValue = importedDelivery[field.key];

      const normalizedExisting = existingValue === null || existingValue === undefined || (typeof existingValue === 'string' && existingValue.trim() === '') ? null : existingValue;
      const normalizedImported = importedValue === null || importedValue === undefined || (typeof importedValue === 'string' && importedValue.trim() === '') ? null : importedValue;

      if (field.key === 'actual_delivery_time') {
        const existingTimeStr = normalizedExisting ? format(new Date(normalizedExisting), 'HH:mm') : null;
        const importedTimeStr = normalizedImported ? format(new Date(normalizedImported), 'HH:mm') : null;

        if (existingTimeStr !== importedTimeStr) {
          changes.push(`${field.label}: ${existingTimeStr || 'none'} → ${importedTimeStr || 'none'}`);
        }
      } else if (normalizedExisting !== normalizedImported) {
        let displayExisting = normalizedExisting === null ? 'none' : (typeof normalizedExisting === 'boolean' ? (normalizedExisting ? 'true' : 'false') : normalizedExisting.toString());
        let displayImported = normalizedImported === null ? 'none' : (typeof normalizedImported === 'boolean' ? (normalizedImported ? 'true' : 'false') : normalizedImported.toString());

        changes.push(`${field.label}: ${displayExisting} → ${displayImported}`);
      }
    });

    return changes;
  }, []);

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files);
    setFiles(selectedFiles.length > 0 ? selectedFiles : []);
  };

  const removeFile = (indexToRemove) => {
    setFiles(files.filter((_, index) => index !== indexToRemove));
  };

  const processCSVData = useCallback(async (csvText, fileName, selectedDriver, allDeliveriesData, patientsData, storesData) => {
    if (!csvText || !fileName || !selectedDriver || !patientsData || !storesData || !currentUser) {
      return { deliveriesToCreate: [], deliveriesToUpdate: [], skippedItems: [], errors: [] };
    }

    const deliveriesToCreate = [];
    const deliveriesToUpdate = [];
    const skippedItems = [];
    const errors = [];
    const lines = csvText.split(/\r?\n/).filter((line) => line.trim());

    let currentDate = null;
    let expectedDeliveries = 0;
    let lineNumber = 0;

    const patientsByPID = new Map();
    patientsData.forEach((patient) => {
      if (patient.patient_id) {
        const pid = patient.patient_id.trim();
        if (pid) {
          patientsByPID.set(pid, patient);
        }
      }
    });

    const existingDeliveryIds = new Set(allDeliveriesData.map((d) => d.delivery_id).filter(Boolean));

    // Track max stop order per date/driver for assigning sequential stop orders to new stops
    const maxStopOrderByDateDriver = new Map();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      lineNumber = i + 1;

      // RULE 1: Ignore row 1 (header row)
      if (lineNumber === 1) {
        console.log(`⏭️ Row 1: Skipping header row`);
        continue;
      }

      if (lineNumber % 10 === 0) {
        const percent = Math.round(lineNumber / lines.length * 50);
        setProgressPercent(percent);
        setProgressMessage(`Parsing file: ${fileName} (Line ${lineNumber} / ${lines.length})...`);
      }

      if (!line.trim()) {
        continue;
      }

      // RULE 2: Date metadata on row 2: #YYYY-MM-DD#,TotalDeliveries,...
      const dateMetaMatch = line.match(/^#(\d{4}-\d{2}-\d{2})#,(\d+),/);
      if (dateMetaMatch) {
        currentDate = dateMetaMatch[1];
        expectedDeliveries = parseInt(dateMetaMatch[2], 10);
        console.log(`📅 Row ${lineNumber}: Date metadata found - ${currentDate}, expecting ${expectedDeliveries} deliveries`);
        continue;
      }

      const values = parseCSVLine(line);

      if (!currentDate) {
        console.warn(`⚠️ Row ${lineNumber}: Skipping line as no delivery date has been set yet.`);
        skippedItems.push({
          lineNumber,
          reason: 'No delivery date set',
          rawData: values.slice(0, Math.min(values.length, 5)).join(', ') + (values.length > 5 ? '...' : '')
        });
        continue;
      }

      // RULE 3: Updated column mapping - now expecting 17+ columns (added ignored column 13)
      if (values.length < 17) {
        console.warn(`⚠️ Row ${lineNumber}: Insufficient fields (${values.length} out of 17+ expected), skipping line.`);
        skippedItems.push({
          lineNumber,
          reason: `Insufficient fields (${values.length}/17)`,
          rawData: values.join(', ')
        });
        continue;
      }

      // CRITICAL: Updated column mapping for Active Routes
      const storeAbbr = values[0]?.replace(/"/g, '').trim(); // Column 1
      const ampmRawValue = values[1]?.replace(/"/g, '').trim(); // Column 2
      const trackingNumber = values[2]?.replace(/"/g, '').trim(); // Column 3: TR#
      const rawStopOrder = values[3]?.trim();
      const originalStopOrder = parseInt(rawStopOrder) || 0; // Column 4: Stop Order (0 = incomplete)
      let stopOrder = originalStopOrder;
      const pendingIndicator = parseInt(values[4]?.trim()) || 0; // Column 5: Negative = pending
      const deliveryStartTimeStr = values[5]?.replace(/"/g, '').trim(); // Column 6: Start time
      const deliveryEndTimeStr = values[6]?.replace(/"/g, '').trim(); // Column 7: End time
      const travelDistStr = values[8]?.replace(/"/g, '').trim(); // Column 9: Travel distance
      const travelDist = travelDistStr && !isNaN(parseFloat(travelDistStr)) ? parseFloat(parseFloat(travelDistStr).toFixed(2)) : null;
      
      // Column 13: Ignored (original)
      // Column 14: Ignored (new boolean column)
      const stopId = (values[13] || '').replace(/"/g, '').trim(); // Column 14: SID (index 13)
      const patientPID = values[14]?.replace(/"/g, '').trim(); // Column 15: PID (index 14)
      const rawNotes = (values[16] || '').replace(/"/g, '').trim(); // Column 17: Notes (index 16)

      let ampmValue = null;
      if (ampmRawValue === '1') {
        ampmValue = 'AM';
      } else if (ampmRawValue === '2') {
        ampmValue = 'PM';
      } else if (ampmRawValue === 'AM' || ampmRawValue === 'PM') {
        ampmValue = ampmRawValue;
      }

      const store = findStoreByAbbreviation(storeAbbr, storesData);
      if (!store) {
        skippedItems.push({
          lineNumber,
          reason: `Store not found: "${storeAbbr}"`,
          rawData: `${storeAbbr}, ${ampmRawValue}, ${trackingNumber}, ${stopId}, ${patientPID}`
        });
        console.warn(`⚠️ Row ${lineNumber}: Store not found for abbreviation "${storeAbbr}", skipping delivery.`);
        continue;
      }

      const isPickup = !patientPID || patientPID === '' || rawNotes.toLowerCase().includes('pick up');

      let patient = null;
      let patientId = null;

      if (!isPickup) {
        patient = patientsByPID.get(patientPID);

        if (!patient) {
          console.warn(`⚠️ Row ${lineNumber}: Patient not found for PID: "${patientPID}".`);
          skippedItems.push({
            lineNumber,
            reason: `Patient not found: PID "${patientPID}"`,
            rawData: `${storeAbbr}, ${ampmRawValue}, ${trackingNumber}, ${stopId}, ${patientPID}`
          });
          continue;
        }

        patientId = patient.id;
      }

      const dispatcher = findDispatcherByStore(store);
      const dispatcherId = dispatcher ? dispatcher.id : null;

      // If stopOrder is 0 or missing, assign sequential stop order based on max existing
      if (stopOrder === 0 || !rawStopOrder) {
        const dateDriverKey = `${currentDate}_${selectedDriver.id}`;
        
        // Initialize max stop order from existing deliveries for this date/driver
        if (!maxStopOrderByDateDriver.has(dateDriverKey)) {
          const existingStopOrders = allDeliveriesData
            .filter((d) => d.delivery_date === currentDate && d.driver_id === selectedDriver.id)
            .map((d) => d.stop_order || 0);
          const maxExisting = existingStopOrders.length > 0 ? Math.max(...existingStopOrders) : 0;
          maxStopOrderByDateDriver.set(dateDriverKey, maxExisting);
        }
        
        // Increment and assign next stop order
        const nextStopOrder = maxStopOrderByDateDriver.get(dateDriverKey) + 1;
        maxStopOrderByDateDriver.set(dateDriverKey, nextStopOrder);
        stopOrder = nextStopOrder;
      }

      // Status determination based on column 5 (pendingIndicator), stopOrder, and time columns
      let deliveryStatus = 'pending';
      let actualDeliveryTime = null;
      let deliveryTimeStart = null;
      let deliveryTimeEnd = null;
      let deliveryTimeEta = null;

      // RULE: Determine status based on pending indicator (col 5), stop order, times, and pickup type
      const isPendingIndicator = pendingIndicator < 0; // Column 5 negative = pending
      
      if (originalStopOrder > 0 && deliveryStartTimeStr && !deliveryEndTimeStr) {
        // Completed - has stop order > 0, has start time only
        deliveryStatus = 'completed';
        actualDeliveryTime = `${currentDate}T${deliveryStartTimeStr}:00`;
      } else if (isPendingIndicator && isPickup && deliveryStartTimeStr && deliveryEndTimeStr) {
        // EXCEPTION: Pickups with times should be en_route even if pending indicator is negative
        deliveryStatus = 'en_route';
        deliveryTimeStart = deliveryStartTimeStr;
        deliveryTimeEnd = deliveryEndTimeStr;
        deliveryTimeEta = deliveryStartTimeStr;
      } else if (isPendingIndicator) {
        // Pending indicator is negative - status is pending
        deliveryStatus = 'pending';
        deliveryTimeStart = null;
        deliveryTimeEnd = null;
      } else if (originalStopOrder === 0 && deliveryStartTimeStr && deliveryEndTimeStr) {
        // Active (in transit/en route) - stop order = 0, has both times, not pending
        deliveryStatus = isPickup ? 'en_route' : 'in_transit';
        deliveryTimeStart = deliveryStartTimeStr;
        deliveryTimeEnd = deliveryEndTimeStr;
        deliveryTimeEta = deliveryStartTimeStr;
      } else {
        // No times or unclear - pending
        deliveryStatus = 'pending';
        deliveryTimeStart = null;
        deliveryTimeEnd = null;
      }

      const newDeliveryData = {
        delivery_date: currentDate,
        store_id: store.id,
        dispatcher_id: dispatcherId || null,
        driver_id: selectedDriver.id,
        driver_name: selectedDriver.user_name || selectedDriver.full_name,
        tracking_number: trackingNumber || null,
        stop_order: stopOrder,
        stop_id: stopId || null,
        status: deliveryStatus,
        actual_delivery_time: actualDeliveryTime,
        delivery_time_start: deliveryTimeStart,
        delivery_time_end: deliveryTimeEnd,
        delivery_time_eta: deliveryTimeEta,
        extra_time: 0,
        ampm_deliveries: ampmValue,
        cod_total_amount_required: 0,
        cod_payments: [],
        cod_payment_type: 'No Payment',
        cod_amount: '',
        signature_needed: false,
        fridge_item: false,
        oversized: false,
        after_hours_pickup: false,
        delivery_notes: rawNotes,
        first_delivery: false,
        puid: null,
        travel_dist: travelDist !== null && travelDist !== undefined ? parseFloat(travelDist.toFixed(2)) : null
      };

      // Handle failure detection from notes (for completed stops)
      const notesLower = rawNotes.toLowerCase();
      if (deliveryStatus === 'completed') {
        if (isPickup && notesLower.includes('failed')) {
          newDeliveryData.status = 'cancelled';
          // For cancelled: actual_delivery_time = delivery_time_start
          newDeliveryData.actual_delivery_time = actualDeliveryTime;
        } else if (notesLower.includes('failed')) {
          newDeliveryData.status = 'failed';
          // For failed: actual_delivery_time = delivery_time_start
          newDeliveryData.actual_delivery_time = actualDeliveryTime;
        } else if (notesLower.includes('cancel')) {
          newDeliveryData.status = 'cancelled';
          // For cancelled: actual_delivery_time = delivery_time_start
          newDeliveryData.actual_delivery_time = actualDeliveryTime;
        }
      }

      if (patientId) {
        newDeliveryData.patient_id = patientId;
        newDeliveryData.delivery_address = patient.address || '';
        newDeliveryData.patient_name = patient.full_name;
        newDeliveryData.patient_phone = patient.phone || '';
        newDeliveryData.unit_number = patient.unit_number || '';
        newDeliveryData.delivery_instructions = patient.delivery_instructions || '';
        newDeliveryData.mailbox_ok = patient.mailbox_ok || false;
        newDeliveryData.call_upon_arrival = patient.call_upon_arrival || false;
        newDeliveryData.ring_bell = patient.ring_bell !== false;
        newDeliveryData.dont_ring_bell = patient.dont_ring_bell || false;
        newDeliveryData.back_door = patient.back_door || false;
        newDeliveryData.signature_needed = patient.signature_needed || false;
        
        // Override time windows from patient record if they exist
        if (patient.time_window_start) {
          newDeliveryData.time_window_start = patient.time_window_start;
        }
        if (patient.time_window_end) {
          newDeliveryData.time_window_end = patient.time_window_end;
        }
      } else {
        newDeliveryData.patient_id = null;
        newDeliveryData.delivery_address = store.address || '';
        newDeliveryData.patient_name = `${store.name} Pickup`;
        newDeliveryData.store_phone = store.phone || '';
        newDeliveryData.unit_number = '';
        newDeliveryData.delivery_instructions = '';
        if (!rawNotes.toLowerCase().includes('pickup') && !rawNotes.toLowerCase().includes('return')) {
          newDeliveryData.delivery_notes = `Pickup from ${store?.name || newDeliveryData.store_id}`;
        }
      }

      // Parse special flags from notes
      if (notesLower.includes('first delivery')) {
        newDeliveryData.first_delivery = true;
      }

      if (notesLower.match(/\bsignature\b/i)) {
        newDeliveryData.signature_needed = true;
      }

      if (notesLower.match(/\b(fridge|cold|refrigerat(?:e|ed|or)?|refrig)\b/i)) {
        newDeliveryData.fridge_item = true;
      }

      if (notesLower.match(/\b(oversized|large|bulky|big)\b/i)) {
        newDeliveryData.oversized = true;
      }

      if (notesLower.match(/\bafter[\s-]?hours\b/i)) {
        newDeliveryData.after_hours_pickup = true;
      }

      // Parse COD from notes
      if (patientId) {
        const codRegex = /(cod|dod)\s*[\$]?\s*([\d.]+)\s*(cash|debit|credit|check|cheque)?/gi;
        const codMatches = [...rawNotes.matchAll(codRegex)];

        if (codMatches.length > 0) {
          const codPayments = [];
          let totalCodAmount = 0;

          codMatches.forEach((match) => {
            const codType = (match[1] || '').toLowerCase();
            const amount = parseFloat(match[2]);
            let paymentType = (match[3] || '').toLowerCase();

            if (codType === 'dod') {
              paymentType = 'Debit';
            } else if (paymentType === 'cash') {
              paymentType = 'Cash';
            } else if (paymentType === 'debit') {
              paymentType = 'Debit';
            } else if (paymentType === 'credit') {
              paymentType = 'Credit';
            } else if (paymentType === 'check' || paymentType === 'cheque') {
              paymentType = 'Check';
            } else {
              paymentType = 'Cash';
            }

            if (amount > 0) {
              codPayments.push({ type: paymentType, amount });
              totalCodAmount += amount;
            }
          });

          if (codPayments.length > 0) {
            newDeliveryData.cod_payments = codPayments;
            newDeliveryData.cod_total_amount_required = totalCodAmount;
            newDeliveryData.cod_payment_type = codPayments[0].type;
            newDeliveryData.cod_amount = totalCodAmount.toString();
          }
        }
      }

      const matchResult = matchDeliveryToExisting(newDeliveryData, allDeliveriesData, patientsData);
      const existingDelivery = matchResult?.match || null;
      const matchReason = matchResult?.reason || 'Unknown';

      if (existingDelivery) {
        const changes = detectChanges(existingDelivery, newDeliveryData);

        if (changes.length > 0) {
          const updatedDeliveryData = {
            ...existingDelivery,
            ...newDeliveryData,
            id: existingDelivery.id
          };

          deliveriesToUpdate.push({
            ...updatedDeliveryData,
            _changes: changes,
            _matchReason: matchReason
          });
        }
      } else {
        const newDeliveryId = generateDeliveryId(Array.from(existingDeliveryIds));
        existingDeliveryIds.add(newDeliveryId);

        deliveriesToCreate.push({
          ...newDeliveryData,
          delivery_id: newDeliveryId,
          stop_id: newDeliveryData.stop_id || null,
          _matchReason: matchReason
        });
      }
    }

    // PUID Assignment Pass and Pending Delivery Time Assignment
    const allParsedDeliveries = [...deliveriesToCreate, ...deliveriesToUpdate];
    const pickupMap = new Map();
    const pickupTimeMap = new Map(); // Track pickup delivery_time_start for pending deliveries

    allParsedDeliveries.forEach((d) => {
      if (!d.patient_id && d.store_id && d.stop_id) {
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries || 'none'}`;
        if (!pickupMap.has(key)) {
          pickupMap.set(key, d.stop_id);
        }
        // Store pickup's delivery_time_start for pending delivery time assignment
        if (d.delivery_time_start && !pickupTimeMap.has(key)) {
          pickupTimeMap.set(key, d.delivery_time_start);
        }
      }
    });

    allParsedDeliveries.forEach((d) => {
      if (!d.patient_id && d.stop_id) {
        d.puid = d.stop_id;
      } else if (d.patient_id) {
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries || 'none'}`;
        const matchingPuid = pickupMap.get(key);
        if (matchingPuid) {
          d.puid = matchingPuid;
        } else {
          d.puid = null;
        }
        
        // CRITICAL: For pending deliveries, set delivery_time_start from pickup + 5 min
        if (d.status === 'pending' && !d.delivery_time_start) {
          const pickupTimeStart = pickupTimeMap.get(key);
          if (pickupTimeStart) {
            const [hours, minutes] = pickupTimeStart.split(':').map(Number);
            const totalMinutes = hours * 60 + minutes + 5;
            const newHours = Math.floor(totalMinutes / 60) % 24;
            const newMinutes = totalMinutes % 60;
            d.delivery_time_start = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
            // Set delivery_time_end to 1 hour after delivery_time_start
            const endTotalMinutes = totalMinutes + 60;
            const endHours = Math.floor(endTotalMinutes / 60) % 24;
            const endMinutes = endTotalMinutes % 60;
            d.delivery_time_end = `${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}`;
            // Set ETA to delivery_time_start
            d.delivery_time_eta = d.delivery_time_start;
          }
        }
      }
    });

    setProgressPercent(50);
    setProgressMessage('Parsing complete, preparing deliveries for ' + fileName + '...');

    return {
      deliveriesToCreate,
      deliveriesToUpdate,
      skippedItems,
      errors
    };
  }, [stores, allUsers, findStoreByAbbreviation, findDispatcherByStore, setProgressPercent, setProgressMessage, matchDeliveryToExisting, detectChanges, currentUser, userHasRole]);

  // Load ALL drivers from ALL cities on mount
  React.useEffect(() => {
    const loadAllDrivers = async () => {
      try {
        const allAppUsers = await base44.entities.AppUser.list();
        const allAuthUsers = await base44.entities.User.list();

        const mergedUsers = allAuthUsers.map((authUser) => {
          const appUser = allAppUsers.find((au) => au.user_id === authUser.id);
          if (appUser) {
            return {
              ...authUser,
              ...appUser,
              id: authUser.id,
              user_name: appUser.user_name || authUser.full_name,
              app_roles: appUser.app_roles || []
            };
          }
          return authUser;
        });

        setAllDriverUsers(mergedUsers);
      } catch (error) {
        console.error('[ImportActiveRoutes] Error loading all drivers:', error);
        setAllDriverUsers(allUsers || []);
      }
    };

    loadAllDrivers();
  }, [allUsers]);

  const availableDrivers = useMemo(() => {
    const usersToUse = allDriverUsers.length > 0 ? allDriverUsers : allUsers || [];

    if (!Array.isArray(usersToUse) || usersToUse.length === 0) {
      return [];
    }

    const drivers = getAllDriverUsers(usersToUse, false);
    return sortUsers(drivers);
  }, [allDriverUsers, allUsers]);

  const allPreviewDeliveries = useMemo(() => {
    const created = previewData.deliveriesToCreate.map((d) => ({ ...d, action: 'create' }));
    const updated = previewData.deliveriesToUpdate.map((d) => ({ ...d, action: 'update' }));
    return [...created, ...updated];
  }, [previewData.deliveriesToCreate, previewData.deliveriesToUpdate]);

  const previewDates = useMemo(() => {
    const dates = new Set(allPreviewDeliveries.map((d) => d.delivery_date));
    return Array.from(dates).sort();
  }, [allPreviewDeliveries]);

  const filteredPreviewDeliveries = useMemo(() => {
    return allPreviewDeliveries.filter((delivery) => {
      const dateMatch = previewFilterDate === 'all' || delivery.delivery_date === previewFilterDate;
      return dateMatch;
    });
  }, [allPreviewDeliveries, previewFilterDate]);

  const previewStats = useMemo(() => {
    const creates = filteredPreviewDeliveries.filter((d) => d.action === 'create').length;
    const updates = filteredPreviewDeliveries.filter((d) => d.action === 'update').length;
    const completed = filteredPreviewDeliveries.filter((d) => d.status === 'completed').length;
    const enRoute = filteredPreviewDeliveries.filter((d) => d.status === 'in_transit' || d.status === 'en_route').length;
    const pending = filteredPreviewDeliveries.filter((d) => d.status === 'pending').length;
    const failed = filteredPreviewDeliveries.filter((d) => d.status === 'failed').length;

    return { creates, updates, completed, enRoute, pending, failed, skipped: previewData.skippedItems.length };
  }, [filteredPreviewDeliveries, previewData.skippedItems]);

  const extractDateRangeFromFiles = async (filesToParse) => {
    const dates = new Set();
    
    for (const file of filesToParse) {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      
      for (let i = 0; i < lines.length; i++) {
        // Skip row 1 (header)
        if (i === 0) continue;
        
        const line = lines[i];
        // Look for date metadata on row 2+
        const dateMetaMatch = line.match(/^#(\d{4}-\d{2}-\d{2})#,/);
        if (dateMetaMatch) {
          dates.add(dateMetaMatch[1]);
        }
      }
    }
    
    const sortedDates = Array.from(dates).sort();
    if (sortedDates.length === 0) {
      return { minDate: null, maxDate: null };
    }
    
    return {
      minDate: sortedDates[0],
      maxDate: sortedDates[sortedDates.length - 1]
    };
  };

  const handlePreview = async () => {
    if (files.length === 0) {
      alert('Please select at least one CSV file');
      return;
    }
    if (!selectedDriverId) {
      alert('Please select a driver');
      return;
    }

    setIsParsing(true);
    setImportResult(null);
    setShowProgress(true);
    setProgressPercent(0);
    setProgressMessage('Starting preview generation...');
    setPreviewFilterDriver('all');
    setPreviewFilterDate('all');

    try {
      const usersToSearch = allDriverUsers.length > 0 ? allDriverUsers : allUsers || [];
      const selectedUser = usersToSearch.find((u) => u.id === selectedDriverId);
      if (!selectedUser) throw new Error('Selected driver not found');

      setProgressMessage('Analyzing import files for date range...');
      setProgressPercent(5);
      
      const { minDate, maxDate } = await extractDateRangeFromFiles(files);
      
      if (!minDate || !maxDate) {
        alert('Could not detect any dates in the import files. Please ensure files contain date metadata lines (e.g., #2024-01-15#,...)');
        setIsParsing(false);
        setShowProgress(false);
        return;
      }
      
      setProgressMessage(`Date range: ${minDate} to ${maxDate}`);
      setProgressPercent(10);

      setProgressMessage('Loading store data from cache...');
      const freshStoresAll = await getData('Store', '-created_date', null, false);
      freshStoresRef.current = freshStoresAll || [];
      setAllStores(freshStoresAll || []);
      setProgressPercent(15);

      setProgressMessage('Loading patient data from cache...');
      const freshPatients = await getData('Patient', '-created_date', null, false);
      setPatients(freshPatients);
      setProgressPercent(20);

      if (!freshPatients || freshPatients.length === 0) {
        alert('No patient data available.');
        setIsParsing(false);
        setShowProgress(false);
        return;
      }

      setProgressMessage(`Refreshing delivery cache for ${selectedUser.user_name || selectedUser.full_name} (${minDate} to ${maxDate})...`);
      setProgressPercent(25);

      const freshDeliveries = await base44.entities.Delivery.filter(
        { 
          driver_id: selectedUser.id,
          delivery_date: { $gte: minDate, $lte: maxDate }
        },
        '-delivery_date',
        10000
      );
      
      setProgressPercent(35);

      let totalToCreate = [];
      let totalToUpdate = [];
      let totalSkippedItems = [];
      let totalErrors = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgressMessage(`Processing file ${i + 1} of ${files.length}: ${file.name}...`);

        const text = await file.text();
        const result = await processCSVData(text, file.name, selectedUser, freshDeliveries, freshPatients, freshStoresAll);

        totalToCreate = [...totalToCreate, ...result.deliveriesToCreate];
        totalToUpdate = [...totalToUpdate, ...result.deliveriesToUpdate];
        totalSkippedItems = [...totalSkippedItems, ...result.skippedItems];
        totalErrors = [...totalErrors, ...result.errors];

        const currentParsingProgress = Math.round((i + 1) / files.length * 45);
        setProgressPercent(40 + currentParsingProgress);
      }

      setProgressPercent(90);
      setProgressMessage('Parsing complete, generating preview data...');

      setPreviewData({
        deliveriesToCreate: totalToCreate,
        deliveriesToUpdate: totalToUpdate,
        skippedItems: totalSkippedItems,
        errors: totalErrors
      });

      setProgressPercent(100);
      setProgressMessage('Preview ready!');
      setTimeout(() => {
        setShowProgress(false);
        setShowPreview(true);
      }, 500);

    } catch (error) {
      console.error("❌ Preview error:", error);
      setImportError({
        message: error.message,
        record: {
          driver: availableDrivers.find((d) => d.id === selectedDriverId)?.user_name || 'Unknown',
          files: files.map((f) => f.name).join(', ')
        },
        lineNumber: null,
        phase: 'preview'
      });
      setShowProgress(false);
    } finally {
      setIsParsing(false);
    }
  };

  const handleConfirmImport = async () => {
    setIsProcessing(true);
    setImportResult(null);
    setShowProgress(true);
    setImportProgress({
      current: 0,
      total: 0,
      phase: '',
      created: 0,
      updated: 0,
      errors: 0,
      currentFile: files.length > 0 ? files[0].name : '',
      filesCompleted: 0,
      totalFiles: files.length
    });

    const overallResults = {
      created: 0,
      updated: 0,
      skipped: previewData.skippedItems.length,
      total: filteredPreviewDeliveries.length,
      completed: 0,
      enRoute: 0,
      pending: 0,
      failed: 0,
      errors: [...previewData.errors],
      fileResults: []
    };

    const failedCreations = [];
    const failedUpdates = [];

    try {
      smartRefreshManager.pause();
      driverLocationPoller.pause();
      console.log('⏸️ [ImportActiveRoutes] Paused smart refresh and location poller');
      
      const { offlineDB } = await import('../utils/offlineDatabase');

      setProgressMessage('Loading latest patient and store data from cache...');
      const freshPatients = await getData('Patient', '-created_date', null, false);
      const freshStores = await getData('Store', '-created_date', null, false);

      const deliveriesToCreateFiltered = filteredPreviewDeliveries.filter((d) => d.action === 'create');
      const deliveriesToUpdateFiltered = filteredPreviewDeliveries.filter((d) => d.action === 'update');

      batchUpdateAMPM(deliveriesToCreateFiltered);
      batchUpdateAMPM(deliveriesToUpdateFiltered);

      // BATCH CREATE
      if (deliveriesToCreateFiltered.length > 0) {
        setImportProgress((prev) => ({
          ...prev,
          phase: 'creating',
          total: deliveriesToCreateFiltered.length,
          current: 0
        }));
        setProgressMessage(`Creating ${deliveriesToCreateFiltered.length} new deliveries...`);

        const cleanedDeliveries = deliveriesToCreateFiltered.map(cleanDeliveryData);

        const BATCH_SIZE = 25;
        const batches = [];
        for (let i = 0; i < cleanedDeliveries.length; i += BATCH_SIZE) {
          batches.push(cleanedDeliveries.slice(i, i + BATCH_SIZE));
        }

        let totalCreated = 0;
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          const batch = batches[batchIndex];
          try {
            const createdDeliveries = await retryWithBackoff(async () => {
              return await base44.entities.Delivery.bulkCreate(batch);
            }, 3, 2000, 2);

            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, createdDeliveries);

            batch.forEach((cleanData) => {
              overallResults.created++;
              if (cleanData.status === 'completed') overallResults.completed++;
              if (cleanData.status === 'in_transit' || cleanData.status === 'en_route') overallResults.enRoute++;
              if (cleanData.status === 'pending') overallResults.pending++;
              if (cleanData.status === 'failed') overallResults.failed++;
            });

            totalCreated += batch.length;
            setImportProgress((prev) => ({
              ...prev,
              created: totalCreated,
              current: totalCreated
            }));

            if (batchIndex < batches.length - 1) {
              await delay(1500);
            }
          } catch (error) {
            console.warn(`⚠️ Batch ${batchIndex + 1} bulkCreate failed:`, error.message);

            for (const cleanData of batch) {
              try {
                const createdDelivery = await retryWithBackoff(async () => {
                  return await base44.entities.Delivery.create(cleanData);
                }, 3, 1000, 2);
                
                await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [createdDelivery]);

                overallResults.created++;
                if (cleanData.status === 'completed') overallResults.completed++;
                if (cleanData.status === 'in_transit' || cleanData.status === 'en_route') overallResults.enRoute++;
                if (cleanData.status === 'pending') overallResults.pending++;
                if (cleanData.status === 'failed') overallResults.failed++;
                totalCreated++;
                setImportProgress((prev) => ({
                  ...prev,
                  created: totalCreated,
                  current: totalCreated
                }));
                await delay(500);
              } catch (individualError) {
                failedCreations.push({ data: cleanData, error: individualError.message });
              }
            }
          }
        }
      }

      // BATCH UPDATE
      if (deliveriesToUpdateFiltered.length > 0) {
        setImportProgress((prev) => ({
          ...prev,
          phase: 'updating',
          total: deliveriesToUpdateFiltered.length,
          current: 0
        }));
        setProgressMessage(`Updating ${deliveriesToUpdateFiltered.length} existing deliveries...`);

        for (let i = 0; i < deliveriesToUpdateFiltered.length; i++) {
          const deliveryData = deliveriesToUpdateFiltered[i];

          try {
            const { id, _changes, action, _matchReason, ...updatePayload } = deliveryData;
            if (!id) {
              throw new Error('Missing delivery ID');
            }

            const cleanPayload = cleanDeliveryData(updatePayload);

            const updatedDelivery = await retryWithBackoff(async () => {
              return await base44.entities.Delivery.update(id, cleanPayload);
            }, 3, 1000, 2);
            
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updatedDelivery]);

            overallResults.updated++;
            if (cleanPayload.status === 'completed') overallResults.completed++;
            if (cleanPayload.status === 'in_transit' || cleanPayload.status === 'en_route') overallResults.enRoute++;
            if (cleanPayload.status === 'pending') overallResults.pending++;
            if (cleanPayload.status === 'failed') overallResults.failed++;
            setImportProgress((prev) => ({
              ...prev,
              updated: prev.updated + 1,
              current: i + 1
            }));
            await delay(300);
          } catch (error) {
            console.warn(`⚠️ Backend update failed for delivery ID ${deliveryData.id}:`, error.message);
            failedUpdates.push({ data: deliveryData, error: error.message });
            setImportProgress((prev) => ({ ...prev, current: i + 1 }));
            await delay(500);
          }
        }
      }

      // Retry failed operations
      const totalFailed = failedCreations.length + failedUpdates.length;
      if (totalFailed > 0) {
        setImportProgress((prev) => ({
          ...prev,
          phase: 'retrying',
          total: totalFailed,
          current: 0
        }));
        setProgressMessage(`Retrying ${totalFailed} failed operations...`);

        for (let i = 0; i < failedCreations.length; i++) {
          const { data: cleanData } = failedCreations[i];

          try {
            const createdDelivery = await retryWithBackoff(async () => {
              return await base44.entities.Delivery.create(cleanData);
            }, 3, 2000, 2);
            
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [createdDelivery]);
            
            overallResults.created++;
            if (cleanData.status === 'completed') overallResults.completed++;
            if (cleanData.status === 'in_transit' || cleanData.status === 'en_route') overallResults.enRoute++;
            if (cleanData.status === 'pending') overallResults.pending++;
            setImportProgress((prev) => ({
              ...prev,
              created: prev.created + 1,
              current: i + 1
            }));
          } catch (error) {
            console.error(`❌ Retry create failed:`, error);
            overallResults.errors.push(`Failed to create ${cleanData.patient_name || 'Store Pickup'}: ${error.message}`);
            overallResults.failed++;
            setImportProgress((prev) => ({ ...prev, errors: prev.errors + 1, current: i + 1 }));
          }
          await delay(1000);
        }

        const failedUpdateOffset = failedCreations.length;
        for (let i = 0; i < failedUpdates.length; i++) {
          const { data: deliveryData } = failedUpdates[i];
          const { id, _changes, action, _matchReason, ...updatePayload } = deliveryData;

          try {
            if (!id) {
              throw new Error('Missing delivery ID');
            }

            const updatedDelivery = await retryWithBackoff(async () => {
              return await base44.entities.Delivery.update(id, cleanDeliveryData(updatePayload));
            }, 3, 2000, 2);
            
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updatedDelivery]);
            
            overallResults.updated++;
            if (updatePayload.status === 'completed') overallResults.completed++;
            if (updatePayload.status === 'in_transit' || updatePayload.status === 'en_route') overallResults.enRoute++;
            if (updatePayload.status === 'pending') overallResults.pending++;
            setImportProgress((prev) => ({
              ...prev,
              updated: prev.updated + 1,
              current: failedUpdateOffset + i + 1
            }));
          } catch (error) {
            console.error(`❌ Retry update failed:`, error);
            overallResults.errors.push(`Failed to update ${deliveryData.patient_name || 'Store Pickup'}: ${error.message}`);
            overallResults.failed++;
            setImportProgress((prev) => ({ ...prev, errors: prev.errors + 1, current: failedUpdateOffset + i + 1 }));
          }
          await delay(1000);
        }
      }

      setImportProgress((prev) => ({
        ...prev,
        phase: 'complete',
        current: prev.total,
        filesCompleted: prev.totalFiles,
        currentFile: ''
      }));
      
      setImportResult(overallResults);
      setProgressPercent(100);
      setProgressMessage('Import complete!');
      
      smartRefreshManager.restart();
      driverLocationPoller.resume();
      console.log('▶️ [ImportActiveRoutes] Resumed smart refresh and location poller');

    } catch (error) {
      console.error("❌ Overall import error:", error);
      overallResults.errors.push(`Overall import process failed: ${error.message}`);
      setImportResult(overallResults);
      setImportProgress((prev) => ({
        ...prev,
        phase: 'failed',
        currentFile: '',
        errors: prev.errors + 1
      }));
      setProgressMessage('Import failed!');
      setImportError({
        message: error.message,
        record: {
          driver: availableDrivers.find((d) => d.id === selectedDriverId)?.user_name || 'Unknown',
          files: files.map((f) => f.name).join(', '),
          created: overallResults.created,
          updated: overallResults.updated
        },
        lineNumber: null,
        phase: 'import'
      });
    } finally {
      smartRefreshManager.restart();
      driverLocationPoller.resume();
      setIsProcessing(false);
      setTimeout(() => setShowProgress(false), 1000);
    }
  };

  const getStatusBadge = (status) => {
    const statusColors = {
      'completed': 'bg-green-100 text-green-800',
      'failed': 'bg-red-100 text-red-800',
      'cancelled': 'bg-slate-100 text-slate-800',
      'in_transit': 'bg-blue-100 text-blue-800',
      'en_route': 'bg-blue-100 text-blue-800',
      'pending': 'bg-yellow-100 text-yellow-800'
    };
    const color = statusColors[status] || 'bg-slate-100 text-slate-800';
    return <Badge className={color}>{status}</Badge>;
  };

  const handleErrorStartOver = () => {
    setImportError(null);
    setFiles([]);
    setSelectedDriverId('');
    setIsProcessing(false);
    setImportResult(null);
    setShowPreview(false);
    setPreviewData({ deliveriesToCreate: [], deliveriesToUpdate: [], skippedItems: [], errors: [] });
    setIsParsing(false);
    setProgressPercent(0);
    setProgressMessage('');
    setShowProgress(false);
    setPatients([]);
    setPreviewFilterDriver('all');
    setPreviewFilterDate('all');
    setImportProgress({
      current: 0,
      total: 0,
      phase: '',
      created: 0,
      updated: 0,
      errors: 0,
      currentFile: '',
      filesCompleted: 0,
      totalFiles: 0
    });
  };

  const handleErrorCancel = () => {
    setImportError(null);
    if (onCancel) onCancel();
  };

  return (
    <>
      {/* Error Popup Dialog */}
      {importError && (
        <Dialog open={true} onOpenChange={() => setImportError(null)}>
          <DialogContent className="fixed left-[50%] top-[50%] z-[70000] translate-x-[-50%] translate-y-[-50%] gap-4 border bg-white shadow-lg duration-200 sm:rounded-lg w-full max-w-lg p-0">
            <DialogHeader className="px-6 py-4 border-b border-red-200 bg-red-50">
              <DialogTitle className="text-xl flex items-center gap-2 text-red-800">
                <XCircle className="w-6 h-6 text-red-600" />
                Import Error
              </DialogTitle>
              <DialogDescription className="text-red-700">
                An error occurred during the {importError.phase || 'import'} phase
              </DialogDescription>
            </DialogHeader>
            
            <div className="p-6 space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="font-semibold text-red-800 mb-2">Error Message:</p>
                <p className="text-red-700 text-sm font-mono">{importError.message}</p>
              </div>
              
              {importError.record && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                  <p className="font-semibold text-slate-800 mb-3">Record Details:</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {Object.entries(importError.record).map(([key, value]) => (
                      <React.Fragment key={key}>
                        <span className="text-slate-600 capitalize">{key.replace(/_/g, ' ')}:</span>
                        <span className="font-medium">{value}</span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>
            
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex gap-3">
              <Button onClick={handleErrorStartOver} className="flex-1 bg-blue-600 hover:bg-blue-700">
                Start Over
              </Button>
              <Button onClick={handleErrorCancel} variant="outline" className="flex-1">
                Cancel Import
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <style>{`
        [data-radix-dialog-overlay] {
          z-index: 60000 !important;
        }
        [role="dialog"] {
          z-index: 60001 !important;
        }
        [data-radix-popper-content-wrapper],
        [data-radix-select-content],
        [data-radix-select-viewport] {
          z-index: 60002 !important;
        }
      `}</style>
      
      <Dialog open={true} onOpenChange={(open) => !open && onCancel()}>
        <DialogContent className="fixed left-[50%] top-[50%] z-[10001] translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background shadow-lg duration-200 sm:rounded-lg w-full max-w-7xl max-h-[90vh] flex flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 py-2 text-center flex flex-col space-y-1.5 sm:text-left border-b border-slate-200 flex-shrink-0">
            <DialogTitle className="text-2xl flex items-center gap-2">
              <Upload className="w-6 h-6" />
              Import Active Routes
            </DialogTitle>
            <DialogDescription>
              Upload CSV files to import active/completed route data for a selected driver.
            </DialogDescription>
          </DialogHeader>

          {showProgress && (
            <div className="space-y-3 p-6 bg-slate-50 rounded-lg border-b border-slate-200 flex-shrink-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">
                  {isParsing ? progressMessage :
                    importProgress.phase === 'creating' ? `Creating deliveries: ${importProgress.current} / ${importProgress.total}` :
                    importProgress.phase === 'updating' ? `Updating deliveries: ${importProgress.current} / ${importProgress.total}` :
                    importProgress.phase === 'retrying' ? `Retrying operations: ${importProgress.current} / ${importProgress.total}` :
                    importProgress.phase === 'complete' ? 'Import complete!' :
                    importProgress.phase === 'failed' ? 'Import failed!' :
                    progressMessage
                  }
                </span>
                <span className="text-sm font-bold text-slate-900">
                  {isParsing ? `${progressPercent}%` :
                    importProgress.total > 0 ? `${Math.round(importProgress.current / importProgress.total * 100)}%` :
                    importProgress.phase === 'complete' ? '100%' : '0%'
                  }
                </span>
              </div>
              <Progress
                value={isParsing ? progressPercent :
                  importProgress.total > 0 ? (importProgress.current / importProgress.total * 100) :
                  importProgress.phase === 'complete' ? 100 : 0
                }
                className="h-2"
              />

              {!isParsing && (importProgress.created > 0 || importProgress.updated > 0 || importProgress.errors > 0) && (
                <div className="flex justify-between text-xs text-slate-600">
                  <span>Created: {importProgress.created}</span>
                  <span>Updated: {importProgress.updated}</span>
                  <span>Errors: {importProgress.errors}</span>
                </div>
              )}
            </div>
          )}

          {!showPreview ? (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-1">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="route-upload">Select Route Files (CSV/TSV/TXT)</Label>
                      <Input
                        id="route-upload"
                        type="file"
                        accept=".csv,.tsv,.txt"
                        multiple
                        onChange={handleFileChange}
                        disabled={isParsing || isProcessing || showProgress}
                      />
                      <p className="text-xs text-slate-500">Select multiple active route files to import.</p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="driver-select">Select Driver *</Label>
                      <Select value={selectedDriverId} onValueChange={setSelectedDriverId} disabled={isParsing || isProcessing || showProgress}>
                        <SelectTrigger id="driver-select" className="w-full">
                          <SelectValue placeholder="Choose a driver..." />
                        </SelectTrigger>
                        <SelectContent className="z-[10002]">
                          {availableDrivers.length > 0 ? (
                            availableDrivers.map((driver) => (
                              <SelectItem key={driver.id} value={driver.id}>
                                {getDriverDisplayName(driver)}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="none" disabled>
                              No drivers available
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
                    <h4 className="font-semibold mb-2">CSV Format (Active Routes)</h4>
                    <ul className="list-disc list-inside space-y-1 text-xs">
                      <li>Row 1: Ignored (header)</li>
                      <li>Row 2+: Date: <code>#YYYY-MM-DD#,Count,...</code></li>
                      <li>Col 1: Store Abbr, Col 2: AM/PM</li>
                      <li>Col 3: TR#, Col 4: Stop Order, Col 5: Pending Flag</li>
                      <li>Col 6-7: Start/End Time, Col 9: Travel Dist</li>
                      <li>Col 13-14: Ignored, Col 14: SID</li>
                      <li>Col 15: PID, Col 17: Notes</li>
                      <li><strong>Status:</strong> Pending (Col 5 negative), Completed (Order &gt; 0, Col 6 only), En Route (Order = 0, Col 6+7)</li>
                      <li><strong>Match:</strong> SID → TR# (±20 range) → PID → Abbr+AM/PM</li>
                    </ul>
                  </div>
                </div>

                {files.length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Selected Files ({files.length})</Label>
                    <div className="space-y-1 max-h-32 overflow-y-auto border rounded-lg p-2">
                      {files.map((file, index) => (
                        <div key={index} className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded text-sm">
                          <span className="truncate flex-1">{file.name}</span>
                          {!isParsing && !isProcessing && !showProgress && (
                            <button onClick={() => removeFile(index)} className="ml-2 text-slate-400 hover:text-red-600">
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {previewData.errors.length > 0 && (
                  <div className="space-y-1 mt-4">
                    <div className="flex items-center gap-2 text-red-600 font-semibold">
                      <XCircle className="w-5 h-5" />
                      <span>Parsing Errors: {previewData.errors.length}</span>
                    </div>
                    <div className="max-h-32 overflow-y-auto bg-red-50 p-2 rounded text-xs">
                      {previewData.errors.map((err, i) => (
                        <div key={`parse-err-${i}`} className="text-red-800">{err}</div>
                      ))}
                    </div>
                  </div>
                )}

                {previewData.skippedItems.length > 0 && (
                  <div className="space-y-1 mt-4">
                    <div className="flex items-center gap-2 text-orange-600 font-semibold">
                      <AlertCircle className="w-5 h-5" />
                      <span>Skipped Items: {previewData.skippedItems.length}</span>
                    </div>
                    <div className="max-h-32 overflow-y-auto bg-orange-50 p-2 rounded text-xs">
                      {previewData.skippedItems.map((item, i) => (
                        <div key={`skipped-item-${i}`} className="text-orange-800">
                          Line {item.lineNumber}: {item.reason} - <span className="font-mono text-[10px]">{item.rawData}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 p-6 pb-4">
                <div className="flex items-center justify-between gap-4 mb-4">
                  <div className="flex flex-col">
                    <span className="text-sm text-slate-500">
                      Importing for: <span className="font-semibold text-slate-700">{availableDrivers.find((d) => d.id === selectedDriverId)?.user_name || 'Unknown Driver'}</span>
                    </span>
                    <h3 className="text-lg font-semibold text-slate-800">Preview: {filteredPreviewDeliveries.length} Total Deliveries</h3>
                  </div>
                  <div className="flex items-center gap-3">
                    <Select value={previewFilterDate} onValueChange={setPreviewFilterDate}>
                      <SelectTrigger className="w-40">
                        <SelectValue placeholder="Filter by date" />
                      </SelectTrigger>
                      <SelectContent className="z-[10002]">
                        <SelectItem value="all">All Dates</SelectItem>
                        {previewDates.map((date) => (
                          <SelectItem key={date} value={date}>{date}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div className="flex flex-col items-center bg-green-50 border border-green-200 rounded-lg p-3">
                    <div className="text-xs text-green-700 mb-1">New Deliveries</div>
                    <div className="text-2xl font-bold text-green-800">{previewStats.creates}</div>
                  </div>

                  <div className="flex flex-col items-center bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <div className="text-xs text-blue-700 mb-1">Updates</div>
                    <div className="text-2xl font-bold text-blue-800">{previewStats.updates}</div>
                  </div>

                  <div className="flex flex-col items-center bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                    <div className="text-xs text-emerald-700 mb-1">Completed</div>
                    <div className="text-2xl font-bold text-emerald-800">{previewStats.completed}</div>
                  </div>

                  <div className="flex flex-col items-center bg-cyan-50 border border-cyan-200 rounded-lg p-3">
                    <div className="text-xs text-cyan-700 mb-1">En Route</div>
                    <div className="text-2xl font-bold text-cyan-800">{previewStats.enRoute}</div>
                  </div>

                  <div className="flex flex-col items-center bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                    <div className="text-xs text-yellow-700 mb-1">Pending</div>
                    <div className="text-2xl font-bold text-yellow-800">{previewStats.pending}</div>
                  </div>
                </div>
              </div>

              {filteredPreviewDeliveries.length === 0 ? (
                <div className="text-center text-slate-500 py-8 flex-1 flex items-center justify-center px-6">
                  No deliveries detected for import or matching filters.
                </div>
              ) : (
                <div className="flex-1 border rounded-lg flex flex-col overflow-hidden bg-white min-h-0 mx-6 mb-4">
                  <div className="flex-shrink-0 bg-slate-100 border-b">
                    <table className="w-full text-sm table-fixed">
                      <thead>
                        <tr>
                          <th className="p-1 text-left w-20">Type</th>
                          <th className="p-1 text-left w-24">Date</th>
                          <th className="p-1 text-left w-12">A/P</th>
                          <th className="p-1 text-left w-14">Order</th>
                          <th className="p-1 text-left w-28">TR# / PUID</th>
                          <th className="p-1 text-left w-22">SID/PID</th>
                          <th className="p-1 text-left w-48">Patient/Pickup</th>
                          <th className="p-1 text-left w-24">Status</th>
                          <th className="p-1 text-left w-20">Time</th>
                          <th className="p-1 text-left flex-1">Changes</th>
                        </tr>
                      </thead>
                    </table>
                  </div>

                  <div className="flex-1 overflow-y-auto min-h-0">
                    <table className="w-full text-sm table-fixed">
                      <tbody>
                        {filteredPreviewDeliveries.map((delivery, idx) => {
                          const store = stores.find((s) => s.id === delivery.store_id);
                          const timeFormatted = delivery.actual_delivery_time 
                            ? format(new Date(delivery.actual_delivery_time), 'HH:mm')
                            : delivery.delivery_time_start && delivery.delivery_time_end
                            ? `${delivery.delivery_time_start}-${delivery.delivery_time_end}`
                            : delivery.delivery_time_start || 'none';
                          const patient = delivery.patient_id ? patients.find((p) => p.id === delivery.patient_id) : null;

                          return (
                            <tr key={`${delivery.action}-${idx}`} className={`border-b ${delivery.action === 'create' ? 'bg-green-50 hover:bg-green-100' : 'bg-blue-50 hover:bg-blue-100'}`}>
                              <td className="p-1 w-20">
                                <Badge className={delivery.action === 'create' ? "bg-green-200 text-green-800" : "bg-blue-200 text-blue-800"}>
                                  {delivery.action === 'create' ? 'New' : 'Update'}
                                </Badge>
                              </td>
                              <td className="p-1 w-24 font-medium">{delivery.delivery_date}</td>
                              <td className="p-1 w-12 text-xs font-mono">{delivery.ampm_deliveries || '-'}</td>
                              <td className="p-1 font-mono text-xs w-14">{delivery.stop_order}</td>
                              <td className="p-1 font-mono text-xs w-28">
                                <div className="flex flex-col">
                                  <span>{delivery.tracking_number || '-'}</span>
                                  {delivery.puid && <span className="text-slate-500 text-[10px]">{delivery.puid}</span>}
                                </div>
                              </td>
                              <td className="p-1 font-mono text-xs w-22">
                                <div className="flex flex-col">
                                  {delivery.stop_id && <span className="font-semibold">{delivery.stop_id}</span>}
                                  {patient?.patient_id && <span className="text-slate-600">{patient.patient_id}</span>}
                                  {!delivery.stop_id && !patient?.patient_id && <span>N/A</span>}
                                </div>
                              </td>
                              <td className="p-1 w-48">
                                <span className="font-medium">{delivery.patient_name || store?.name || 'Unknown'}</span>
                              </td>
                              <td className="p-1 w-24">{getStatusBadge(delivery.status)}</td>
                              <td className="p-1 text-xs w-20">{timeFormatted}</td>
                              <td className="p-1 text-xs flex-1">
                                <div className="space-y-1">
                                  {delivery._matchReason && (
                                    <div className={`font-semibold ${delivery.action === 'create' ? 'text-red-600' : 'text-green-600'}`}>
                                      {delivery._matchReason}
                                    </div>
                                  )}
                                  {delivery.action === 'update' && delivery._changes && delivery._changes.length > 0 && (
                                    <>
                                      {delivery._changes.map((change, changeIdx) => (
                                        <div key={changeIdx} className="text-orange-700 font-medium">
                                          {change}
                                        </div>
                                      ))}
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="bg-white px-6 py-2 flex flex-col gap-3 border-t border-slate-200 flex-shrink-0">
            <div className="flex gap-3">
              {!showPreview ? (
                <>
                  <Button onClick={handlePreview} disabled={isParsing || isProcessing || files.length === 0 || !selectedDriverId || showProgress}>
                    {isParsing ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Parsing...
                      </>
                    ) : 'Preview Import'}
                  </Button>
                  <Button variant="outline" onClick={onCancel} disabled={isParsing || isProcessing || showProgress}>
                    Cancel
                  </Button>
                </>
              ) : importResult ? (
                <>
                  <Button
                    onClick={handleErrorStartOver}
                    variant="outline"
                    className="flex-1"
                  >
                    Start New Import
                  </Button>
                  <Button
                    onClick={async () => {
                      if (onImportComplete) {
                        await onImportComplete();
                      }
                    }}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                    disabled={isProcessing}
                  >
                    Done - Close Import
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setShowPreview(false)} disabled={isProcessing || showProgress} className="flex-1">
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back
                  </Button>
                  <Button onClick={handleConfirmImport} disabled={isProcessing || filteredPreviewDeliveries.length === 0 || showProgress} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Importing...
                      </>
                    ) : `Confirm Import (${filteredPreviewDeliveries.length})`}
                  </Button>
                </>
              )}
            </div>

            {importResult && (
              <div className="space-y-4 p-6 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-6 h-6 text-green-600" />
                  <h3 className="font-bold text-green-800">Import Complete!</h3>
                </div>
                <div className="grid grid-cols-4 gap-4 text-sm">
                  <div className="flex items-center justify-center gap-1">
                    <span className="text-slate-700">Created:</span>
                    <span className="font-semibold">{importResult.created}</span>
                  </div>
                  <div className="flex items-center justify-center gap-1">
                    <span className="text-slate-700">Updated:</span>
                    <span className="font-semibold">{importResult.updated}</span>
                  </div>
                  <div className="flex items-center justify-center gap-1">
                    <span className="text-slate-700">Completed:</span>
                    <span className="font-semibold">{importResult.completed}</span>
                  </div>
                  <div className="flex items-center justify-center gap-1">
                    <span className="text-slate-700">En Route:</span>
                    <span className="font-semibold">{importResult.enRoute}</span>
                  </div>
                </div>
                {importResult.errors && importResult.errors.length > 0 && (
                  <div className="mt-4">
                    <h4 className="font-semibold text-red-600 mb-2">Errors ({importResult.errors.length}):</h4>
                    <div className="bg-white border border-red-200 rounded p-3 max-h-40 overflow-y-auto text-xs">
                      {importResult.errors.map((err, idx) => (
                        <div key={idx} className="text-red-700 mb-1">{err}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}