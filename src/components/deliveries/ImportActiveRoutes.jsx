import React, { useState, useCallback, useMemo, useEffect } from "react";
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
import { processDeliveryNotes } from '../utils/notesProcessor';
import { executeDataOperation } from '../utils/dataOperationManager';

// Utility function for delay
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Utility function for retrying operations with exponential backoff
// CRITICAL: ULTRA CONSERVATIVE delays to prevent rate limits
const retryWithBackoff = async (fn, retries = 3, delayMs = 8000, factor = 2) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.message?.includes('429') || error.message?.includes('rate limit') || error.response?.status === 429;
      
      if (i < retries - 1) {
        // CRITICAL: VERY long delays for rate limits (minimum 10 seconds)
        const baseWait = isRateLimit ? 10000 : delayMs;
        const waitTime = Math.round(baseWait * Math.pow(factor, i));
        console.warn(`⚠️ Operation failed${isRateLimit ? ' (RATE LIMIT)' : ''}, retrying in ${waitTime}ms... (Attempt ${i + 1}/${retries})`);
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
  const [cachedDateRange, setCachedDateRange] = useState({ minDate: null, maxDate: null });

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
    const importedDeliveryDate = importedDelivery.delivery_date;
    const importedDriverId = importedDelivery.driver_id;

    const sameDateDeliveries = existingDeliveries.filter((d) => {
      if (d.delivery_date !== importedDeliveryDate) return false;
      if (importedDriverId && d.driver_id) {
        return d.driver_id === importedDriverId;
      }
      return true;
    });

    // ONLY MATCH BY STOP ID (SID)
    if (importedDeliveryStopId) {
      const sidMatch = sameDateDeliveries.find((d) => {
        const existingSID = (d.stop_id || '').trim();
        return existingSID === importedDeliveryStopId;
      });
      if (sidMatch) {
        return { match: sidMatch, reason: `SID Match (${importedDeliveryStopId})` };
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
      { key: 'delivery_time_start', label: 'Start Time' },
      { key: 'delivery_time_end', label: 'End Time' },
      { key: 'delivery_time_eta', label: 'ETA' },
      { key: 'driver_id', label: 'Driver' },
      { key: 'store_id', label: 'Store' }
    ];

    fieldsToCompare.forEach((field) => {
      const existingValue = existingDelivery[field.key];
      const importedValue = importedDelivery[field.key];

      const normalizedExisting = existingValue === null || existingValue === undefined || (typeof existingValue === 'string' && existingValue.trim() === '') ? null : existingValue;
      const normalizedImported = importedValue === null || importedValue === undefined || (typeof importedValue === 'string' && importedValue.trim() === '') ? null : importedValue;

      // CRITICAL: Skip stop_order comparison if imported value is 0 (will keep existing)
      if (field.key === 'stop_order') {
        const importedStopOrder = typeof normalizedImported === 'number' ? normalizedImported : parseInt(normalizedImported) || 0;
        // Only show change if imported > 0 AND different from existing
        if (importedStopOrder > 0 && normalizedExisting !== normalizedImported) {
          changes.push(`${field.label}: ${normalizedExisting || 'none'} → ${normalizedImported}`);
        }
        return; // Skip normal comparison for stop_order
      }

      // CRITICAL: Skip TR# comparison if values match OR if existing already has a value
      // (we don't want to show TR# change if it's effectively the same tracking info)
      if (field.key === 'tracking_number') {
        // If both have values and they match exactly, no change
        if (normalizedExisting === normalizedImported) return;
        // If existing has a value and imported is empty/null, no change (keep existing)
        if (normalizedExisting && !normalizedImported) return;
        // Only show change if imported has a value AND it's different
        if (normalizedImported && normalizedExisting !== normalizedImported) {
          changes.push(`${field.label}: ${normalizedExisting || 'none'} → ${normalizedImported}`);
        }
        return;
      }

      // CRITICAL: Skip COD Amount comparison if both are effectively zero/none
      if (field.key === 'cod_total_amount_required') {
        const existingCOD = normalizedExisting || 0;
        const importedCOD = normalizedImported || 0;
        // If both are 0/null/undefined, no change
        if (existingCOD === 0 && importedCOD === 0) return;
        // Otherwise check if different
        if (existingCOD !== importedCOD) {
          changes.push(`${field.label}: ${existingCOD || 'none'} → ${importedCOD || 'none'}`);
        }
        return;
      }

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

  // Extract driver name from filename (format: "Robert T Route.csv")
  const extractDriverFromFilename = (filename) => {
    // Remove file extension
    const nameWithoutExt = filename.replace(/\.(csv|tsv|txt)$/i, '');
    
    // Remove "Route" suffix if present (case insensitive)
    const driverName = nameWithoutExt.replace(/\s+Route$/i, '').trim();
    
    return driverName || null;
  };

  // Find driver user by matching filename driver name
  const findDriverByFilename = (filename) => {
    const driverNameFromFile = extractDriverFromFilename(filename);
    if (!driverNameFromFile) return null;

    const usersToSearch = allDriverUsers.length > 0 ? allDriverUsers : allUsers || [];
    const lowerName = driverNameFromFile.toLowerCase();
    
    return usersToSearch.find(u => {
      const userName = (u.user_name || u.full_name || '').toLowerCase();
      return userName === lowerName || userName.includes(lowerName);
    });
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
      // Column 13: PUID (Pickup ID - links deliveries to their originating pickup)
      const importedPuid = (values[12] || '').replace(/"/g, '').trim(); // Column 13: PUID (index 12)
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

      // Status determination based on column 5 (pendingIndicator), stopOrder, and time columns
      let deliveryStatus = 'pending';
      let actualDeliveryTime = null;
      let deliveryTimeStart = null;
      let deliveryTimeEnd = null; // CRITICAL: Do NOT import end time from CSV - use patient time window or leave blank
      let deliveryTimeEta = null;

      // RULE: Determine status based on pending indicator (col 5), stop order, times, and pickup type
      const isPendingIndicator = pendingIndicator < 0; // Column 5 negative = pending
      
      // CRITICAL: Check for FAILED status in notes FIRST before any other status logic
      const notesLower = rawNotes.toLowerCase();
      if (notesLower.includes('failed')) {
        // Failed status - set from notes, may or may not have completion time
        deliveryStatus = isPickup ? 'cancelled' : 'failed';
        // Use completion time if available
        if (originalStopOrder > 0 && deliveryStartTimeStr) {
          actualDeliveryTime = `${currentDate}T${deliveryStartTimeStr}:00`;
        }
      } else if (notesLower.includes('cancel')) {
        // Cancelled status
        deliveryStatus = 'cancelled';
        if (originalStopOrder > 0 && deliveryStartTimeStr) {
          actualDeliveryTime = `${currentDate}T${deliveryStartTimeStr}:00`;
        }
      } else if (originalStopOrder > 0 && deliveryStartTimeStr && !deliveryEndTimeStr) {
        // Completed - has stop order > 0, has start time only
        deliveryStatus = 'completed';
        // CRITICAL: Save as local time string (YYYY-MM-DDTHH:MM:SS) without timezone
        actualDeliveryTime = `${currentDate}T${deliveryStartTimeStr}:00`;
      } else if (isPendingIndicator && isPickup && deliveryStartTimeStr) {
        // EXCEPTION: Pickups with times should be en_route even if pending indicator is negative
        deliveryStatus = 'en_route';
        deliveryTimeStart = deliveryStartTimeStr;
        // Do NOT set deliveryTimeEnd from CSV - leave blank
        deliveryTimeEta = deliveryStartTimeStr;
      } else if (isPendingIndicator) {
        // Pending indicator is negative - status is pending
        deliveryStatus = 'pending';
        deliveryTimeStart = null;
        deliveryTimeEnd = null;
      } else if (originalStopOrder === 0 && deliveryStartTimeStr) {
        // Active (in transit/en route) - stop order = 0, has start time, not pending
        deliveryStatus = isPickup ? 'en_route' : 'in_transit';
        deliveryTimeStart = deliveryStartTimeStr;
        // Do NOT set deliveryTimeEnd from CSV - leave blank
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
        time_window_start: deliveryTimeStart,
        time_window_end: deliveryTimeEnd,
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
        delivery_notes: null,
        first_delivery: false,
        puid: importedPuid || null // Use imported PUID from column 13
      };

      // CRITICAL: Note - failure detection already handled in status determination section above
      // This prevents overriding the early FAILED/CANCELLED detection

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
        
        // CRITICAL: Set time windows from patient record ONLY for pending deliveries
        // For active stops (in_transit/en_route), preserve imported times from CSV
        const isActiveStop = newDeliveryData.status === 'in_transit' || newDeliveryData.status === 'en_route';
        
        if (patient.time_window_start) {
          newDeliveryData.time_window_start = patient.time_window_start;
          // Only override delivery_time_start if NOT imported and NOT an active stop
          if (!newDeliveryData.delivery_time_start && !isActiveStop) {
            newDeliveryData.delivery_time_start = patient.time_window_start;
          }
        }
        if (patient.time_window_end) {
          newDeliveryData.time_window_end = patient.time_window_end;
          // Only set delivery_time_end for non-active stops
          if (!isActiveStop) {
            newDeliveryData.delivery_time_end = patient.time_window_end;
          }
        } else {
          // Patient has no time_window_end - ensure we leave it blank unless already set
          if (!isActiveStop) {
            newDeliveryData.time_window_end = null;
            newDeliveryData.delivery_time_end = null;
          }
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

      // CRITICAL: Use shared notes processor for consistency with Past Routes importer
      const isCompletedStatus = deliveryStatus === 'completed' || deliveryStatus === 'failed' || deliveryStatus === 'cancelled';
      const cleanedNotes = processDeliveryNotes(rawNotes, newDeliveryData, patient, isPickup, isCompletedStatus);
      newDeliveryData.delivery_notes = cleanedNotes;

      const matchResult = matchDeliveryToExisting(newDeliveryData, allDeliveriesData, patientsData);
      const existingDelivery = matchResult?.match || null;
      const matchReason = matchResult?.reason || 'Unknown';

      if (existingDelivery) {
        // EXISTING DELIVERY MATCHED BY SID: Replace all data from import (except ID and notes)
        // CRITICAL: For completed stops, use imported stop_order
        // For active stops (in_transit/en_route) with stop_order=0, preserve existing stop_order
        let effectiveStopOrder = stopOrder;
        if (stopOrder === 0 && (deliveryStatus === 'in_transit' || deliveryStatus === 'en_route')) {
          // Active stop - preserve existing stop_order if available
          effectiveStopOrder = existingDelivery.stop_order || 0;
        }
        
        // CRITICAL: Preserve existing first_delivery flag if already true
        const effectiveFirstDelivery = existingDelivery.first_delivery === true ? true : newDeliveryData.first_delivery;
        
        // CRITICAL: Preserve existing failed/cancelled status - don't change to completed unless import has actual completion time
        let effectiveStatus = deliveryStatus;
        if ((existingDelivery.status === 'failed' || existingDelivery.status === 'cancelled') && 
            deliveryStatus === 'completed' && 
            !actualDeliveryTime) {
          // Keep existing failed/cancelled status if import doesn't have actual completion time
          effectiveStatus = existingDelivery.status;
        }
        
        const updatedDeliveryData = {
          ...newDeliveryData,
          id: existingDelivery.id,
          delivery_notes: existingDelivery.delivery_notes || null,
          // CRITICAL: Use effective stop_order (preserves existing for active stops)
          stop_order: effectiveStopOrder,
          // CRITICAL: Use effective status (preserves failed/cancelled)
          status: effectiveStatus,
          // CRITICAL: Use effective first_delivery (preserves existing true values)
          first_delivery: effectiveFirstDelivery,
          // CRITICAL: Always use imported actual_delivery_time
          actual_delivery_time: actualDeliveryTime
        };

        // CRITICAL: Import travel_dist if provided and stop is finished
        const finishedStatuses = ['completed', 'failed', 'cancelled'];
        if (finishedStatuses.includes(deliveryStatus) && travelDist !== null) {
          updatedDeliveryData.travel_dist = travelDist;
        } else if (existingDelivery.travel_dist) {
          // Preserve existing travel_dist for incomplete stops
          updatedDeliveryData.travel_dist = existingDelivery.travel_dist;
        }

        // Detect changes between existing and imported data
        const changes = detectChanges(existingDelivery, updatedDeliveryData);

        // CRITICAL: Only add to updates if there are ACTUAL changes
        // This reduces API calls and prevents unnecessary rate limit hits
        if (changes.length > 0) {
          deliveriesToUpdate.push({
            ...updatedDeliveryData,
            _changes: changes,
            _matchReason: matchReason
          });
        } else {
          // No changes detected - skip this delivery to reduce API calls
          skippedItems.push({
            lineNumber,
            reason: `No changes detected (SID: ${stopId})`,
            rawData: `${updatedDeliveryData.patient_name || 'Pickup'} - Status: ${updatedDeliveryData.status}`
          });
        }
      } else {
        // NEW DELIVERY: Assign sequential stop order only if imported value is 0 or missing
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
          
          // Increment and assign next stop order for NEW deliveries only
          const nextStopOrder = maxStopOrderByDateDriver.get(dateDriverKey) + 1;
          maxStopOrderByDateDriver.set(dateDriverKey, nextStopOrder);
          stopOrder = nextStopOrder;
        }

        const newDeliveryId = generateDeliveryId(Array.from(existingDeliveryIds));
        existingDeliveryIds.add(newDeliveryId);

        // CRITICAL: Ensure delivery_id and dispatcher_id are set for new deliveries
        deliveriesToCreate.push({
          ...newDeliveryData,
          delivery_id: newDeliveryId,
          dispatcher_id: dispatcherId || null,
          stop_id: newDeliveryData.stop_id || null,
          stop_order: stopOrder, // Use calculated or imported stop_order
          _matchReason: matchReason
        });
      }
    }

    // PUID Update Pass and Pending Delivery Time Assignment
    // CRITICAL: PUIDs are now imported from column 13 - only update if not already set
    const allParsedDeliveries = [...deliveriesToCreate, ...deliveriesToUpdate];
    const pickupMap = new Map();
    const pickupTimeMap = new Map(); // Track pickup delivery_time_start for pending deliveries

    // CRITICAL: First pass - map all pickups by store/AM-PM to their stop_ids (for fallback PUID assignment)
    allParsedDeliveries.forEach((d) => {
      if (!d.patient_id && d.store_id && d.stop_id && d.ampm_deliveries) {
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries}`;
        pickupMap.set(key, d.stop_id);
        
        if (d.delivery_time_start) {
          pickupTimeMap.set(key, d.delivery_time_start);
        }
      }
    });

    // CRITICAL: Second pass - only assign PUIDs if not already imported from CSV
    allParsedDeliveries.forEach((d) => {
      // If PUID was imported from column 13, keep it
      if (d.puid) {
        console.log(`✅ [PUID] Using imported PUID: ${d.puid}`);
      } else if (!d.patient_id && d.stop_id) {
        // Pickups without imported PUID: puid = stop_id (self-referencing)
        d.puid = d.stop_id;
        console.log(`🔗 [PUID] Pickup self-reference: SID=${d.stop_id} → PUID=${d.puid}`);
      } else if (d.patient_id && d.store_id && d.ampm_deliveries) {
        // Patient deliveries without imported PUID: find matching pickup by store_id + AM/PM
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries}`;
        const matchingPuid = pickupMap.get(key);
        
        if (matchingPuid) {
          d.puid = matchingPuid;
          console.log(`🔗 [PUID] Patient delivery (fallback): ${d.patient_name} → PUID=${matchingPuid}`);
        } else {
          console.warn(`⚠️ [PUID] No matching pickup found for: ${d.patient_name}`);
        }
      }
      
      // CRITICAL: For pending deliveries, set delivery_time_start from pickup + 5 min (only if not already set)
      if (d.patient_id && d.status === 'pending' && !d.delivery_time_start) {
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries}`;
        const pickupTimeStart = pickupTimeMap.get(key);
        if (pickupTimeStart) {
          const [hours, minutes] = pickupTimeStart.split(':').map(Number);
          const totalMinutes = hours * 60 + minutes + 5;
          const newHours = Math.floor(totalMinutes / 60) % 24;
          const newMinutes = totalMinutes % 60;
          d.delivery_time_start = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
          d.delivery_time_eta = d.delivery_time_start;
          d.delivery_time_end = null;
          d.time_window_end = null;
        }
      }
      
      // CRITICAL: Ensure delivery_time_end is ONLY set if patient has time_window_end
      if (d.patient_id) {
        const deliveryPatient = patientsData.find(p => p.id === d.patient_id);
        if (deliveryPatient) {
          // Set time windows from patient record
          if (deliveryPatient.time_window_start) {
            d.time_window_start = deliveryPatient.time_window_start;
          }
          if (deliveryPatient.time_window_end) {
            d.time_window_end = deliveryPatient.time_window_end;
            d.delivery_time_end = deliveryPatient.time_window_end;
          } else {
            // No patient time_window_end - ensure blank
            d.delivery_time_end = null;
            d.time_window_end = null;
          }
        }
      } else {
        // Pickups - no end time
        d.delivery_time_end = null;
        d.time_window_end = null;
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
  useEffect(() => {
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

    setIsParsing(true);
    setImportResult(null);
    setShowProgress(true);
    setProgressPercent(0);
    setProgressMessage('Starting preview generation...');
    setPreviewFilterDriver('all');
    setPreviewFilterDate('all');

    try {

      setProgressMessage('Analyzing import files for date range...');
      setProgressPercent(5);
      
      const dateRange = await extractDateRangeFromFiles(files);
      
      if (!dateRange.minDate || !dateRange.maxDate) {
        alert('Could not detect any dates in the import files. Please ensure files contain date metadata lines (e.g., #2024-01-15#,...)');
        setIsParsing(false);
        setShowProgress(false);
        return;
      }
      
      // Cache date range for use during import (avoids re-reading files)
      setCachedDateRange(dateRange);
      const { minDate, maxDate } = dateRange;

      // Extract unique driver IDs from file names to limit delivery fetch
      const uniqueDriverIds = new Set();
      for (const file of files) {
        const driverFromFile = findDriverByFilename(file.name);
        if (driverFromFile?.id) {
          uniqueDriverIds.add(driverFromFile.id);
        }
      }
      const driverIdsArray = Array.from(uniqueDriverIds);
      
      setProgressMessage(`Date range: ${minDate} to ${maxDate}, Drivers: ${driverIdsArray.length}`);
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

      setProgressMessage(`Loading deliveries from offline cache for ${driverIdsArray.length} driver(s) (${minDate} to ${maxDate})...`);
      setProgressPercent(25);

      // CRITICAL: Fetch deliveries from OFFLINE DATABASE (no API calls!)
      const allOfflineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      const freshDeliveries = allOfflineDeliveries.filter(d => {
        if (!d.delivery_date || d.delivery_date < minDate || d.delivery_date > maxDate) return false;
        if (driverIdsArray.length > 0 && !driverIdsArray.includes(d.driver_id)) return false;
        return true;
      });
      
      console.log(`📦 [Preview] Loaded ${freshDeliveries.length} deliveries from offline cache`);
      setProgressPercent(35);

      let totalToCreate = [];
      let totalToUpdate = [];
      let totalSkippedItems = [];
      let totalErrors = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgressMessage(`Processing file ${i + 1} of ${files.length}: ${file.name}...`);

        // Extract driver from filename
        const driverFromFile = findDriverByFilename(file.name);
        if (!driverFromFile) {
          totalErrors.push(`Could not detect driver from filename: ${file.name}`);
          continue;
        }

        const text = await file.text();
        const result = await processCSVData(text, file.name, driverFromFile, freshDeliveries, freshPatients, freshStoresAll);

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
      currentFile: '',
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
      // CRITICAL: Use centralized data operation manager to handle pause/restart
      await executeDataOperation(async () => {
        driverLocationPoller.pause();
        console.log('⏸️ [ImportActiveRoutes] Starting import with data operation manager');
        
        const { offlineDB } = await import('../utils/offlineDatabase');

      setProgressMessage('Loading latest patient and store data from cache...');
      const freshPatients = await getData('Patient', '-created_date', null, false);
      const freshStores = await getData('Store', '-created_date', null, false);

      const deliveriesToCreateFiltered = filteredPreviewDeliveries.filter((d) => d.action === 'create');
      const deliveriesToUpdateFiltered = filteredPreviewDeliveries.filter((d) => d.action === 'update');

        batchUpdateAMPM(deliveriesToCreateFiltered);
        batchUpdateAMPM(deliveriesToUpdateFiltered);

        // BATCH CREATE - using local-first approach (no rate limits!)
        if (deliveriesToCreateFiltered.length > 0) {
          setImportProgress((prev) => ({
            ...prev,
            phase: 'creating',
            total: deliveriesToCreateFiltered.length,
            current: 0
          }));
          setProgressMessage(`Creating ${deliveriesToCreateFiltered.length} new deliveries...`);

          const cleanedDeliveries = deliveriesToCreateFiltered.map(cleanDeliveryData);

          // Direct batch create - backend only (IndexedDB will sync automatically)
          try {
            await base44.entities.Delivery.bulkCreate(cleanedDeliveries);

            cleanedDeliveries.forEach((cleanData) => {
              overallResults.created++;
              if (cleanData.status === 'completed') overallResults.completed++;
              if (cleanData.status === 'in_transit' || cleanData.status === 'en_route') overallResults.enRoute++;
              if (cleanData.status === 'pending') overallResults.pending++;
              if (cleanData.status === 'failed') overallResults.failed++;
            });

            setImportProgress((prev) => ({
              ...prev,
              created: cleanedDeliveries.length,
              current: cleanedDeliveries.length
            }));
          } catch (error) {
            console.warn(`⚠️ Batch create failed:`, error.message);
            failedCreations.push({ data: cleanedDeliveries, error: error.message });
          }
        }

        // BATCH UPDATES - using local-first approach (no rate limits!)
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
              if (!id) throw new Error('Missing delivery ID');

              const cleanPayload = cleanDeliveryData(updatePayload);

              // Direct update - backend only (IndexedDB will sync automatically)
              await base44.entities.Delivery.update(id, cleanPayload);

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
            } catch (error) {
              // CRITICAL: Silently skip 404 errors (delivery not found) - common during imports
              const is404 = error.response?.status === 404 || error.message?.includes('not found');
              if (!is404) {
                console.warn(`⚠️ Update failed for delivery ID ${deliveryData.id}:`, error.message);
                failedUpdates.push({ data: deliveryData, error: error.message });
              }
              setImportProgress((prev) => ({ ...prev, current: i + 1 }));
            }
          }
        }

        // Retry failed operations - using local-first approach
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
              await base44.entities.Delivery.create(cleanData);
              
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
          }

          const failedUpdateOffset = failedCreations.length;
          for (let i = 0; i < failedUpdates.length; i++) {
            const { data: deliveryData } = failedUpdates[i];
            const { id, _changes, action, _matchReason, ...updatePayload } = deliveryData;

            try {
              if (!id) throw new Error('Missing delivery ID');

              const cleanPayload = cleanDeliveryData(updatePayload);
              await base44.entities.Delivery.update(id, cleanPayload);
              
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
       setProgressPercent(95);

         // CRITICAL: Consolidate stop reordering and flag updates into ONE fetch + update pass
         setProgressMessage('Reordering stops and setting flags...');
        
        let allFreshDeliveries = null; // Declare at higher scope for reuse
        
        try {
          const { minDate, maxDate } = cachedDateRange;
          
          if (minDate && maxDate) {
            // Get all drivers that were imported
            const allDriversInRange = new Set();
            [...previewData.deliveriesToCreate, ...previewData.deliveriesToUpdate].forEach(d => {
              if (d.driver_id) allDriversInRange.add(d.driver_id);
            });
            
            // CRITICAL: Fetch ALL deliveries ONCE for both reorder and flags
            console.log(`📥 [Reorder+Flags] Fetching all deliveries for ${minDate} to ${maxDate} (${allDriversInRange.size} drivers)`);
            allFreshDeliveries = await retryWithBackoff(async () => {
              return await base44.entities.Delivery.filter({
                delivery_date: { $gte: minDate, $lte: maxDate }
              }, '-delivery_date', 5000);
            });
            
            // CRITICAL: Very long cooldown after large fetch (8 seconds)
            console.log('⏸️ Cooling down after large fetch...');
            await delay(8000);
            
            // Map by driver_id for quick lookup
            const deliveriesByDriver = {};
            (allFreshDeliveries || []).forEach(d => {
              if (!d.driver_id) return;
              if (!deliveriesByDriver[d.driver_id]) {
                deliveriesByDriver[d.driver_id] = [];
              }
              deliveriesByDriver[d.driver_id].push(d);
            });
            
            // Process each driver sequentially with delays
            for (const driverId of allDriversInRange) {
              const driverDeliveries = deliveriesByDriver[driverId] || [];
              
              // Group by date
              const deliveriesByDate = {};
              driverDeliveries.forEach(d => {
                if (!d || !d.delivery_date) return;
                if (!deliveriesByDate[d.delivery_date]) {
                  deliveriesByDate[d.delivery_date] = [];
                }
                deliveriesByDate[d.delivery_date].push(d);
              });
              
              for (const [date, dateDeliveries] of Object.entries(deliveriesByDate)) {
                const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
                
                // Sort and reorder stops
                const sortedDeliveries = [...dateDeliveries].sort((a, b) => {
                  const aFinished = finishedStatuses.includes(a.status);
                  const bFinished = finishedStatuses.includes(b.status);
                  
                  if (aFinished && !bFinished) return -1;
                  if (!aFinished && bFinished) return 1;
                  
                  if (aFinished && bFinished) {
                    return (a.stop_order || 999) - (b.stop_order || 999);
                  }
                  
                  const aOrder = a.stop_order || 0;
                  const bOrder = b.stop_order || 0;
                  
                  if (aOrder > 0 && bOrder > 0) return aOrder - bOrder;
                  if (aOrder > 0) return -1;
                  if (bOrder > 0) return 1;
                  
                  const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
                  const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
                  return etaA.localeCompare(etaB);
                });
                
                // Batch updates to avoid Promise.all flooding
                const allUpdates = [];
                
                // 1. Reset ALL isNextDelivery flags
                sortedDeliveries.forEach(d => {
                  if (d.isNextDelivery === true) {
                    allUpdates.push({ id: d.id, data: { isNextDelivery: false } });
                  }
                });
                
                // 2. Update stop_order for changed deliveries
                for (let i = 0; i < sortedDeliveries.length; i++) {
                  const delivery = sortedDeliveries[i];
                  const newStopOrder = i + 1;
                  
                  if (delivery.stop_order !== newStopOrder) {
                    allUpdates.push({ id: delivery.id, data: { stop_order: newStopOrder } });
                  }
                }
                
                // 3. Set isNextDelivery for first incomplete
                const firstIncomplete = sortedDeliveries.find(d => !finishedStatuses.includes(d.status));
                if (firstIncomplete) {
                  allUpdates.push({ id: firstIncomplete.id, data: { isNextDelivery: true } });
                }
                
                // Process stop order updates (direct backend calls - IndexedDB syncs automatically)
                for (const update of allUpdates) {
                  await base44.entities.Delivery.update(update.id, update.data);
                }
                
                console.log(`✅ [ImportActiveRoutes] Processed ${allUpdates.length} stop updates for ${driverId} on ${date}`);
                
                // Long delay between dates
                await delay(3000);
              }
              
              // Long delay between drivers
              await delay(5000);
            }
          }
        } catch (reorderError) {
          console.error('❌ [ImportActiveRoutes] Failed to reorder stops:', reorderError);
          // Non-fatal - continue with import completion
        }
      
        setProgressPercent(100);
        setProgressMessage('Import complete!');
        
        // CRITICAL: Dispatch events IMMEDIATELY without reordering delay
        const { minDate, maxDate } = cachedDateRange;

        if (minDate && maxDate) {
         console.log(`📥 [ImportActiveRoutes] Dispatching deliveries for ${minDate} to ${maxDate}`);
         // Note: allFreshDeliveries was already fetched during the nextDelivery flags step above
         const allDriversDeliveries = allFreshDeliveries || [];
        
        // CRITICAL: Dispatch event with full deliveries array to update UI immediately
        window.dispatchEvent(new CustomEvent('deliveriesImported', {
          detail: { 
            source: 'activeRoutesImport',
            count: overallResults.created + overallResults.updated,
            deliveries: allDriversDeliveries // Pass full deliveries to update all markers
          }
        }));
      } else {
        // Fallback: just trigger refresh without deliveries array
        window.dispatchEvent(new CustomEvent('deliveriesImported', {
          detail: { 
            source: 'activeRoutesImport',
            count: overallResults.created + overallResults.updated
          }
        }));
      }
      
      // Force refresh of delivery stats
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      
      // Force refresh of driver locations to update map markers
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: null }
      }));
      
        // Trigger full data refresh for Dashboard
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { 
            triggeredBy: 'activeRoutesImport',
            forceRefresh: true
          }
        }));
        
        driverLocationPoller.resume();
        console.log('✅ [ImportActiveRoutes] Import operation complete');
        
        return true; // Signal success to data operation manager
      }, { restartDelay: 2000 }); // 2 second delay before restarting smart refresh

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
          files: files.map((f) => f.name).join(', '),
          created: overallResults.created,
          updated: overallResults.updated
        },
        lineNumber: null,
        phase: 'import'
      });
      
      driverLocationPoller.resume();
    } finally {
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
    // CRITICAL: Reset ALL state to initial values to allow fresh import
    setImportError(null);
    setFiles([]);
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
    
    // CRITICAL: Reset file input element to allow re-selecting the same file
    const fileInput = document.getElementById('route-upload');
    if (fileInput) {
      fileInput.value = '';
    }
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
                      <div key={key} className="contents">
                        <span className="text-slate-600 capitalize">{key.replace(/_/g, ' ')}:</span>
                        <span className="font-medium">{value}</span>
                      </div>
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
        <DialogContent className="fixed left-[50%] top-[50%] z-[10001] translate-x-[-50%] translate-y-[-50%] gap-4 border shadow-lg duration-200 sm:rounded-lg w-full max-w-7xl max-h-[90vh] flex flex-col overflow-hidden p-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <DialogHeader className="px-6 py-2 text-center flex flex-col space-y-1.5 sm:text-left border-b flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)' }}>
            <DialogTitle className="text-2xl flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
              <Upload className="w-6 h-6" />
              Import Active Routes
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--text-slate-600)' }}>
              Upload CSV files to import active/completed route data for a selected driver.
            </DialogDescription>
          </DialogHeader>

          {showProgress && (
            <div className="space-y-3 p-6 rounded-lg border-b flex-shrink-0" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>
                  {isParsing ? progressMessage :
                    importProgress.phase === 'creating' ? `Creating deliveries: ${importProgress.current} / ${importProgress.total}` :
                    importProgress.phase === 'updating' ? `Updating deliveries: ${importProgress.current} / ${importProgress.total}` :
                    importProgress.phase === 'retrying' ? `Retrying operations: ${importProgress.current} / ${importProgress.total}` :
                    importProgress.phase === 'complete' ? 'Import complete!' :
                    importProgress.phase === 'failed' ? 'Import failed!' :
                    progressMessage
                  }
                </span>
                <span className="text-sm font-bold" style={{ color: 'var(--text-slate-900)' }}>
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
                <div className="flex justify-between text-xs" style={{ color: 'var(--text-slate-600)' }}>
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
                      <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                        Driver name will be extracted from filenames (e.g., "John Doe - 2024-01-15.csv")
                      </p>
                    </div>

                    {files.length > 0 && (
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Selected Files ({files.length})</Label>
                        <div className="space-y-1 max-h-60 overflow-y-auto border rounded-lg p-2" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
                          {files.map((file, index) => {
                            const driverFromFile = findDriverByFilename(file.name);
                            return (
                              <div key={index} className="flex items-center justify-between px-3 py-2 rounded text-sm" style={{ background: 'var(--bg-slate-100)' }}>
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium truncate">{file.name}</div>
                                  {driverFromFile ? (
                                    <div className="text-xs text-green-600 font-medium">
                                      ✓ Driver: {getDriverDisplayName(driverFromFile)}
                                    </div>
                                  ) : (
                                    <div className="text-xs text-red-600 font-medium">
                                      ⚠ No driver detected
                                    </div>
                                  )}
                                </div>
                                {!isParsing && !isProcessing && !showProgress && (
                                  <button onClick={() => removeFile(index)} className="ml-2 hover:text-red-600" style={{ color: 'var(--text-slate-400)' }}>
                                    <X className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg p-4 text-sm" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)', border: '1px solid' }}>
                    <h4 className="font-semibold mb-2">CSV Format (Active Routes)</h4>
                    <ul className="list-disc list-inside space-y-1 text-xs">
                      <li><strong>Filename:</strong> "Driver Name Route.csv"</li>
                      <li>Row 1: Ignored (header)</li>
                      <li>Row 2+: Date: <code>#YYYY-MM-DD#,Count,...</code></li>
                      <li>Col 1: Store Abbr, Col 2: AM/PM (1=AM, 2=PM)</li>
                      <li>Col 3: TR#, Col 4: Stop Order, Col 5: Pending Flag</li>
                      <li>Col 6-7: Start/End Time, Col 9: Travel Dist</li>
                      <li>Col 13: PUID, Col 14: SID, Col 15: PID</li>
                      <li>Col 17: Notes</li>
                      <li><strong>Status:</strong> Pending (Col 5 negative), Completed (Order &gt; 0 + Col 6 only), En Route (Order = 0 + Col 6+7)</li>
                    </ul>
                  </div>
                </div>

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
                    <span className="text-sm" style={{ color: 'var(--text-slate-500)' }}>
                      Importing {files.length} file(s) for multiple drivers
                    </span>
                    <h3 className="text-lg font-semibold" style={{ color: 'var(--text-slate-800)' }}>Preview: {filteredPreviewDeliveries.length} Total Deliveries</h3>
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
                  <div className="flex flex-col items-center rounded-lg p-3 border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                    <div className="text-xs mb-1 text-green-600">New Deliveries</div>
                    <div className="text-2xl font-bold text-green-600">{previewStats.creates}</div>
                  </div>

                  <div className="flex flex-col items-center rounded-lg p-3 border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                    <div className="text-xs mb-1 text-blue-600">Updates</div>
                    <div className="text-2xl font-bold text-blue-600">{previewStats.updates}</div>
                  </div>

                  <div className="flex flex-col items-center rounded-lg p-3 border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                    <div className="text-xs mb-1 text-emerald-600">Completed</div>
                    <div className="text-2xl font-bold text-emerald-600">{previewStats.completed}</div>
                  </div>

                  <div className="flex flex-col items-center rounded-lg p-3 border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                    <div className="text-xs mb-1 text-cyan-600">En Route</div>
                    <div className="text-2xl font-bold text-cyan-600">{previewStats.enRoute}</div>
                  </div>

                  <div className="flex flex-col items-center rounded-lg p-3 border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                    <div className="text-xs mb-1 text-yellow-500">Pending</div>
                    <div className="text-2xl font-bold text-yellow-500">{previewStats.pending}</div>
                  </div>
                </div>
              </div>

              {filteredPreviewDeliveries.length === 0 ? (
                <div className="text-center py-8 flex-1 flex items-center justify-center px-6" style={{ color: 'var(--text-slate-500)' }}>
                  No deliveries detected for import or matching filters.
                </div>
              ) : (
                <div className="flex-1 border rounded-lg flex flex-col overflow-hidden min-h-0 mx-6 mb-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <div className="flex-shrink-0 border-b" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                    <table className="w-full text-sm table-fixed">
                      <thead>
                        <tr style={{ color: 'var(--text-slate-700)' }}>
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
                            <tr 
                              key={`${delivery.action}-${idx}`} 
                              className="border-b"
                              style={{ 
                                background: 'var(--bg-slate-50)', 
                                borderColor: 'var(--border-slate-200)',
                                color: 'var(--text-slate-900)'
                              }}
                            >
                              <td className="p-1 w-20">
                                <Badge className={delivery.action === 'create' ? "bg-green-600 text-white" : "bg-blue-600 text-white"}>
                                  {delivery.action === 'create' ? 'New' : 'Update'}
                                </Badge>
                              </td>
                              <td className="p-1 w-24">
                                <div className="font-medium">{delivery.delivery_date}</div>
                                <div className="text-[10px]" style={{ color: 'var(--text-slate-500)' }}>{delivery.driver_name || 'Unknown'}</div>
                              </td>
                              <td className="p-1 w-12 text-xs font-mono">{delivery.ampm_deliveries || '-'}</td>
                              <td className="p-1 font-mono text-xs w-14">
                                {delivery.action === 'update' ? (
                                  <span title="From existing delivery">{delivery.stop_order}</span>
                                ) : (
                                  delivery.stop_order
                                )}
                              </td>
                              <td className="p-1 font-mono text-xs w-28">
                                <div className="flex flex-col">
                                  <span>{delivery.tracking_number || '-'}</span>
                                  {delivery.puid && <span style={{ color: 'var(--text-slate-500)' }} className="text-[10px]">{delivery.puid}</span>}
                                </div>
                              </td>
                              <td className="p-1 font-mono text-xs w-22">
                                <div className="flex flex-col">
                                  {delivery.stop_id && <span className="font-semibold">{delivery.stop_id}</span>}
                                  {patient?.patient_id && <span style={{ color: 'var(--text-slate-600)' }}>{patient.patient_id}</span>}
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
                                    <div className={`font-semibold ${delivery.action === 'create' ? 'text-red-500' : 'text-green-500'}`}>
                                      {delivery._matchReason}
                                    </div>
                                  )}
                                  {delivery.action === 'update' && delivery._changes && delivery._changes.length > 0 && (
                                    <>
                                      {delivery._changes.map((change, changeIdx) => (
                                        <div key={changeIdx} className="text-orange-500 font-medium">
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

          <div className="px-6 py-2 flex flex-col gap-3 border-t flex-shrink-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex gap-3">
              {!showPreview ? (
                <>
                  <Button onClick={handlePreview} disabled={isParsing || isProcessing || files.length === 0 || showProgress}>
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