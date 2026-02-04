import React, { useState, useEffect } from "react";
import { Patient } from "@/entities/Patient";
import { Store } from "@/entities/Store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, CheckCircle, XCircle, AlertCircle, X, ArrowRight } from "lucide-react";
import { cleanAddressAndNotes } from "../utils/addressParser";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";
import MissingPatientsPopup from "./MissingPatientsPopup";
import { executeDataOperation } from "../utils/dataOperationManager";
import { offlineDB } from "../utils/offlineDatabase";

export default function PatientImport({ onImportComplete, onImportStart, currentUser, onClose }) {
  const [files, setFiles] = useState([]);
  const [columnCount, setColumnCount] = useState(0);
  // previewData will now store processed Patient-like objects for the live preview table
  const [previewData, setPreviewData] = useState([]);
  const fileInputRef = React.useRef(null);

  // FIXED COLUMN MAPPING - NO USER INPUT NEEDED
  const fieldMapping = {
    store_abbreviation: '1',
    patient_id: '20',
    full_name: '2',
    address: '3',
    phone: '4',
    notes: '5',
    last_delivery_date: '13',
    distance_from_store: '14',
    time_window_start: '15',
    time_window_end: '16',
    latitude: '17',
    longitude: '18',
    inactive_flag: '19' // Col 19: 'X' = inactive patient
  };

  const [isProcessing, setIsProcessing] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [stores, setStores] = useState([]); // Only stores are needed now, not users
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
  const [showPreview, setShowPreview] = useState(false);
  const [previewChanges, setPreviewChanges] = useState({ toCreate: [], toUpdate: [], errors: [] });
  const [showMissingPatients, setShowMissingPatients] = useState(false);
  const [missingPatients, setMissingPatients] = useState([]);

  useEffect(() => {

    loadData();
    // loadSavedMapping is removed as mapping is fixed
    
    // CRITICAL: Auto-open file dialog on mount
    setTimeout(() => {
      if (fileInputRef.current) {
        fileInputRef.current.click();
      }
    }, 100);
  }, []);

  const loadData = async () => {
    try {
      // Only fetching stores now
      const fetchedStores = await Store.list();
      setStores(fetchedStores || []);

    } catch (error) {

    }
  };

  // loadSavedMapping and saveMapping are removed as mapping is fixed
  // const loadSavedMapping = () => { /* ... */ };
  // const saveMapping = () => { /* ... */ };

  // New function to find store by abbreviation with flexible matching
  const findStoreByAbbreviation = (storeAbbr) => {
    if (!storeAbbr) {

      return null;
    }

    const abbrLower = storeAbbr.toLowerCase().trim();

    // Option 1: Exact match on abbreviation field (highest priority)
    let store = stores.find((s) =>
    s.abbreviation && s.abbreviation.toLowerCase() === abbrLower
    );
    if (store) {

      return store.id;
    }

    // Option 2: Flexible matching - check if store name or abbreviation contains the CSV value, or vice versa
    store = stores.find((s) => {
      const storeNameLower = (s.name || '').toLowerCase().trim();
      const storeAbbreviationLower = (s.abbreviation || '').toLowerCase().trim();

      return (
        abbrLower.includes(storeNameLower) || // CSV abbr contains store name
        abbrLower.includes(storeAbbreviationLower) || // CSV abbr contains store abbr
        storeNameLower.includes(abbrLower) || // Store name contains CSV abbr
        storeAbbreviationLower.includes(abbrLower) // Store abbr contains CSV abbr
      );
    });

    if (store) {

    } else {

    }
    return store ? store.id : null;
  };

  // Proper CSV line parser that respects quoted strings AND preserves line feeds
  const parseCSVLine = (line) => {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        // Handle escaped quotes ("")
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // Do not trim here to preserve leading/trailing whitespace, including line feeds
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    // Add the last value
    // Do not trim here to preserve leading/trailing whitespace, including line feeds
    values.push(current);

    // Remove surrounding quotes from each value that were not part of an escaped quote sequence
    // Internal newlines within quoted values are naturally preserved.
    // Leading/trailing newlines are preserved because .trim() is removed from push operations.
    return values.map((v) => {
      if (v.startsWith('"') && v.endsWith('"')) {
        return v.substring(1, v.length - 1);
      }
      return v;
    });
  };

  // Helper function to process a single CSV row into a patient object for preview
  const processCsvRowToPatient = (values, currentFieldMapping, allStores) => {
    const getMappedValue = (fieldName) => {
      const colIndex = parseInt(currentFieldMapping[fieldName]) - 1;
      return currentFieldMapping[fieldName] && values[colIndex] !== undefined ? String(values[colIndex]).trim() : '';
    };

    const fullName = getMappedValue('full_name');
    const addressStr = getMappedValue('address');
    const notesStr = getMappedValue('notes');

    // Get and clean PID - trim only, preserve case sensitivity
    let patientId = getMappedValue('patient_id');
    if (patientId) {
      patientId = patientId.trim().replace(/[^A-Za-z0-9]/g, '');
    }

    let storeId = null;
    let storeName = 'N/A';
    let storeColor = 'grey';
    const storeAbbrCsv = getMappedValue('store_abbreviation');

    if (storeAbbrCsv) {
      const matchedStore = allStores.find((s) =>
      s.abbreviation && s.abbreviation.toLowerCase() === storeAbbrCsv.toLowerCase() ||
      s.name && s.name.toLowerCase().includes(storeAbbrCsv.toLowerCase()) ||
      storeAbbrCsv.toLowerCase().includes((s.name || '').toLowerCase()) ||
      storeAbbrCsv.toLowerCase().includes((s.abbreviation || '').toLowerCase())
      );
      if (matchedStore) {
        storeId = matchedStore.id;
        storeName = matchedStore.name;
        storeColor = matchedStore.color;
      } else {
        storeName = `N/A (${storeAbbrCsv})`;

      }
    }

    // Parse address and notes to extract unit, preferences, and recurring patterns

    const { cleanedAddress, unitNumber, cleanedNotes, preferences, recurring } = cleanAddressAndNotes(addressStr, notesStr);


    // Determine if patient should be inactive based on:
    // 1. Col 19 = 'X' (explicit inactive flag)
    // 2. Name contains '(Old'
    // 3. Notes contains '(Deceased'
    let status = 'active';
    const inactiveFlag = getMappedValue('inactive_flag');
    if (inactiveFlag && inactiveFlag.toUpperCase() === 'X') {
      status = 'inactive';
    } else if (fullName && fullName.includes('(Old')) {
      status = 'inactive';
    } else if (notesStr && notesStr.includes('(Deceased')) {
      status = 'inactive';
    }

    const patientData = {
      patient_id: patientId,
      full_name: fullName,
      address: cleanedAddress,
      unit_number: unitNumber || '',
      phone: getMappedValue('phone'),
      notes: cleanedNotes,
      last_delivery_date: getMappedValue('last_delivery_date'),
      distance_from_store: getMappedValue('distance_from_store'),
      time_window_start: getMappedValue('time_window_start'),
      time_window_end: getMappedValue('time_window_end'),
      latitude: getMappedValue('latitude'),
      longitude: getMappedValue('longitude'),
      store_id: storeId,
      store_name: storeName,
      store_color: storeColor,
      status: status, // Set the status here
      // Spread preferences
      ...preferences,
      // Spread recurring patterns
      ...recurring
    };



    return patientData;
  };

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files);


    if (selectedFiles.length === 0) {
      setFiles([]);
      setColumnCount(0);
      setPreviewData([]); // Clear processed patient preview

      return;
    }

    setFiles(selectedFiles);
    
    // CRITICAL: Auto-generate preview for non-app-owners immediately after file selection
    const isNotAppOwner = currentUser && currentUser.role !== 'App Owner';
    if (isNotAppOwner && selectedFiles.length > 0) {
      // Delay slightly to let file state update
      setTimeout(() => {
        generatePreview();
      }, 300);
    }

    const firstFile = selectedFiles[0];
    const reader = new FileReader();

    reader.onload = (event) => {
      const text = event.target.result;
      const lines = text.split('\n').filter((line) => line.trim());

      // IMPORTANT: Line 1 is ALWAYS the header and is ALWAYS skipped
      if (lines.length < 2) {
        alert(`File ${firstFile.name} must have at least 2 rows (header + data).`);
        setColumnCount(0);
        setPreviewData([]); // Clear

        return;
      }

      // Skip line 1 (header), start from line 2
      const dataLines = lines.slice(1);
      if (dataLines.length === 0) {
        alert(`File ${firstFile.name} has no data rows after skipping the first line (header).`);
        setColumnCount(0);
        setPreviewData([]); // Clear

        return;
      }

      // Set column count based on the first data row for mapping dropdowns
      const firstRowRawData = parseCSVLine(dataLines[0]);
      const newColumnCount = Math.min(firstRowRawData.length, 20); // Cap at 20 columns for practical purposes
      setColumnCount(newColumnCount);



      // CRITICAL: Get first record per store instead of first 5 rows
      const storeFirstRecords = new Map();
      for (let i = 0; i < dataLines.length; i++) {
        try {
          const values = parseCSVLine(dataLines[i]);
          const patientObj = processCsvRowToPatient(values, fieldMapping, stores);
          const storeId = patientObj.store_id || 'unknown';
          
          // Only add first record for each store
          if (!storeFirstRecords.has(storeId)) {
            storeFirstRecords.set(storeId, patientObj);
          }
        } catch (error) {
          // Skip error rows in preview
        }
      }
      const processedPreviewPatients = Array.from(storeFirstRecords.values());
      setPreviewData(processedPreviewPatients);

    };

    reader.readAsText(firstFile);
  };

  // useEffect to re-generate the live preview whenever files, or stores change
  // fieldMapping is now a const, so it's not a dependency that changes state
  useEffect(() => {
    if (files.length === 0) {
      setPreviewData([]);
      return;
    }

    // Only generate live preview if a file is selected and basic mapping is present (which it always is now)
    if (files.length > 0 && columnCount > 0) {// Removed fieldMapping checks as it's fixed

      const firstFile = files[0];
      const reader = new FileReader();

      reader.onload = (event) => {
        const text = event.target.result;
        const lines = text.split('\n').filter((line) => line.trim());
        // IMPORTANT: Line 1 is ALWAYS the header and is ALWAYS skipped
        if (lines.length < 2) {
          setPreviewData([]);

          return;
        }
        const dataLines = lines.slice(1); // Skip line 1 (header), start from line 2
        if (dataLines.length === 0) {
          setPreviewData([]);

          return;
        }

        // CRITICAL: Get first record per store instead of first 5 rows
        const storeFirstRecords = new Map();
        for (let i = 0; i < dataLines.length; i++) {
          try {
            const values = parseCSVLine(dataLines[i]);
            const patientObj = processCsvRowToPatient(values, fieldMapping, stores);
            const storeId = patientObj.store_id || 'unknown';
            
            // Only add first record for each store
            if (!storeFirstRecords.has(storeId)) {
              storeFirstRecords.set(storeId, patientObj);
            }
          } catch (error) {
            // Skip error rows in preview
          }
        }
        const processedPreviewPatients = Array.from(storeFirstRecords.values());
        setPreviewData(processedPreviewPatients);

      };
      reader.readAsText(firstFile);
    } else {
      setPreviewData([]); // Clear preview if incomplete or no files

    }
  }, [files, stores, columnCount]); // Dependencies for this effect

  const removeFile = (indexToRemove) => {

    const updatedFiles = files.filter((_, index) => index !== indexToRemove);
    setFiles(updatedFiles);

    if (indexToRemove === 0 && updatedFiles.length > 0) {
      // If the first file was removed and others exist, re-preview the new first file
      // Trigger handleFileChange manually to update preview data and column count
      // Create a mock event object for handleFileChange

      handleFileChange({ target: { files: updatedFiles } });
    } else if (updatedFiles.length === 0) {
      // If all files removed, clear preview

      setColumnCount(0);
      setPreviewData([]);
    }
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        const isRateLimit = error.message?.includes('Rate limit') || error.message?.includes('429');

        if (isRateLimit && i < maxRetries - 1) {
          const waitTime = baseDelay * Math.pow(2, i);

          await delay(waitTime);
        } else {

          throw error;
        }
      }
    }
  };

  const comparePatientData = (existingPatient, newData) => {
    const changes = [];
    // CRITICAL: Removed 'store_id' from comparison - patient import should NOT change store assignments
    // Store assignment is set at creation time and should only be changed manually by admins
    const fieldsToCompare = [
    'full_name', 'address', 'unit_number', 'phone', 'notes', 'last_delivery_date',
    'distance_from_store', 'time_window_start', 'time_window_end',
    'latitude', 'longitude', 'patient_id', 'status',
    // Recurring patterns (excluding 'recurring' as it's a derived/old field)
    'recurring_daily', 'recurring_weekly_mon', 'recurring_weekly_tue', 'recurring_weekly_wed',
    'recurring_weekly_thu', 'recurring_weekly_fri', 'recurring_weekly_sat', 'recurring_weekly_sun',
    'recurring_biweekly', 'recurring_weekly_x4', 'recurring_monthly',
    // Preferences
    'mailbox_ok', 'call_upon_arrival', 'ring_bell', 'dont_ring_bell', 'back_door'];


    // List of boolean fields for special handling and 'Yes'/'No' display
    const booleanFields = [
    'recurring_daily', 'recurring_weekly_mon', 'recurring_weekly_tue', 'recurring_weekly_wed',
    'recurring_weekly_thu', 'recurring_weekly_fri', 'recurring_weekly_sat', 'recurring_weekly_sun',
    'recurring_biweekly', 'recurring_weekly_x4', 'recurring_monthly',
    'mailbox_ok', 'call_upon_arrival', 'ring_bell', 'dont_ring_bell', 'back_door'];


    fieldsToCompare.forEach((field) => {
      let existingValue = existingPatient[field];
      let newValue = newData[field];

      // --- Step 1: Standardize values for comparison ---
      // For all fields, treat null/undefined as empty string for consistent comparison
      existingValue = existingValue === null || existingValue === undefined ? '' : existingValue;
      newValue = newValue === null || newValue === undefined ? '' : newValue;

      // --- Step 2: Handle boolean fields specifically ---
      if (booleanFields.includes(field)) {
        // Convert to actual booleans for comparison
        const existingBool = !!existingValue;
        const newBool = !!newValue;

        if (existingBool !== newBool) {
          changes.push({
            field,
            oldValue: existingBool ? 'Yes' : 'No',
            newValue: newBool ? 'Yes' : 'No'
          });
        }
        return; // Skip further processing for this field
      }

      // --- Step 3: Handle other field types ---
      // For notes and address, we should avoid trimming as newlines/spaces might be intentional.
      // For other fields, trimming is usually desired for comparison.
      if (!['notes', 'address'].includes(field)) {
        if (typeof existingValue === 'string') existingValue = existingValue.trim();
        if (typeof newValue === 'string') newValue = newValue.trim();
      }


      // Numeric comparison for specific fields
      if (['latitude', 'longitude', 'distance_from_store'].includes(field)) {
        const existingNum = parseFloat(existingValue);
        const newNum = parseFloat(newValue);

        // Compare numeric values or their NaN status
        if (isNaN(existingNum) !== isNaN(newNum) || !isNaN(existingNum) && !isNaN(newNum) && existingNum !== newNum) {
          changes.push({
            field,
            oldValue: existingValue === '' ? '(empty)' : existingValue,
            newValue: newValue === '' ? '(empty)' : newValue
          });
        }
      } else if (existingValue !== newValue) {
        // For all other fields (strings, numbers, etc.), if they are different after standardization
        changes.push({
          field,
          oldValue: existingValue === '' ? '(empty)' : existingValue,
          newValue: newValue === '' ? '(empty)' : newValue
        });
      }
    });

    return changes;
  };

  const generatePreview = async () => {

    if (files.length === 0) {
      alert('Please select at least one file');

      return;
    }

    // Mapping is now fixed, so checks like these are less about user input and more about data integrity.
    // They will implicitly pass if `fieldMapping` const is correctly defined.
    if (!fieldMapping.store_abbreviation || !fieldMapping.full_name || !fieldMapping.address) {
      alert('Internal error: Essential fixed mappings are missing. Please contact support.');

      return;
    }

    // saveMapping() removed as mapping is fixed
    setIsProcessing(true);
    setPreviewChanges({ toCreate: [], toUpdate: [], errors: [] }); // Clear previous preview

    try {

      const existingPatients = await Patient.list();

      const toCreate = [];
      const toUpdate = [];
      const errors = [];

      for (const file of files) {

        const text = await file.text();
        const lines = text.split('\n').filter((line) => line.trim());
        const dataLines = lines.slice(1); // Skip line 1 (header), start from line 2

        for (let i = 0; i < dataLines.length; i++) {
          const rowNumber = i + 2; // CSV rows are 1-based, and we skipped the header
          try {
            const values = parseCSVLine(dataLines[i]); // Use new CSV parser

            // Use processCsvRowToPatient for consistency and avoid duplication
            const patientData = processCsvRowToPatient(values, fieldMapping, stores);


            if (!patientData.full_name) {
              const errorMsg = `${file.name} Row ${rowNumber}: Skipping - missing full name. Data: ${JSON.stringify(values.slice(0, 5))}`;
              errors.push(errorMsg);

              continue;
            }

            if (!patientData.address) {
              const errorMsg = `${file.name} Row ${rowNumber}: Skipping - missing address for ${patientData.full_name}. Data: ${JSON.stringify(values.slice(0, 5))}`;
              errors.push(errorMsg);

              continue;
            }

            if (!patientData.store_id) {
              const storeAbbrCsv = values[parseInt(fieldMapping.store_abbreviation) - 1] || '';
              const errorMsg = `${file.name} Row ${rowNumber}: Skipping - store not found for abbreviation "${storeAbbrCsv}" (Patient: ${patientData.full_name}).`;
              errors.push(errorMsg);

              continue;
            }

            // For preview, we don't geocode yet, just note potential for geocoding
            // The actual geocoding will happen during confirmAndImport
            // If latitude or longitude is missing, we can assume it will be geocoded
            const willGeocode = !patientData.latitude || !patientData.longitude || typeof parseFloat(patientData.latitude) !== 'number' || isNaN(parseFloat(patientData.latitude)) || typeof parseFloat(patientData.longitude) !== 'number' || isNaN(parseFloat(patientData.longitude));

            // Primary matching: Match by PID if it exists (STRONGEST IDENTIFIER)
            // Secondary matching: Match by store + name + cleaned address
            let existingPatient = null;

            if (patientData.patient_id) {
              // Clean PID from CSV for comparison - PRESERVE CASE SENSITIVITY
              const csvPid = String(patientData.patient_id).trim().replace(/[^A-Za-z0-9]/g, '');

              // Try PID match first (primary key) - CASE SENSITIVE MATCH
              existingPatient = existingPatients.find((p) => {
                if (!p.patient_id) return false;
                // Clean PID from database for comparison - PRESERVE CASE SENSITIVITY
                const dbPid = String(p.patient_id).trim().replace(/[^A-Za-z0-9]/g, '');
                return dbPid === csvPid; // Exact case-sensitive match
              });


            }

            // If no PID match and no patient_id was provided in CSV,
            // fall back to store + name + address match
            if (!existingPatient && !patientData.patient_id) {
              existingPatient = existingPatients.find((p) => {
                if (p.store_id !== patientData.store_id) return false;
                if (p.full_name.toLowerCase() !== patientData.full_name.toLowerCase()) return false;

                // FIXED: Just compare addresses directly - existing patient address is ALREADY clean
                return p.address.toLowerCase() === patientData.address.toLowerCase();
              });


            }

            if (existingPatient) {
              // CRITICAL: For updates, preserve the existing store_id - don't change it from CSV
              // The store_id from CSV is only used for NEW patient creation
              const patientDataForUpdate = {
                ...patientData,
                store_id: existingPatient.store_id // Always preserve existing store assignment
              };

              const changes = comparePatientData(existingPatient, patientDataForUpdate);
              if (changes.length > 0) {
                toUpdate.push({
                  id: existingPatient.id,
                  data: patientDataForUpdate,
                  existing: existingPatient,
                  changes: changes,
                  fileName: file.name,
                  rowNumber: rowNumber,
                  willGeocode: willGeocode
                });

              } else {

              }
            } else {
              toCreate.push({
                data: patientData,
                fileName: file.name,
                rowNumber: rowNumber,
                willGeocode: willGeocode
              });

            }

          } catch (error) {

            errors.push(`${file.name} Row ${rowNumber}: ${error.message || 'Unknown error'}`);
          }
        }
      }

      // Find patients in database that are NOT in the imported CSV
      // These are patients that exist but weren't included in the import file
      const importedPatientPids = new Set(); // PIDs from CSV (cleaned, case-sensitive)
      const importedPatientKeys = new Set(); // For fallback matching (store+name+address) - only for rows WITHOUT PID
      const importingStoreIds = new Set(); // Track which stores are being imported

      // Collect all patient identifiers from ALL CSV data (processed rows)
      // We need to collect from the raw processed data, not just toCreate/toUpdate
      // because toUpdate only contains patients WITH changes

      // Re-process all files to get ALL patient PIDs from CSV
      for (const file of files) {
        const text = await file.text();
        const lines = text.split('\n').filter((line) => line.trim());
        const dataLines = lines.slice(1); // Skip header

        for (let i = 0; i < dataLines.length; i++) {
          try {
            const values = parseCSVLine(dataLines[i]);
            const patientData = processCsvRowToPatient(values, fieldMapping, stores);

            // Track which stores are being imported
            if (patientData.store_id) {
              importingStoreIds.add(patientData.store_id);
            }

            if (patientData.patient_id) {
              const cleanPid = String(patientData.patient_id).trim().replace(/[^A-Za-z0-9]/g, '');
              if (cleanPid) {
                importedPatientPids.add(cleanPid);
              }
            } else if (patientData.store_id && patientData.full_name) {
              // Only use fallback key if NO PID in CSV row
              const key = `${patientData.store_id}_${(patientData.full_name || '').toLowerCase().trim()}_${(patientData.address || '').toLowerCase().trim()}`;
              importedPatientKeys.add(key);
            }
          } catch (err) {









            // Skip rows with parsing errors
          }}}console.log(`PatientImport: Collected ${importedPatientPids.size} PIDs and ${importedPatientKeys.size} fallback keys from CSV`);console.log(`PatientImport: Importing from ${importingStoreIds.size} store(s)`, Array.from(importingStoreIds)); // Find patients in database not in import
      const missingFromImport = existingPatients.filter((p) => {// Skip if patient is already inactive
          if (p.status === 'inactive') return false;
          // CRITICAL: Only check patients from stores being imported
          if (!importingStoreIds.has(p.store_id)) {
            return false; // Skip patients from other stores
          }

          // PRIMARY: Check by PID if database patient has one
          if (p.patient_id) {
            const dbPid = String(p.patient_id).trim().replace(/[^A-Za-z0-9]/g, '');
            if (dbPid && importedPatientPids.has(dbPid)) {
              return false; // Found in CSV by PID
            }
          }

          // FALLBACK: Only if DB patient has no PID, check by store+name+address
          if (!p.patient_id) {
            const key = `${p.store_id}_${(p.full_name || '').toLowerCase().trim()}_${(p.address || '').toLowerCase().trim()}`;
            if (importedPatientKeys.has(key)) {
              return false; // Found in CSV by fallback key
            }
          }

          // Patient exists in DB but not in import
          return true;
        });


      setMissingPatients(missingFromImport);

      setPreviewChanges({ toCreate, toUpdate, errors });

      // Store importing store IDs for the popup
      if (!window.__importingStoreIds) {
        window.__importingStoreIds = Array.from(importingStoreIds);
      }

      // Show preview first, missing patients will be shown when user tries to import
      setShowPreview(true);

      // Store missing patients for later if needed
      setMissingPatients(missingFromImport);



    } catch (error) {

      alert(`Preview failed: ${error.message}`);
    } finally {
      setIsProcessing(false);

    }
  };

  const confirmAndImport = async () => {


    if (onImportStart) {
      onImportStart();
    }

    setShowPreview(false);
    setIsProcessing(true);
    setImportResult(null);
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

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalGeocoded = 0;
    let importErrors = [...previewChanges.errors];
    let aggregatedResults = null; // Initialize variable

    try {
      // CRITICAL: Use centralized data operation manager
      await executeDataOperation(async () => {


        // Retry queue arrays
        const failedCreations = [];
        const failedUpdates = [];

        // Process patients to create
        if (previewChanges.toCreate.length > 0) {

          setImportProgress((prev) => ({
            ...prev,
            phase: 'creating',
            current: 0,
            total: previewChanges.toCreate.length
          }));

          const patientsForBulkCreate = [];
          for (let i = 0; i < previewChanges.toCreate.length; i++) {
            const item = previewChanges.toCreate[i];
            const patientData = { ...item.data };

            // Geocoding for new patients if coordinates missing
            const currentLat = parseFloat(patientData.latitude);
            const currentLon = parseFloat(patientData.longitude);
            if (item.willGeocode || isNaN(currentLat) || isNaN(currentLon)) {
              try {
                const geocodeResult = await retryWithBackoff(async () => {
                  return await base44.integrations.Core.InvokeLLM({
                    prompt: `Geocode this address and return only coordinates: ${patientData.address}`,
                    add_context_from_internet: true,
                    response_json_schema: {
                      type: "object",
                      properties: {
                        latitude: { type: "number" },
                        longitude: { type: "number" }
                      }
                    }
                  });
                }, 3, 2000, 2); // Increased retry delay

                if (geocodeResult && typeof geocodeResult.latitude === 'number' && typeof geocodeResult.longitude === 'number') {
                  patientData.latitude = geocodeResult.latitude;
                  patientData.longitude = geocodeResult.longitude;
                  totalGeocoded++;
                }
              } catch (geocodeError) {

                const errorMsg = `Geocoding failed for ${patientData.full_name} from ${item.fileName} Row ${item.rowNumber}: ${geocodeError.message}`;
                importErrors.push(errorMsg);
                setImportProgress((prev) => ({ ...prev, errors: importErrors.length }));
              }
              await delay(500); // Increased delay for geocoding calls
            }
            patientsForBulkCreate.push(patientData);
          }

          // CRITICAL: Smaller batches to prevent rate limits
          const BATCH_SIZE = 10;
          const batches = [];
          for (let i = 0; i < patientsForBulkCreate.length; i += BATCH_SIZE) {
            batches.push(patientsForBulkCreate.slice(i, i + BATCH_SIZE));
          }

          for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            try {
              const createdPatients = await retryWithBackoff(async () => {
                return await base44.entities.Patient.bulkCreate(batch);
              }, 5, 3000, 2); // Increased retry delay

              await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, createdPatients);

              totalCreated += createdPatients.length;
              setImportProgress((prev) => ({
                ...prev,
                created: prev.created + createdPatients.length,
                current: prev.current + batch.length
              }));
            } catch (error) {

              batch.forEach((patientData, index) => {
                const originalIndex = batchIndex * BATCH_SIZE + index;
                const originalPreviewItem = previewChanges.toCreate[originalIndex];
                const errorMsg = `Creation failed for ${patientData.full_name}: ${error.message}`;
                importErrors.push(errorMsg);
                failedCreations.push({
                  data: patientData,
                  fileName: originalPreviewItem?.fileName || 'Unknown',
                  rowNumber: originalPreviewItem?.rowNumber || 0,
                  errorMsg: errorMsg
                });
              });
              setImportProgress((prev) => ({ ...prev, errors: importErrors.length }));
            }
          }
        }

        // Process patients to update - with batching
        if (previewChanges.toUpdate.length > 0) {

          setImportProgress((prev) => ({
            ...prev,
            phase: 'updating',
            current: 0,
            total: previewChanges.toUpdate.length
          }));

          // CRITICAL: Process in batches with geocoding
          const UPDATE_BATCH_SIZE = 5;
          for (let batchStart = 0; batchStart < previewChanges.toUpdate.length; batchStart += UPDATE_BATCH_SIZE) {
            const batch = previewChanges.toUpdate.slice(batchStart, batchStart + UPDATE_BATCH_SIZE);

            for (const item of batch) {
              const { id } = item;
              const patientData = { ...item.data };

              // Geocoding if needed
              const currentLat = parseFloat(patientData.latitude);
              const currentLon = parseFloat(patientData.longitude);
              if (item.willGeocode || isNaN(currentLat) || isNaN(currentLon)) {
                try {
                  const geocodeResult = await retryWithBackoff(async () => {
                    return await base44.integrations.Core.InvokeLLM({
                      prompt: `Geocode this address and return only coordinates: ${patientData.address}`,
                      add_context_from_internet: true,
                      response_json_schema: {
                        type: "object",
                        properties: {
                          latitude: { type: "number" },
                          longitude: { type: "number" }
                        }
                      }
                    });
                  }, 3, 2000, 2);

                  if (geocodeResult && typeof geocodeResult.latitude === 'number' && typeof geocodeResult.longitude === 'number') {
                    patientData.latitude = geocodeResult.latitude;
                    patientData.longitude = geocodeResult.longitude;
                    totalGeocoded++;
                  }
                } catch (geocodeError) {
                  const errorMsg = `Geocoding failed for ${patientData.full_name}: ${geocodeError.message}`;
                  importErrors.push(errorMsg);
                  setImportProgress((prev) => ({ ...prev, errors: importErrors.length }));
                }
                await delay(500);
              }

              try {
                await retryWithBackoff(async () => {
                  const updated = await base44.entities.Patient.update(id, patientData);
                  await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [updated]);
                  return updated;
                }, 5, 2000, 2);

                totalUpdated++;
                setImportProgress((prev) => ({
                  ...prev,
                  updated: prev.updated + 1,
                  current: batchStart + batch.indexOf(item) + 1
                }));
              } catch (error) {
                const errorMsg = `Update failed for ${patientData.full_name}: ${error.message}`;
                importErrors.push(errorMsg);
                setImportProgress((prev) => ({ ...prev, errors: importErrors.length }));
                failedUpdates.push({ ...item, data: patientData, errorMsg });
              }
            }
          }
        }

        // --- Retry failed creations (offline DB) ---
        if (failedCreations.length > 0) {

          setImportProgress((prev) => ({
            ...prev,
            phase: 'retrying creations',
            current: 0,
            total: failedCreations.length
          }));

          for (let i = 0; i < failedCreations.length; i++) {
            const item = failedCreations[i];
            const patientData = item.data;

            try {


              const patientWithTempId = {
                ...patientData,
                id: `temp_patient_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                created_date: new Date().toISOString(),
                updated_date: new Date().toISOString(),
                _isLocal: true
              };

              await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [patientWithTempId]);
              totalCreated++;


              const errorIndex = importErrors.indexOf(item.errorMsg);
              if (errorIndex > -1) {
                importErrors.splice(errorIndex, 1);
              }

              setImportProgress((prev) => ({
                ...prev,
                created: prev.created + 1,
                errors: importErrors.length,
                current: i + 1
              }));
            } catch (retryError) {

              const newErrorMsg = `Final retry failed for ${patientData.full_name} (${patientData.address}) from ${item.fileName} Row ${item.rowNumber}: ${retryError.message}`;
              const errorIndex = importErrors.indexOf(item.errorMsg);
              if (errorIndex > -1) {
                importErrors[errorIndex] = newErrorMsg;
              } else {
                importErrors.push(newErrorMsg);
              }

              setImportProgress((prev) => ({ ...prev, errors: importErrors.length, current: i + 1 }));
            }
          }
        }

        // --- Retry failed updates (offline DB) ---
        if (failedUpdates.length > 0) {

          setImportProgress((prev) => ({
            ...prev,
            phase: 'retrying updates',
            current: 0,
            total: failedUpdates.length
          }));

          for (let i = 0; i < failedUpdates.length; i++) {
            const item = failedUpdates[i];
            const { id } = item;
            const patientData = item.data;

            try {


              // CRITICAL: Retry with backend API
              await base44.entities.Patient.update(id, patientData);
              totalUpdated++;


              const errorIndex = importErrors.indexOf(item.errorMsg);
              if (errorIndex > -1) {
                importErrors.splice(errorIndex, 1);
              }

              setImportProgress((prev) => ({
                ...prev,
                updated: prev.updated + 1,
                errors: importErrors.length,
                current: i + 1
              }));
            } catch (retryError) {

              const newErrorMsg = `Final retry update failed for patient ID ${id} (${patientData.full_name}) from ${item.fileName} Row ${item.rowNumber}: ${retryError.message}`;
              const errorIndex = importErrors.indexOf(item.errorMsg);
              if (errorIndex > -1) {
                importErrors[errorIndex] = newErrorMsg;
              } else {
                importErrors.push(newErrorMsg);
              }
              setImportProgress((prev) => ({ ...prev, errors: importErrors.length, current: i + 1 }));
            }
          }
        }

        aggregatedResults = {
          created: totalCreated,
          updated: totalUpdated,
          geocoded: totalGeocoded,
          errors: importErrors,
          retriedCreationsAttempted: failedCreations.length,
          retriedUpdatesAttempted: failedUpdates.length,
          fileResults: [{
            fileName: files.map((f) => f.name).join(', '),
            created: totalCreated,
            updated: totalUpdated,
            errors: importErrors,
            geocoded: totalGeocoded
          }]
        };

        setImportResult(aggregatedResults);
        setImportProgress((prev) => ({
          ...prev,
          phase: 'complete',
          currentFile: '',
          filesCompleted: files.length,
          totalFiles: files.length,
          errors: importErrors.length
        }));



        // CRITICAL: Sync imported/updated patients to offline DB

        const patientsToSync = [];
        
        // Collect all created patients (already have temp/real IDs)
        previewChanges.toCreate.forEach((item) => {
          if (item.data) patientsToSync.push(item.data);
        });
        
        // Collect all updated patients (need to fetch from backend)
        for (const item of previewChanges.toUpdate) {
          try {
            const updated = await base44.entities.Patient.get(item.id);
            if (updated) patientsToSync.push(updated);
          } catch (e) {

          }
        }
        
        if (patientsToSync.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patientsToSync);

        }
        
        // CRITICAL: Trigger immediate backend sync after import

        const { processPendingMutations } = await import('../utils/offlineSync');
        processPendingMutations().catch((err) => console.warn('Backend sync error:', err));
        
        // CRITICAL: Don't trigger smart refresh restart here - let executeDataOperation handle it


        return true; // Signal success
      }, { restartDelay: 2000 }).then(() => {
        // CRITICAL: Notify parent AFTER executeDataOperation completes and restarts refresh
        if (onImportComplete) {
          onImportComplete(aggregatedResults);
        }
      }); // 2 second delay before restarting smart refresh

    } catch (error) {

      alert(`Import failed: ${error.message}`);
      importErrors.push(`Overall import process failed: ${error.message}`);

      setImportProgress((prev) => ({
        ...prev,
        phase: 'failed',
        errors: importErrors.length,
        currentFile: ''
      }));

      if (!importResult) {
        setImportResult({
          created: totalCreated,
          updated: totalUpdated,
          geocoded: totalGeocoded,
          errors: importErrors,
          fileResults: []
        });
      }
    } finally {
      setIsProcessing(false);
    }
  };


  // columnOptions is no longer needed as there's no user mapping UI
  // const columnOptions = Array.from({ length: columnCount }, (_, i) => i + 1);

  const getContrastingTextColor = (hexColor) => {
    if (!hexColor) return '#ffffff';
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#ffffff';
  };

  const getPhaseLabel = () => {
    switch (importProgress.phase) {
      case 'processing':return `Processing rows in ${importProgress.currentFile}`;
      case 'creating':return `Creating new patients (${importProgress.current} of ${importProgress.total})`;
      case 'updating':return `Updating existing patients (${importProgress.current} of ${importProgress.total})`;
      case 'retrying creations':return `Retrying failed creations (${importProgress.current} of ${importProgress.total})`;
      case 'retrying updates':return `Retrying failed updates (${importProgress.current} of ${importProgress.total})`;
      case 'complete':return 'Import complete';
      case 'failed':return 'Import failed';
      default:return 'Initializing import...'; // For when confirmAndImport starts
    }
  };

  // Show missing patients popup first
  if (showMissingPatients) {
    return (
      <MissingPatientsPopup
        missingPatients={missingPatients}
        stores={stores}
        importingStoreIds={window.__importingStoreIds || []}
        onClose={() => setShowMissingPatients(false)}
        onContinue={() => {
          setShowMissingPatients(false);
          setShowPreview(true);
        }} />);


  }

  if (showPreview) {
    return (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-2 sm:p-4 z-[9999] overflow-hidden">
                <Card className="rounded-xl border bg-card text-card-foreground shadow w-full max-w-4xl h-[70vh] sm:h-[70vh] flex flex-col">
                    <CardHeader className="flex flex-col space-y-1.5 p-3 border-b flex-shrink-0">
                        <div className="flex items-center justify-between">
                            <CardTitle className="text-base sm:text-lg">Import Preview</CardTitle>
                            <Button variant="ghost" size="icon" onClick={() => setShowPreview(false)} className="h-9 w-9">
                                <X className="w-4 h-4" />
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-y-auto p-2 sm:p-4 space-y-3">
                        {/* Summary */}
                        <div className="grid grid-cols-3 gap-2">
                            <Card>
                                <CardContent className="p-3 text-center">
                                    <div className="text-2xl sm:text-3xl font-bold text-green-600">{previewChanges.toCreate.length}</div>
                                    <div className="text-xs sm:text-sm text-slate-600">New</div>
                                </CardContent>
                            </Card>
                            <Card>
                                <CardContent className="p-3 text-center">
                                    <div className="text-2xl sm:text-3xl font-bold text-blue-600">{previewChanges.toUpdate.length}</div>
                                    <div className="text-xs sm:text-sm text-slate-600">Updates</div>
                                </CardContent>
                            </Card>
                            <Card>
                                <CardContent className="p-3 text-center">
                                    <div className="text-2xl sm:text-3xl font-bold text-red-600">{previewChanges.errors.length}</div>
                                    <div className="text-xs sm:text-sm text-slate-600">Errors</div>
                                </CardContent>
                            </Card>
                        </div>

                        {/* New Patients */}
                        {previewChanges.toCreate.length > 0 &&
            <div>
                                <h3 className="text-base sm:text-lg font-semibold text-green-600 mb-2">New Patients ({previewChanges.toCreate.length})</h3>
                                <div className="space-y-1.5 max-h-[30vh] sm:max-h-[205px] overflow-y-auto border rounded p-2">
                                    {previewChanges.toCreate.map((item, idx) =>
                <div key={idx} className="bg-green-50 border border-green-200 rounded p-2 text-xs sm:text-sm">
                                            <div className="flex items-center gap-2 flex-wrap mb-1">
                                                <span className="font-mono text-xs bg-green-100 px-2 py-0.5 rounded border border-green-300">
                                                    {item.data.patient_id || 'NO PID'}
                                                </span>
                                                <span className="font-medium">{item.data.full_name}</span>
                                            </div>
                                            <div className="text-slate-600 text-xs truncate mb-1" title={item.data.address}>{item.data.address}</div>
                                            <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500">
                                                {item.willGeocode && <span className="text-yellow-600">📍 Geocode</span>}
                                                <span>{item.data.store_name} • R{item.rowNumber}</span>
                                            </div>
                                        </div>
                )}
                                </div>
                            </div>
            }

                        {/* Updates */}
                        {previewChanges.toUpdate.length > 0 &&
            <div>
                                <h3 className="text-base sm:text-lg font-semibold text-blue-600 mb-2">Updates ({previewChanges.toUpdate.length})</h3>
                                <div className="space-y-2 max-h-[40vh] sm:max-h-[445px] overflow-y-auto border rounded p-2">
                                    {previewChanges.toUpdate.map((item, idx) =>
                <div key={idx} className="bg-blue-50 border border-blue-200 rounded p-2">
                                            <div className="flex items-center gap-2 flex-wrap text-xs sm:text-sm mb-2">
                                                <span className="font-mono text-xs bg-blue-100 px-2 py-0.5 rounded border border-blue-300">
                                                    {item.data.patient_id || item.existing.patient_id || 'NO PID'}
                                                </span>
                                                <span className="font-medium">{item.data.full_name}</span>
                                            </div>
                                            <div className="text-slate-600 text-xs truncate mb-2" title={item.data.address}>{item.data.address}</div>
                                            <div className="space-y-1.5">
                                                {item.changes.map((change, cidx) => {
                      const fieldDisplayName = change.field.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
                      return (
                        <div key={cidx} className="text-xs">
                                                            <div className="font-medium text-slate-700 mb-0.5">{fieldDisplayName}:</div>
                                                            <div className="flex items-center gap-1.5">
                                                                <span className="bg-red-100 text-red-800 px-2 py-1 rounded line-through flex-1 min-w-0 truncate" title={String(change.oldValue)}>
                                                                    {String(change.oldValue)}
                                                                </span>
                                                                <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                                                                <span className="bg-green-100 text-green-800 px-2 py-1 rounded flex-1 min-w-0 truncate" title={String(change.newValue)}>
                                                                    {String(change.newValue)}
                                                                </span>
                                                            </div>
                                                        </div>);
                    })}
                                            </div>
                                            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                                                 {item.willGeocode && <span className="text-yellow-600">📍 Geocode</span>}
                                                 <span>{item.data.store_name}</span>
                                                 <span>•</span>
                                                 <span>{item.fileName} R{item.rowNumber}</span>
                                             </div>
                                        </div>
                )}
                                </div>
                            </div>
            }

                            <CardHeader className="px-3 py-2 sm:px-4 flex flex-col space-y-1.5 flex-shrink-0 border-b">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                                        <Upload className="w-4 h-4 sm:w-5 sm:h-5" />
                                        Import Patients
                                    </CardTitle>
                                    <Button variant="ghost" size="icon" onClick={onClose} disabled={isProcessing} className="h-8 w-8">
                                        <X className="w-4 h-4" />
                                    </Button>
                                </div>
                            </CardHeader>
                {/* Floating Progress Overlay */}
                {isProcessing &&
            <div className="absolute inset-0 bg-white bg-opacity-95 z-[99999] flex items-center justify-center p-3 sm:p-6">
                        <div className="w-full max-w-2xl">
                            <div className="border-2 border-blue-200 bg-blue-50 rounded-lg p-3 sm:p-6 space-y-3 sm:space-y-4 shadow-lg">
                                <div className="flex justify-between items-start sm:items-center flex-col sm:flex-row gap-2">
                                    <div>
                                        <h3 className="font-semibold text-base sm:text-lg text-blue-900">{getPhaseLabel()}</h3>
                                        {/* Only show file progress if phase specifically refers to file processing, otherwise hide */}
                                        {importProgress.phase === 'processing' && importProgress.totalFiles > 0 &&
                      <p className="text-sm text-blue-700">
                                                File {importProgress.filesCompleted + (importProgress.phase !== 'complete' ? 1 : 0)} of {importProgress.totalFiles}: {importProgress.currentFile}
                                            </p>
                      }
                                    </div>
                                    <span className="text-sm font-medium text-blue-700">
                                        {importProgress.total > 0 ? `${importProgress.current} of ${importProgress.total}` : 'Initializing...'}
                                    </span>
                                </div>

                                <div className="w-full bg-blue-200 rounded-full h-4 overflow-hidden">
                                    <div
                      className="bg-blue-600 h-4 rounded-full transition-all duration-300 flex items-center justify-center text-xs text-white font-medium"
                      style={{ width: `${importProgress.total > 0 ? importProgress.current / importProgress.total * 100 : 0}%` }}>

                                        {importProgress.total > 0 && `${Math.round(importProgress.current / importProgress.total * 100)}%`}
                                    </div>
                                </div>

                                <div className="grid grid-cols-3 gap-2 sm:gap-4 pt-2">
                                    <div className="bg-white rounded-lg p-2 sm:p-3 text-center">
                                        <div className="text-xl sm:text-2xl font-bold text-green-600">{importProgress.created}</div>
                                        <div className="text-[10px] sm:text-xs text-slate-600">Created</div>
                                    </div>
                                    <div className="bg-white rounded-lg p-2 sm:p-3 text-center">
                                        <div className="text-xl sm:text-2xl font-bold text-blue-600">{importProgress.updated}</div>
                                        <div className="text-[10px] sm:text-xs text-slate-600">Updated</div>
                                    </div>
                                    <div className="bg-white rounded-lg p-2 sm:p-3 text-center">
                                        <div className="text-xl sm:text-2xl font-bold text-red-600">{importProgress.errors}</div>
                                        <div className="text-[10px] sm:text-xs text-slate-600">Errors</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
            }

                        {/* Errors */}
                        {previewChanges.errors.length > 0 &&
            <div>
                                <h3 className="text-base sm:text-lg font-semibold text-red-600 mb-2">Errors ({previewChanges.errors.length})</h3>
                                <div className="space-y-1 max-h-[20vh] sm:max-h-[150px] overflow-y-auto bg-red-50 p-2 sm:p-3 rounded border border-red-200">
                                    {previewChanges.errors.map((error, idx) =>
                <div key={idx} className="text-xs text-red-800 break-words">{error}</div>
                )}
                                </div>
                            </div>
            }
                        </CardContent>
                        <div className="border-t p-3 flex flex-col sm:flex-row justify-end gap-2 sm:gap-3 flex-shrink-0">
                        <Button variant="outline" onClick={() => setShowPreview(false)} disabled={isProcessing} className="w-full sm:w-auto">
                            Cancel
                        </Button>
                        <Button
              onClick={confirmAndImport}
              className="bg-emerald-600 hover:bg-emerald-700 w-full sm:w-auto"
              disabled={isProcessing || previewChanges.toCreate.length === 0 && previewChanges.toUpdate.length === 0 && previewChanges.errors.length === 0}>

                            {isProcessing ? 'Importing...' : `Import (${previewChanges.toCreate.length}+${previewChanges.toUpdate.length})`}
                        </Button>
                        </div>
                        </Card>
                        </div>);

  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-2 sm:p-4 z-[9999] overflow-hidden">
                        <Card className="rounded-xl border bg-card text-card-foreground shadow w-full max-w-md sm:max-w-3xl lg:max-w-5xl flex flex-col relative transition-all duration-300 max-h-[90vh]">
                        {/* Floating Progress Overlay */}
                        {isProcessing &&
        <div className="absolute inset-0 bg-white bg-opacity-95 z-[99999] flex items-center justify-center p-3 sm:p-6">
                        <div className="w-full max-w-2xl">
                            <div className="border-2 border-blue-200 bg-blue-50 rounded-lg p-3 sm:p-6 space-y-3 sm:space-y-4 shadow-lg">
                                <div className="flex justify-between items-start sm:items-center flex-col sm:flex-row gap-2">
                                    <div>
                                        <h3 className="font-semibold text-base sm:text-lg text-blue-900">{getPhaseLabel()}</h3>
                                        {importProgress.phase === 'processing' && importProgress.totalFiles > 0 &&
                  <p className="text-sm text-blue-700">
                                                File {importProgress.filesCompleted + (importProgress.phase !== 'complete' ? 1 : 0)} of {importProgress.totalFiles}: {importProgress.currentFile}
                                            </p>
                  }
                                    </div>
                                    <span className="text-sm font-medium text-blue-700">
                                        {importProgress.total > 0 ? `${importProgress.current} of ${importProgress.total}` : 'Initializing...'}
                                    </span>
                                </div>

                                <div className="w-full bg-blue-200 rounded-full h-4 overflow-hidden">
                                    <div
                  className="bg-blue-600 h-4 rounded-full transition-all duration-300 flex items-center justify-center text-xs text-white font-medium"
                  style={{ width: `${importProgress.total > 0 ? importProgress.current / importProgress.total * 100 : 0}%` }}>

                                        {importProgress.total > 0 && `${Math.round(importProgress.current / importProgress.total * 100)}%`}
                                    </div>
                                </div>

                                <div className="grid grid-cols-3 gap-2 sm:gap-4 pt-2">
                                    <div className="bg-white rounded-lg p-2 sm:p-3 text-center">
                                        <div className="text-xl sm:text-2xl font-bold text-green-600">{importProgress.created}</div>
                                        <div className="text-[10px] sm:text-xs text-slate-600">Created</div>
                                    </div>
                                    <div className="bg-white rounded-lg p-2 sm:p-3 text-center">
                                        <div className="text-xl sm:text-2xl font-bold text-blue-600">{importProgress.updated}</div>
                                        <div className="text-[10px] sm:text-xs text-slate-600">Updated</div>
                                    </div>
                                    <div className="bg-white rounded-lg p-2 sm:p-3 text-center">
                                        <div className="text-xl sm:text-2xl font-bold text-red-600">{importProgress.errors}</div>
                                        <div className="text-[10px] sm:text-xs text-slate-600">Errors</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        </div>
        }

                
                <CardContent className="my-1 px-3 py-3 sm:px-4 sm:py-4 flex-1 overflow-y-auto">
                   {/* Single column on mobile, two columns on desktop */}
                   <div className="py-2 grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
                        {/* File Selector */}
                        <div className="flex-1 space-y-2">
                            <div className="space-y-2">
                                <Label htmlFor="csv-upload" className="text-sm">Select CSV File(s)</Label>
                                <Input
                  ref={fileInputRef}
                  id="csv-upload"
                  type="file"
                  accept=".csv"
                  multiple
                  onChange={handleFileChange}
                  disabled={isProcessing}
                  className="cursor-pointer" />

                                <p className="text-[10px] sm:text-xs text-slate-500">
                                    Line 1 skipped (header). Data from line 2. Multiple files OK.
                                </p>
                            </div>

                            {files.length > 0 &&
              <div className="space-y-1">
                                    <Label className="text-xs sm:text-sm font-medium">Files ({files.length})</Label>
                                    <div className="space-y-1 max-h-24 sm:max-h-32 overflow-y-auto border rounded-lg p-1">
                                        {files.map((file, index) =>
                  <div key={index} className="flex items-center justify-between bg-slate-50 px-2 py-1.5 sm:px-3 sm:py-2 rounded text-xs sm:text-sm">
                                                <span className="truncate flex-1">{file.name}</span>
                                                {!isProcessing &&
                    <button
                      onClick={() => removeFile(index)}
                      className="ml-2 text-slate-400 hover:text-red-600 p-1"
                      aria-label={`Remove ${file.name}`}>
                                                        <X className="w-4 h-4" />
                                                    </button>
                    }
                                            </div>
                  )}
                                    </div>
                                </div>
              }
                        </div>

                        {/* Import Rules - Collapsible on mobile */}
                        <div className="bg-blue-50 px-2 py-2 rounded-lg flex-1 border border-blue-200">
                            <h4 className="font-semibold mb-2 text-blue-900 text-xs sm:text-sm">Import Rules:</h4>
                            <div className="space-y-2 text-[10px] sm:text-xs text-blue-800 max-h-[30vh] lg:max-h-none overflow-y-auto">
                                <div>
                                    <strong>• Fixed Columns:</strong>
                                    <div className="ml-2 text-blue-700">
                                        1=Store, 2=Name, 3=Address, 4=Phone, 5=Notes, 13=Last Delivery, 14=Distance, 15-16=Time Window, 17-18=Coords, 19=Inactive, 20=PID
                                    </div>
                                </div>
                                <div>
                                    <strong>• Auto-Processing:</strong>
                                    <div className="ml-2 text-blue-700">
                                        Store matching, unit extraction, recurring patterns, preferences, AI geocoding, PID matching
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Live Preview - Card layout for mobile, table for desktop */}
                    {previewData.length > 0 &&
                    <div className="py-2 rounded-lg border overflow-hidden">
                        <div className="bg-slate-100 px-2 sm:px-4 py-1.5 sm:py-2 font-semibold text-xs sm:text-sm border-b">
                            Preview - First Record Per Store ({previewData.length} store{previewData.length !== 1 ? 's' : ''})
                        </div>
                            
                            {/* Mobile: Card View */}
                            <div className="lg:hidden overflow-y-auto max-h-[35vh] p-2 space-y-2">
                                {previewData.map((patient, idx) =>
              <div key={idx} className="bg-slate-50 border rounded-lg p-2 text-xs space-y-1">
                                        <div className="flex items-center gap-2">
                                            <span className="font-mono bg-slate-200 px-2 py-0.5 rounded">{patient.patient_id || '-'}</span>
                                            <span className="font-medium">{patient.full_name}</span>
                                        </div>
                                        <div className="text-slate-600 truncate">{patient.address}</div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                            {patient.unit_number && <span>Unit: {patient.unit_number}</span>}
                                            {patient.phone && <span>📞 {patient.phone}</span>}
                                        </div>
                                        <div className="flex items-center gap-2">
                                             {patient.store_name !== 'N/A' ?
                                        <Badge style={{ backgroundColor: patient.store_color, color: getContrastingTextColor(patient.store_color), fontSize: '10px' }}>
                                                     {patient.store_name}
                                                 </Badge> :
                                        <span className="text-slate-400">{patient.store_name}</span>
                                        }
                                         </div>
                                        {patient.notes && <div className="text-slate-600 truncate">Notes: {patient.notes}</div>}
                                    </div>
              )}
                            </div>

                            {/* Desktop: Table View */}
                            <div className="hidden lg:block overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-slate-100 border-b sticky top-0">
                                        <tr>
                                            <th className="p-2 text-left font-medium text-xs">PID</th>
                                            <th className="p-2 text-left font-medium text-xs">Name</th>
                                            <th className="p-2 text-left font-medium text-xs">Address</th>
                                            <th className="p-2 text-left font-medium text-xs">Unit</th>
                                            <th className="p-2 text-left font-medium text-xs">Phone</th>
                                            <th className="p-2 text-left font-medium text-xs">Store</th>
                                            <th className="p-2 text-left font-medium text-xs">Notes</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {previewData.map((patient, idx) =>
                  <tr key={idx} className="border-b hover:bg-slate-50">
                                                <td className="p-2 font-mono text-xs">{patient.patient_id || '-'}</td>
                                                <td className="p-2 text-xs">{patient.full_name || '-'}</td>
                                                <td className="p-2 text-xs truncate" title={patient.address}>{patient.address || '-'}</td>
                                                <td className="p-2 text-xs font-mono">{patient.unit_number || '-'}</td>
                                                <td className="p-2 text-xs">{patient.phone || '-'}</td>
                                                <td className="p-2 text-xs">
                                                    {patient.store_name !== 'N/A' ?
                                                <Badge style={{ backgroundColor: patient.store_color, color: getContrastingTextColor(patient.store_color), fontSize: '10px' }}>
                                                             {patient.store_name}
                                                         </Badge> :
                                                <span className="text-slate-400">{patient.store_name}</span>
                                                }
                                                 </td>
                                                <td className="p-2 text-xs truncate text-slate-600" title={patient.notes}>
                                                    {patient.notes || '-'}
                                                </td>
                                            </tr>
                  )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
          }

                    <div className="pt-2 grid grid-cols-2 gap-2 sm:gap-3">
                        <Button
              variant="outline"
              onClick={onClose}
              disabled={isProcessing}
              className="h-10 sm:h-9">
                            Cancel
                        </Button>
                        <Button
              onClick={generatePreview}
              disabled={isProcessing || files.length === 0}
              className="bg-primary hover:bg-primary/90 text-primary-foreground h-10 sm:h-9 text-sm sm:text-base">
                            {isProcessing ? 'Generating...' : `Preview Import (${files.length} file${files.length !== 1 ? 's' : ''})`}
                        </Button>
                    </div>

                    {importResult &&
          <div className="space-y-2 border-t pt-3">
            <div className="grid grid-cols-3 gap-2 text-center text-xs sm:text-sm">
                <div className="flex flex-col items-center gap-1 text-green-600">
                    <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                    <span>{importResult.created}</span>
                    <span className="text-[10px] sm:text-xs">Created</span>
                </div>
                <div className="flex flex-col items-center gap-1 text-blue-600">
                    <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                    <span>{importResult.updated}</span>
                    <span className="text-[10px] sm:text-xs">Updated</span>
                </div>
                <div className="flex flex-col items-center gap-1 text-purple-600">
                    <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                    <span>{importResult.geocoded}</span>
                    <span className="text-[10px] sm:text-xs">Geocoded</span>
                </div>
            </div>

                            {importResult.errors.length > 0 &&
            <div className="space-y-1">
                                    <div className="flex items-center gap-2 text-red-600 text-xs sm:text-sm">
                                        <XCircle className="w-4 h-4" />
                                        <span>Errors: {importResult.errors.length}</span>
                                    </div>
                                    <div className="max-h-24 sm:max-h-32 overflow-y-auto bg-red-50 p-2 rounded text-[10px] sm:text-xs">
                                        {importResult.errors.map((err, i) =>
                <div key={i} className="text-red-800 break-words">{err}</div>
                )}
                                    </div>
                                </div>
            }
                        </div>
          }
                </CardContent>
            </Card>
        </div>);

}