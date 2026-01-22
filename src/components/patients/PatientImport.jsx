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
    inactive_flag: '19'  // Col 19: 'X' = inactive patient
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
    console.log("PatientImport: Component mounted, loading stores.");
    loadData();
    // loadSavedMapping is removed as mapping is fixed
  }, []);

  const loadData = async () => {
    try {
      // Only fetching stores now
      const fetchedStores = await Store.list();
      setStores(fetchedStores || []);
      console.log("PatientImport: Stores loaded successfully:", fetchedStores.length, "stores.");
    } catch (error) {
      console.error("PatientImport: Error loading stores:", error);
    }
  };

  // loadSavedMapping and saveMapping are removed as mapping is fixed
  // const loadSavedMapping = () => { /* ... */ };
  // const saveMapping = () => { /* ... */ };

  // New function to find store by abbreviation with flexible matching
  const findStoreByAbbreviation = (storeAbbr) => {
    if (!storeAbbr) {
      console.log("PatientImport: findStoreByAbbreviation called with empty abbreviation.");
      return null;
    }

    const abbrLower = storeAbbr.toLowerCase().trim();

    // Option 1: Exact match on abbreviation field (highest priority)
    let store = stores.find((s) =>
    s.abbreviation && s.abbreviation.toLowerCase() === abbrLower
    );
    if (store) {
      console.log(`PatientImport: Found store by exact abbreviation match: ${store.name} for "${storeAbbr}"`);
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
      console.log(`PatientImport: Found store by flexible abbreviation match: ${store.name} for "${storeAbbr}"`);
    } else {
      console.log(`PatientImport: No store found for abbreviation "${storeAbbr}"`);
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
        console.warn(`PatientImport: Store not found for abbreviation in CSV: "${storeAbbrCsv}"`);
      }
    }

    // Parse address and notes to extract unit, preferences, and recurring patterns
    console.log(`[PatientImport] Processing patient: ${fullName}, Original notes:`, notesStr);
    const { cleanedAddress, unitNumber, cleanedNotes, preferences, recurring } = cleanAddressAndNotes(addressStr, notesStr);
    console.log(`[PatientImport] Extracted recurring for ${fullName}:`, recurring);
    console.log(`[PatientImport] Extracted preferences for ${fullName}:`, preferences);

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

    console.log(`[PatientImport] Final patient data for ${fullName}:`, {
      recurring_bimonthly: patientData.recurring_bimonthly,
      recurring_biweekly: patientData.recurring_biweekly,
      recurring_weekly_mon: patientData.recurring_weekly_mon,
      recurring_weekly_tue: patientData.recurring_weekly_tue,
      recurring_weekly_wed: patientData.recurring_weekly_wed,
      recurring_weekly_thu: patientData.recurring_weekly_thu,
      recurring_weekly_fri: patientData.recurring_weekly_fri,
      status: patientData.status // Also log status for verification
    });

    return patientData;
  };

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files);
    console.log("PatientImport: Files selected:", selectedFiles.map((f) => f.name));

    if (selectedFiles.length === 0) {
      setFiles([]);
      setColumnCount(0);
      setPreviewData([]); // Clear processed patient preview
      console.log("PatientImport: No files selected, clearing data.");
      return;
    }

    setFiles(selectedFiles);

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
        console.warn(`PatientImport: File ${firstFile.name} too short for preview.`);
        return;
      }

      // Skip line 1 (header), start from line 2
      const dataLines = lines.slice(1);
      if (dataLines.length === 0) {
        alert(`File ${firstFile.name} has no data rows after skipping the first line (header).`);
        setColumnCount(0);
        setPreviewData([]); // Clear
        console.warn(`PatientImport: File ${firstFile.name} has no data rows.`);
        return;
      }

      // Set column count based on the first data row for mapping dropdowns
      const firstRowRawData = parseCSVLine(dataLines[0]);
      const newColumnCount = Math.min(firstRowRawData.length, 20); // Cap at 20 columns for practical purposes
      setColumnCount(newColumnCount);
      console.log(`PatientImport: Column count set to ${newColumnCount} for first file ${firstFile.name}.`);


      // Initial population of previewData based on current mapping.
      const processedPreviewPatients = [];
      for (let i = 0; i < Math.min(dataLines.length, 5); i++) {// Process first 5 data rows for initial preview
        try {
          const values = parseCSVLine(dataLines[i]);
          // Process based on fixed fieldMapping.
          const patientObj = processCsvRowToPatient(values, fieldMapping, stores);
          processedPreviewPatients.push(patientObj);
        } catch (error) {
          console.warn(`PatientImport: Error processing preview row ${i + 2} on file change:`, error);
          processedPreviewPatients.push({
            full_name: `Error in row ${i + 2}`,
            address: error.message,
            status: 'error',
            unit_number: '', phone: '', notes: '', patient_id: '', store_id: null, store_name: 'Error', store_color: 'red'
          });
        }
      }
      setPreviewData(processedPreviewPatients); // previewData now holds patient objects
      console.log(`PatientImport: Initial preview data generated for ${processedPreviewPatients.length} rows.`);
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
      console.log("PatientImport: Triggering live preview update due to file/store change.");
      const firstFile = files[0];
      const reader = new FileReader();

      reader.onload = (event) => {
        const text = event.target.result;
        const lines = text.split('\n').filter((line) => line.trim());
        // IMPORTANT: Line 1 is ALWAYS the header and is ALWAYS skipped
        if (lines.length < 2) {
          setPreviewData([]);
          console.warn(`PatientImport: Live preview: file ${firstFile.name} too short.`);
          return;
        }
        const dataLines = lines.slice(1); // Skip line 1 (header), start from line 2
        if (dataLines.length === 0) {
          setPreviewData([]);
          console.warn(`PatientImport: Live preview: file ${firstFile.name} has no data rows.`);
          return;
        }

        const processedPreviewPatients = [];
        for (let i = 0; i < Math.min(dataLines.length, 5); i++) {
          try {
            const values = parseCSVLine(dataLines[i]);
            const patientObj = processCsvRowToPatient(values, fieldMapping, stores);
            processedPreviewPatients.push(patientObj);
          } catch (error) {
            console.warn(`PatientImport: Error re-processing preview row ${i + 2} on mapping change:`, error);
            processedPreviewPatients.push({
              full_name: `Error in row ${i + 2}`,
              address: error.message,
              status: 'error',
              unit_number: '', phone: '', notes: '', patient_id: '', store_id: null, store_name: 'Error', store_color: 'red'
            });
          }
        }
        setPreviewData(processedPreviewPatients);
        console.log(`PatientImport: Live preview re-generated for ${processedPreviewPatients.length} rows.`);
      };
      reader.readAsText(firstFile);
    } else {
      setPreviewData([]); // Clear preview if incomplete or no files
      console.log("PatientImport: Clearing live preview due to incomplete data or no files.");
    }
  }, [files, stores, columnCount]); // Dependencies for this effect

  const removeFile = (indexToRemove) => {
    console.log(`PatientImport: Removing file at index ${indexToRemove}: ${files[indexToRemove]?.name}`);
    const updatedFiles = files.filter((_, index) => index !== indexToRemove);
    setFiles(updatedFiles);

    if (indexToRemove === 0 && updatedFiles.length > 0) {
      // If the first file was removed and others exist, re-preview the new first file
      // Trigger handleFileChange manually to update preview data and column count
      // Create a mock event object for handleFileChange
      console.log("PatientImport: First file removed, re-triggering handleFileChange for new first file.");
      handleFileChange({ target: { files: updatedFiles } });
    } else if (updatedFiles.length === 0) {
      // If all files removed, clear preview
      console.log("PatientImport: All files removed, clearing preview and column count.");
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
          console.warn(`PatientImport: Rate limit hit, waiting ${waitTime}ms before retry ${i + 1}/${maxRetries}`);
          await delay(waitTime);
        } else {
          console.error(`PatientImport: RetryWithBackoff failed after ${i + 1} attempts.`, error);
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
    console.log("PatientImport: Starting preview generation...");
    if (files.length === 0) {
      alert('Please select at least one file');
      console.warn("PatientImport: Preview failed: no files selected.");
      return;
    }

    // Mapping is now fixed, so checks like these are less about user input and more about data integrity.
    // They will implicitly pass if `fieldMapping` const is correctly defined.
    if (!fieldMapping.store_abbreviation || !fieldMapping.full_name || !fieldMapping.address) {
      alert('Internal error: Essential fixed mappings are missing. Please contact support.');
      console.error("PatientImport: Preview failed: Essential fixed mappings are missing.");
      return;
    }

    // saveMapping() removed as mapping is fixed
    setIsProcessing(true);
    setPreviewChanges({ toCreate: [], toUpdate: [], errors: [] }); // Clear previous preview

    try {
      console.log(`PatientImport: Processing ${files.length} file(s)`, stores.length, "stores loaded");
      console.log("PatientImport: Fetching existing patients for preview comparison...");
      const existingPatients = await Patient.list();
      console.log(`PatientImport: Found ${existingPatients.length} existing patients.`);
      const toCreate = [];
      const toUpdate = [];
      const errors = [];

      for (const file of files) {
        console.log(`PatientImport: Processing file for preview: ${file.name}`);
        const text = await file.text();
        const lines = text.split('\n').filter((line) => line.trim());
        const dataLines = lines.slice(1); // Skip line 1 (header), start from line 2

        for (let i = 0; i < dataLines.length; i++) {
          const rowNumber = i + 2; // CSV rows are 1-based, and we skipped the header
          try {
            const values = parseCSVLine(dataLines[i]); // Use new CSV parser

            // Use processCsvRowToPatient for consistency and avoid duplication
            const patientData = processCsvRowToPatient(values, fieldMapping, stores);
            console.log(`PatientImport: Preview row ${rowNumber} (${file.name}): Patient data processed:`, patientData.full_name, patientData.address, patientData.store_name);

            if (!patientData.full_name) {
              const errorMsg = `${file.name} Row ${rowNumber}: Skipping - missing full name. Data: ${JSON.stringify(values.slice(0, 5))}`;
              errors.push(errorMsg);
              console.warn(`PatientImport: ${errorMsg}`);
              continue;
            }

            if (!patientData.address) {
              const errorMsg = `${file.name} Row ${rowNumber}: Skipping - missing address for ${patientData.full_name}. Data: ${JSON.stringify(values.slice(0, 5))}`;
              errors.push(errorMsg);
              console.warn(`PatientImport: ${errorMsg}`);
              continue;
            }

            if (!patientData.store_id) {
              const storeAbbrCsv = values[parseInt(fieldMapping.store_abbreviation) - 1] || '';
              const errorMsg = `${file.name} Row ${rowNumber}: Skipping - store not found for abbreviation "${storeAbbrCsv}" (Patient: ${patientData.full_name}).`;
              errors.push(errorMsg);
              console.warn(`PatientImport: ${errorMsg}`);
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

              console.log(`PatientImport: PID matching for "${patientData.full_name}" - CSV PID: "${csvPid}", Found: ${existingPatient ? 'YES (ID: ' + existingPatient.id + ')' : 'NO'}`);
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

              console.log(`PatientImport: Fallback matching for "${patientData.full_name}" (no PID in CSV) - Found: ${existingPatient ? 'YES (ID: ' + existingPatient.id + ')' : 'NO'}`);
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
                console.log(`PatientImport: Preview: Patient ${patientDataForUpdate.full_name} (${existingPatient.id}) to be updated. Changes:`, changes);
              } else {
                console.log(`PatientImport: Preview: Patient ${patientDataForUpdate.full_name} (${existingPatient.id}) found, no changes needed.`);
              }
            } else {
              toCreate.push({
                data: patientData,
                fileName: file.name,
                rowNumber: rowNumber,
                willGeocode: willGeocode
              });
              console.log(`PatientImport: Preview: Patient ${patientData.full_name} to be created.`);
            }

          } catch (error) {
            console.error(`PatientImport: Error processing row ${rowNumber} in file ${file.name} for preview:`, error);
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
          }
        }
      }
      
      console.log(`PatientImport: Collected ${importedPatientPids.size} PIDs and ${importedPatientKeys.size} fallback keys from CSV`);
      console.log(`PatientImport: Importing from ${importingStoreIds.size} store(s)`, Array.from(importingStoreIds));
      
      // Find patients in database not in import
      const missingFromImport = existingPatients.filter(p => {
        // Skip if patient is already inactive
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
      
      console.log(`PatientImport: Found ${missingFromImport.length} patients in database not in CSV`);
      setMissingPatients(missingFromImport);
      
      setPreviewChanges({ toCreate, toUpdate, errors });
      
      // Show missing patients popup first if there are any
      if (missingFromImport.length > 0) {
        setShowMissingPatients(true);
      }
      
      // Store importing store IDs for the popup
      if (!window.__importingStoreIds) {
        window.__importingStoreIds = Array.from(importingStoreIds);
      }
      
      console.log(`PatientImport: Preview generation complete. To Create: ${toCreate.length}, To Update: ${toUpdate.length}, Errors: ${errors.length}, Missing: ${missingFromImport.length}`);

    } catch (error) {
      console.error("PatientImport: Preview generation error:", error);
      alert(`Preview failed: ${error.message}`);
    } finally {
      setIsProcessing(false);
      console.log("PatientImport: Preview generation finished.");
    }
  };

  const confirmAndImport = async () => {
    console.log("PatientImport: Starting confirmation and import process...");
    
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

    try {
      // CRITICAL: Use centralized data operation manager
      await executeDataOperation(async () => {
        console.log('📥 [PatientImport] Starting patient import with data operation manager');
        
        // Retry queue arrays
        const failedCreations = [];
        const failedUpdates = [];

        // Process patients to create
        if (previewChanges.toCreate.length > 0) {
          console.log(`PatientImport: Processing ${previewChanges.toCreate.length} new patients for creation.`);
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
                console.warn(`PatientImport: Geocoding failed for ${patientData.address}:`, geocodeError);
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
              
              // Delay between batches
              if (batchIndex < batches.length - 1) {
                await delay(3000); // 3 second delay between batches
              }
            } catch (error) {
              console.error("PatientImport: Batch creation failed:", error);
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
          console.log(`PatientImport: Processing ${previewChanges.toUpdate.length} patients for update.`);
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
                
                await delay(800); // Increased delay between updates
              } catch (error) {
                const errorMsg = `Update failed for ${patientData.full_name}: ${error.message}`;
                importErrors.push(errorMsg);
                setImportProgress((prev) => ({ ...prev, errors: importErrors.length }));
                failedUpdates.push({ ...item, data: patientData, errorMsg });
                await delay(800);
              }
            }
            
            // Delay between batches
            if (batchStart + UPDATE_BATCH_SIZE < previewChanges.toUpdate.length) {
              await delay(2000); // 2 second delay between update batches
            }
          }
        }

      // --- Retry failed creations (offline DB) ---
      if (failedCreations.length > 0) {
        console.log(`PatientImport: Retrying ${failedCreations.length} failed offline saves...`);
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
            console.log(`PatientImport: Retrying offline save ${i + 1}/${failedCreations.length}: ${patientData.full_name}`);
            
            const patientWithTempId = {
              ...patientData,
              id: `temp_patient_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              created_date: new Date().toISOString(),
              updated_date: new Date().toISOString(),
              _isLocal: true
            };
            
            await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [patientWithTempId]);
            totalCreated++;
            console.log(`PatientImport: Retry offline save successful for ${patientData.full_name}`);

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

            await delay(100);
          } catch (retryError) {
            console.error(`PatientImport: Final offline save failed for ${patientData.full_name}:`, retryError);
            const newErrorMsg = `Final retry failed for ${patientData.full_name} (${patientData.address}) from ${item.fileName} Row ${item.rowNumber}: ${retryError.message}`;
            const errorIndex = importErrors.indexOf(item.errorMsg);
            if (errorIndex > -1) {
              importErrors[errorIndex] = newErrorMsg;
            } else {
              importErrors.push(newErrorMsg);
            }

            setImportProgress((prev) => ({ ...prev, errors: importErrors.length, current: i + 1 }));
            await delay(200);
          }
        }
      }

      // --- Retry failed updates (offline DB) ---
      if (failedUpdates.length > 0) {
        console.log(`PatientImport: Retrying ${failedUpdates.length} failed offline updates...`);
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
            console.log(`PatientImport: Retrying update ${i + 1}/${failedUpdates.length}: ${patientData.full_name} (ID: ${id})`);
            
            // CRITICAL: Retry with backend API
            await base44.entities.Patient.update(id, patientData);
            totalUpdated++;
            console.log(`PatientImport: Retry update successful for ${patientData.full_name}`);

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

            await delay(200);
          } catch (retryError) {
            console.error(`PatientImport: Final update failed for ${patientData.full_name}:`, retryError);
            const newErrorMsg = `Final retry update failed for patient ID ${id} (${patientData.full_name}) from ${item.fileName} Row ${item.rowNumber}: ${retryError.message}`;
            const errorIndex = importErrors.indexOf(item.errorMsg);
            if (errorIndex > -1) {
              importErrors[errorIndex] = newErrorMsg;
            } else {
              importErrors.push(newErrorMsg);
            }
            setImportProgress((prev) => ({ ...prev, errors: importErrors.length, current: i + 1 }));
            await delay(300);
          }
        }
      }

        const aggregatedResults = {
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

        console.log("PatientImport: Import complete via data operation manager");
        
        if (onImportComplete) {
          onImportComplete(aggregatedResults);
        }
        
        return true; // Signal success
      }, { restartDelay: 2000 }); // 2 second delay before restarting smart refresh

    } catch (error) {
      console.error("PatientImport: Overall import error:", error);
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
        }}
      />
    );
  }

  if (showPreview) {
    return (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[9999] overflow-hidden">
                <Card className="rounded-xl border bg-card text-card-foreground shadow w-full max-w-4xl h-[77vh] flex flex-col">
                    <CardHeader className="flex flex-col space-y-1.5 p-3 border-b flex-shrink-0">
                        <div className="flex items-center justify-between">
                            <CardTitle>Import Preview</CardTitle>
                            <Button variant="ghost" size="icon" onClick={() => setShowPreview(false)} className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:bg-accent hover:text-accent-foreground h-9 w-8">
                                <X className="w-4 h-4" />
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-y-auto p-4 space-y-2">
                        {/* Summary */}
                        <div className="grid grid-cols-3 gap-3">
                            <Card>
                                <CardContent className="p-4 px-4 py-4 text-center">
                                    <div className="text-3xl font-bold text-green-600">{previewChanges.toCreate.length}</div>
                                    <div className="text-sm text-slate-600">New Patients</div>
                                </CardContent>
                            </Card>
                            <Card>
                                <CardContent className="p-4 text-center">
                                    <div className="text-3xl font-bold text-blue-600">{previewChanges.toUpdate.length}</div>
                                    <div className="text-sm text-slate-600">Updates</div>
                                </CardContent>
                            </Card>
                            <Card>
                                <CardContent className="p-4 text-center">
                                    <div className="text-3xl font-bold text-red-600">{previewChanges.errors.length}</div>
                                    <div className="text-sm text-slate-600">Errors</div>
                                </CardContent>
                            </Card>
                        </div>

                        {/* New Patients */}
                        {previewChanges.toCreate.length > 0 &&
            <div>
                                <h3 className="text-lg font-semibold text-green-600 mb-3">New Patients ({previewChanges.toCreate.length})</h3>
                                <div className="space-y-1 max-h-[205px] overflow-y-auto border rounded p-2">
                                    {previewChanges.toCreate.map((item, idx) =>
                <div key={idx} className="bg-green-50 border border-green-200 rounded px-2 py-0.5 text-sm flex items-center gap-2 flex-wrap">
                                            <span className="font-mono text-xs bg-green-100 px-2 py-0.5 rounded border border-green-300">
                                                {item.data.patient_id || 'NO PID'}
                                            </span>
                                            <span className="font-medium">{item.data.full_name}</span>
                                            <span className="text-slate-600 flex-1 min-w-0 truncate" title={item.data.address}>{item.data.address}</span>
                                            {item.willGeocode && <span className="text-xs text-yellow-600">📍 Geocode</span>}
                                            <span className="text-xs text-slate-500">{item.fileName} R{item.rowNumber}</span>
                                        </div>
                )}
                                </div>
                            </div>
            }

                        {/* Updates */}
                        {previewChanges.toUpdate.length > 0 &&
            <div className="">
                                <h3 className="text-lg font-semibold text-blue-600 mb-2">Updates ({previewChanges.toUpdate.length})</h3>
                                <div className="space-y-1 max-h-[445px] overflow-y-auto border rounded p-2">
                                    {previewChanges.toUpdate.map((item, idx) =>
                <div key={idx} className="bg-blue-50 border border-blue-200 rounded p-1">
                                            <div className="flex items-center gap-2 flex-wrap text-sm">
                                                <span className="font-mono text-xs bg-blue-100 px-2 py-0.5 rounded border border-blue-300">
                                                    {item.data.patient_id || item.existing.patient_id || 'NO PID'}
                                                </span>
                                                <span className="font-medium">{item.data.full_name}</span>
                                                <span className="text-slate-600 flex-1 min-w-0 truncate" title={item.data.address}>{item.data.address}</span>
                                                {item.willGeocode && <span className="text-xs text-yellow-600">📍 Geocode</span>}
                                                <span className="text-xs text-slate-500">{item.fileName} R{item.rowNumber}</span>
                                            </div>
                                            <div className="mt-2 space-y-1">
                                                {item.changes.map((change, cidx) => {
                      // Format field names for display
                      const fieldDisplayName = change.field.
                      replace(/_/g, ' ').
                      replace(/\b\w/g, (l) => l.toUpperCase());

                      return (
                        <div key={cidx} className="flex items-center gap-2 text-xs">
                                                            <span className="font-medium text-slate-700 w-40 shrink-0">{fieldDisplayName}:</span>
                                                            <span className="bg-red-100 text-red-800 px-2 py-1 rounded line-through flex-grow min-w-0 truncate" title={String(change.oldValue)}>
                                                                {String(change.oldValue)}
                                                            </span>
                                                            <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                                                            <span className="bg-green-100 text-green-800 px-2 py-1 rounded flex-grow min-w-0 truncate" title={String(change.newValue)}>
                                                                {String(change.newValue)}
                                                            </span>
                                                        </div>);

                    })}
                                            </div>
                                        </div>
                )}
                                </div>
                            </div>
            }

                        {/* Errors */}
                        {previewChanges.errors.length > 0 &&
            <div>
                                <h3 className="text-lg font-semibold text-red-600 mb-3">Errors ({previewChanges.errors.length})</h3>
                                <div className="space-y-1 max-h-[150px] overflow-y-auto bg-red-50 p-3 rounded border border-red-200">
                                    {previewChanges.errors.map((error, idx) =>
                <div key={idx} className="text-xs text-red-800">{error}</div>
                )}
                                </div>
                            </div>
            }
                    </CardContent>
                    <div className="border-t p-2 flex justify-end gap-3 flex-shrink-0">
                        <Button variant="outline" onClick={() => setShowPreview(false)} disabled={isProcessing}>
                            Cancel
                        </Button>
                        <Button
              onClick={confirmAndImport}
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={isProcessing || previewChanges.toCreate.length === 0 && previewChanges.toUpdate.length === 0 && previewChanges.errors.length === 0}>

                            {isProcessing ? 'Importing...' : `Confirm & Import (${previewChanges.toCreate.length} new, ${previewChanges.toUpdate.length} updates)`}
                        </Button>
                    </div>
                </Card>
            </div>);

  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[9999] overflow-hidden">
            <Card className={`rounded-xl border bg-card text-card-foreground shadow w-full max-w-5xl flex flex-col relative transition-all duration-300 ${files.length > 0 ? 'h-[70vh]' : 'h-[42vh]'}`}>
                {/* Floating Progress Overlay */}
                {isProcessing &&
        <div className="absolute inset-0 bg-white bg-opacity-95 z-[99999] flex items-center justify-center p-6">
                        <div className="w-full max-w-2xl">
                            <div className="border-2 border-blue-200 bg-blue-50 rounded-lg p-6 space-y-4 shadow-lg">
                                <div className="flex justify-between items-center">
                                    <div>
                                        <h3 className="font-semibold text-lg text-blue-900">{getPhaseLabel()}</h3>
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

                                <div className="grid grid-cols-3 gap-4 pt-2">
                                    <div className="bg-white rounded-lg p-3 text-center">
                                        <div className="text-2xl font-bold text-green-600">{importProgress.created}</div>
                                        <div className="text-xs text-slate-600">Total Created</div>
                                    </div>
                                    <div className="bg-white rounded-lg p-3 text-center">
                                        <div className="text-2xl font-bold text-blue-600">{importProgress.updated}</div>
                                        <div className="text-xs text-slate-600">Total Updated</div>
                                    </div>
                                    <div className="bg-white rounded-lg p-3 text-center">
                                        <div className="text-2xl font-bold text-red-600">{importProgress.errors}</div>
                                        <div className="text-xs text-slate-600">Total Errors</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
        }

                <CardHeader className="bg-slate-200 px-4 py-2 flex flex-col space-y-1.5 flex-shrink-0 border-b">
                    <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <Upload className="w-5 h-5" />
                            Import Patients from CSV
                        </CardTitle>
                        {onClose &&
            <Button variant="ghost" size="icon" onClick={onClose} disabled={isProcessing}>
                                <X className="w-4 h-4" />
                            </Button>
            }
                    </div>
                </CardHeader>
                
                <CardContent className="px-3 py-3 flex-1 overflow-y-auto space-y-2">
                    {/* Two-column layout: File Selector (40%) + Import Rules (60%) */}
                    <div className="flex gap-3">
                        {/* Left Column: File Selector - 40% */}
                        <div className="flex-[1] min-w-[30%] space-y-2 p-2">
                            <div className="space-y-2">
                                <Label htmlFor="csv-upload">Select CSV File(s)</Label>
                                <Input
                  id="csv-upload"
                  type="file"
                  accept=".csv"
                  multiple
                  onChange={handleFileChange}
                  disabled={isProcessing} />

                                <p className="text-xs text-slate-500">
                                    <strong>IMPORTANT:</strong> Line 1 is always skipped (header row). Data starts from line 2. You can select multiple files.
                                </p>
                            </div>

                            {files.length > 0 &&
              <div className="space-y-1">
                                    <Label className="text-sm font-medium">Selected Files ({files.length})</Label>
                                    <div className="space-y-1 max-h-32 overflow-y-auto border rounded-lg p-1">
                                        {files.map((file, index) =>
                  <div key={index} className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded text-sm">
                                                <span className="truncate flex-1">{file.name}</span>
                                                {!isProcessing &&
                    <button
                      onClick={() => removeFile(index)}
                      className="ml-2 text-slate-400 hover:text-red-600"
                      aria-label={`Remove file ${file.name}`}>

                                                        <X className="w-4 h-4" />
                                                    </button>
                    }
                                            </div>
                  )}
                                    </div>
                                </div>
              }
                        </div>

                        {/* Right Column: Import Rules - 60% */}
                        <div className="bg-blue-50 px-2 py-1 rounded-lg flex-[3] border border-blue-200">
                        <h4 className="font-semibold mb-3 text-blue-900">Import Rules:</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-0 gap-y-2 text-xs text-blue-800">
                            {/* Left Column */}
                            <div className="space-y-1">
                                <div>
                                    <strong>• Line 1 is ALWAYS skipped</strong>
                                    <p className="ml-3 text-blue-700">Header row - data starts from line 2</p>
                                </div>
                                <div>
                                    <strong>• Fixed Column Mapping:</strong>
                                    <ul className="ml-3 text-blue-700 list-disc list-inside">
                                        <li>Col 1: Store Abbreviation</li>
                                        <li>Col 2: Full Name</li>
                                        <li>Col 3: Address</li>
                                        <li>Col 4: Phone</li>
                                        <li>Col 5: Notes</li>
                                        <li>Col 13: Last Delivery Date</li>
                                    </ul>
                                </div>
                                <div>
                                    <strong>• Multiple Files</strong>
                                    <p className="ml-3 text-blue-700">Each CSV processed sequentially</p>
                                </div>
                            </div>

                            {/* Right Column */}
                            <div className="space-y-1">
                                <div>
                                    <strong>• More Columns:</strong>
                                    <ul className="ml-3 text-blue-700 list-disc list-inside">
                                        <li>Col 14: Distance From Store</li>
                                        <li>Col 15: Time Window Start</li>
                                        <li>Col 16: Time Window End</li>
                                        <li>Col 17: Latitude</li>
                                        <li>Col 18: Longitude</li>
                                        <li>Col 19: Inactive ('X' = inactive)</li>
                                        <li>Col 20: Patient ID (PID)</li>
                                    </ul>
                                </div>
                                <div>
                                    <strong>• Auto-Processing:</strong>
                                    <ul className="ml-3 text-blue-700 list-disc list-inside">
                                        <li>Store matching by abbreviation</li>
                                        <li>Unit/Buzz extraction from address & notes</li>
                                        <li>Recurring patterns extraction</li>
                                        <li>Preferences extraction</li>
                                        <li>AI geocoding if coordinates missing</li>
                                        <li>Match by PID or store+name+address</li>
                                        <li>Auto-inactive: "(Old" in name, "(Deceased" in notes</li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                        </div>
                    </div>

                    {/* Live Preview Table */}
                    {previewData.length > 0 &&
          <div className="border rounded-lg overflow-hidden">
                            <div className="bg-slate-100 px-4 py-2 font-semibold text-sm border-b">
                                Live Preview - First 5 Rows
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm table-fixed">
                                    <colgroup>
                                        <col style={{ width: '80px' }} />
                                        <col style={{ width: '150px' }} />
                                        <col style={{ width: '200px' }} />
                                        <col style={{ width: '100px' }} />
                                        <col style={{ width: '90px' }} />
                                        <col style={{ width: '90px' }} />
                                        <col style={{ width: '200px' }} />
                                    </colgroup>
                                    <thead className="bg-slate-100 border-b sticky top-0 z-10">
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
                                </table>
                            </div>

                            <div className="overflow-y-auto max-h-96">
                                <table className="w-full text-sm table-fixed">
                                    <colgroup>
                                        <col style={{ width: '80px' }} />
                                        <col style={{ width: '150px' }} />
                                        <col style={{ width: '200px' }} />
                                        <col style={{ width: '100px' }} />
                                        <col style={{ width: '90px' }} />
                                        <col style={{ width: '90px' }} />
                                        <col style={{ width: '200px' }} />
                                    </colgroup>
                                    <tbody>
                                        {previewData.map((patient, idx) =>
                  <tr key={idx} className="border-b hover:bg-slate-50">
                                                <td className="p-2 font-mono text-xs">{patient.patient_id || '-'}</td>
                                                <td className="p-2 text-xs">{patient.full_name || '-'}</td>
                                                <td className="p-2 text-xs max-w-[200px] truncate" title={patient.address}>{patient.address || '-'}</td>
                                                <td className="p-2 text-xs font-mono">{patient.unit_number || '-'}</td>
                                                <td className="p-2 text-xs">{patient.phone || '-'}</td>
                                                <td className="p-2 text-xs">
                                                    {patient.store_name !== 'N/A' ?
                      <Badge style={{ backgroundColor: patient.store_color, fontSize: '10px' }}>
                                                            {patient.store_name}
                                                        </Badge> :

                      <span className="text-slate-400">{patient.store_name}</span>
                      }
                                                </td>
                                                <td className="p-2 text-xs max-w-[250px] truncate text-slate-600" title={patient.notes}>
                                                    {patient.notes || '-'}
                                                </td>
                                            </tr>
                  )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
          }

                    <Button
            onClick={generatePreview}
            disabled={isProcessing || files.length === 0} className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-3 w-full">
            

                        {isProcessing ? 'Generating Preview...' : `Preview Import (${files.length} file${files.length !== 1 ? 's' : ''})`}
                    </Button>

                    {importResult &&
          <div className="space-y-2 border-t pt-4">
            <div className="flex justify-around text-center">
            <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="w-5 h-5" />
                <span>Created: {importResult.created}</span>
            </div>

            <div className="flex items-center gap-2 text-blue-600">
                <AlertCircle className="w-5 h-5" />
                <span>Updated: {importResult.updated}</span>
            </div>

            <div className="flex items-center gap-2 text-purple-600">
                <AlertCircle className="w-5 h-5" />
                <span>Geocoded: {importResult.geocoded}</span>
            </div>
            </div>
                            {importResult.fileResults && importResult.fileResults.length > 0 &&
            <div className="mt-4">
                                    <h4 className="font-semibold text-sm text-slate-700 mb-2">Overall Results:</h4>
                                    <div className="space-y-1 text-xs">
                                        {importResult.fileResults.map((fr, idx) =>
                <div key={idx} className="bg-slate-50 p-2 rounded">
                                                <span className="font-medium">{fr.fileName}:</span> {fr.created || 0} created, {fr.updated || 0} updated, {fr.errors.length || 0} errors
                                                {fr.geocoded > 0 && `, ${fr.geocoded} geocoded`}
                                            </div>
                )}
                                    </div>
                                </div>
            }

                            {importResult.errors.length > 0 &&
            <div className="space-y-1">
                                    <div className="flex items-center gap-2 text-red-600">
                                        <XCircle className="w-5 h-5" />
                                        <span>Errors: {importResult.errors.length}</span>
                                    </div>
                                    <div className="max-h-32 overflow-y-auto bg-red-50 p-2 rounded text-xs">
                                        {importResult.errors.map((err, i) =>
                <div key={i} className="text-red-800">{err}</div>
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