import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
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
import { batchUpdateAMPM, determineDeliveryAMPM, getPickupStopIdForDelivery } from '../utils/ampmUtils';
import { getAllDriverUsers } from '../utils/driverSelectors';
import { offlineDB } from '../utils/offlineDatabase';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { driverLocationPoller } from '../utils/driverLocationPoller';
import { processDeliveryNotes } from '../utils/notesProcessor';
import { executeDataOperation } from '../utils/dataOperationManager';
import { globalFilters } from '../utils/globalFilters';

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

        await delay(waitTime);
      } else {

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

// Check if delivery is a return (identified by markers in notes/patient name, NOT status)
const isReturnDelivery = (delivery, patients, stores) => {
  if (!delivery || typeof delivery !== 'object') return false;
  const validPatients = Array.isArray(patients) ? patients : [];
  const validStores = Array.isArray(stores) ? stores : [];
  const notesLower = (delivery.delivery_notes || '').toLowerCase();
  const patient = validPatients.find((p) => p.id === delivery.patient_id);
  const patientNameLower = (patient?.full_name || delivery.patient_name || '').toLowerCase();

  // CRITICAL: Returns are marked by "(RTN)" or "return" in notes/patient name, NOT by status
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
    lowerAddress.includes(`suite ${trimmedUnit.toLowerCase()}`))
    {
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


export default function RouteImport({
  onImportComplete,
  onCancel,
  stores,
  allUsers,
  currentUser,
  allDeliveries
}) {
  const [files, setFiles] = useState([]);
  const [fileDriverMap, setFileDriverMap] = useState({}); // Map of filename -> driver info
  const [isProcessing, setIsProcessing] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showDriverMatching, setShowDriverMatching] = useState(false);
  const [previewData, setPreviewData] = useState({ deliveriesToCreate: [], deliveriesToUpdate: [], skippedItems: [], errors: [] });
  const [isParsing, setIsParsing] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [showProgress, setShowProgress] = useState(false);
  const [patients, setPatients] = useState([]);
  const fileInputRef = useRef(null);
  const hasOpenedFileDialogRef = useRef(false); // CRITICAL: Track if dialog has been auto-opened

  const [previewFilterDriver, setPreviewFilterDriver] = useState('all');
  const [previewFilterDate, setPreviewFilterDate] = useState('all');
  const [purgeBeforeImport, setPurgeBeforeImport] = useState(false);
  const [importError, setImportError] = useState(null); // { message, record, lineNumber }

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
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  // Use a ref to store fresh stores data that won't cause stale closure issues
  const freshStoresRef = useRef([]);

  // Track mobile viewport changes
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const findStoreByAbbreviation = useCallback((abbr, storesOverride = null) => {
    if (!abbr) return null;
    // CRITICAL: Use storesOverride if provided (from handlePreview), else use ref, else fallback
    const storesToSearch = storesOverride || freshStoresRef.current || allStores || stores || [];
    if (!Array.isArray(storesToSearch) || storesToSearch.length === 0) {

      return null;
    }
    const found = storesToSearch.find((s) => s.abbreviation?.toLowerCase() === abbr.toLowerCase());
    if (!found) {

    }
    return found;
  }, [allStores, stores]);

  const findDispatcherByStore = useCallback((store) => {
    if (!store) return null;

    // Use allDriverUsers (all cities) or fallback to allUsers prop
    const usersToSearch = allDriverUsers.length > 0 ? allDriverUsers : allUsers || [];

    if (store.dispatcher_id) {
      const dispatcher = usersToSearch.find((u) => u.id === store.dispatcher_id);
      if (dispatcher) {
        return dispatcher;
      } else {

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
      } else {

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
    const importedPatient = importedDeliveryPatientId ? patientsData.find((p) => p.id === importedDeliveryPatientId) : null;
    const importedTrackingNumber = (importedDelivery.tracking_number || '').trim();
    const importedAMPM = importedDelivery.ampm_deliveries;

    // CRITICAL: Match by driver_id (not driver_name) to ensure we find deliveries
    // regardless of which city they were created in
    const importedDriverId = importedDelivery.driver_id;

    // CRITICAL: PRIMARY DEDUPLICATION KEY - SID + Date + Driver ID
    // This is the MOST RELIABLE way to identify duplicates and prevent data conflicts
    if (importedDeliveryStopId && importedDeliveryDate && importedDriverId) {
      const exactMatch = existingDeliveries.find((d) => 
        d.stop_id === importedDeliveryStopId &&
        d.delivery_date === importedDeliveryDate &&
        d.driver_id === importedDriverId
      );
      
      if (exactMatch) {
        return { match: exactMatch, reason: `EXACT MATCH: SID(${importedDeliveryStopId}) + Date + Driver` };
      }
    }

    // CRITICAL: PREVENT DUPLICATE CREATION FOR RE-IMPORTS
    // If the imported delivery doesn't have a SID (required for matching),
    // and we're importing a delivery that already exists (even without SID),
    // treat it as a new delivery to prevent overwrites
    // This prevents stop 10 from being reused for stop 13 on re-import
    if (!importedDeliveryStopId && importedDeliveryPatientId && importedDeliveryDate && importedDriverId) {
      const samePatientDeliveries = existingDeliveries.filter((d) =>
        d.delivery_date === importedDeliveryDate &&
        d.driver_id === importedDriverId &&
        d.patient_id === importedDeliveryPatientId &&
        !d.stop_id // Only match deliveries without stop_id
      );
      
      // If there's exactly one match without a SID, this might be a re-import
      // In that case, require additional criteria (time, order) to match
      if (samePatientDeliveries.length === 1) {
        const candidate = samePatientDeliveries[0];
        const importedTime = importedDelivery.actual_delivery_time ? new Date(importedDelivery.actual_delivery_time).getTime() : null;
        const candidateTime = candidate.actual_delivery_time ? new Date(candidate.actual_delivery_time).getTime() : null;
        
        // Only match if times are very close (within 5 minutes)
        if (importedTime && candidateTime) {
          const timeDiff = Math.abs(importedTime - candidateTime);
          if (timeDiff <= 300000) { // 5 minutes
            return { match: candidate, reason: `PID Match (same patient, time within 5min)` };
          }
        }
        
        // No time match - treat as new delivery to prevent overwrites
        return { match: null, reason: `PID exists but no SID match - creating new to prevent overwrite` };
      }
    }

    // CRITICAL: Filter existing deliveries by date AND driver_id (not city-dependent)
    // This ensures we find matches regardless of which city the delivery was created in
    const sameDateDeliveries = existingDeliveries.filter((d) => {
      if (d.delivery_date !== importedDeliveryDate) return false;

      // Match by driver_id for accuracy across cities
      if (importedDriverId && d.driver_id) {
        return d.driver_id === importedDriverId;
      }

      // Fallback to driver_name matching if no driver_id
      const existingDriverName = (d.driver_name || '').trim().toLowerCase();
      const driverMatch = !existingDriverName || existingDriverName === importedDriverName;

      return driverMatch;
    });

    // CRITICAL: Check for multiple patient deliveries with same PID
    // If there are multiple stops for the same PID, require SID to match
    let hasMultipleSamePID = false;
    let multipleCount = 0;
    if (importedDeliveryPatientId) {
      const samePIDDeliveries = sameDateDeliveries.filter((d) => d.patient_id === importedDeliveryPatientId);
      multipleCount = samePIDDeliveries.length;
      if (samePIDDeliveries.length > 1) {
        hasMultipleSamePID = true;
      }
    }

    if (hasMultipleSamePID) {
      // Multiple stops for this PID - MUST match by SID to prevent overwrites
      if (importedDeliveryStopId) {
        const sidMatch = sameDateDeliveries.find((d) => {
          const existingSID = (d.stop_id || '').trim();
          const matches = existingSID === importedDeliveryStopId && d.patient_id === importedDeliveryPatientId;
          return matches;
        });
        if (sidMatch) {
          return { match: sidMatch, reason: `SID Match (${importedDeliveryStopId}) - ${multipleCount} stops for PID` };
        } else {
          // No SID match found - this is likely a NEW stop for this PID
          return { match: null, reason: `Multiple stops for PID - SID (${importedDeliveryStopId}) not matched, creating new` };
        }
      } else {
        return { match: null, reason: `Multiple stops for PID (${multipleCount} existing) - no SID provided to disambiguate, creating new` };
      }
    }

    if (importedDeliveryStopId) {
      // CRITICAL: First try exact SID match
      let sidMatch = sameDateDeliveries.find((d) => {
        const existingSID = (d.stop_id || '').trim();
        const matches = existingSID === importedDeliveryStopId;
        return matches;
      });
      
      if (sidMatch) {
        return { match: sidMatch, reason: `SID Match (${importedDeliveryStopId})` };
      }
      
      // CRITICAL: If no exact SID match but we have a patient, try PID + update SID
      // BUT ONLY if there's exactly 1 existing stop for this PID (not multiple)
      if (importedDeliveryPatientId) {
        const existingStopsForPID = sameDateDeliveries.filter((d) => d.patient_id === importedDeliveryPatientId);
        // Only match and update SID if there's exactly 1 existing stop for this PID
        if (existingStopsForPID.length === 1) {
          const pidMatch = existingStopsForPID[0];
          if (pidMatch && pidMatch.stop_id !== importedDeliveryStopId) {
            // Found SINGLE matching patient delivery with different SID - update the SID
            return { 
              match: pidMatch, 
              reason: `PID Match (single stop) - SID will be updated from "${pidMatch.stop_id || 'none'}" to "${importedDeliveryStopId}"` 
            };
          }
        } else if (existingStopsForPID.length > 1) {
          // Multiple existing stops for this PID - don't match, create new instead
          return { match: null, reason: `Multiple stops for PID (${existingStopsForPID.length} existing) - SID mismatch, creating new to avoid overwrite` };
        }
      }

      // Continue with other matching strategies - try PID + fuzzy scoring
      if (importedDeliveryPatientId) {
        const importedStopOrder = importedDelivery.stop_order;
        const importedTime = importedDelivery.actual_delivery_time ? new Date(importedDelivery.actual_delivery_time).getTime() : null;
        const importedTR = importedTrackingNumber ? parseInt(importedTrackingNumber, 10) : null;

        const highProbabilityMatches = sameDateDeliveries.filter((d) => {
          if (d.patient_id !== importedDeliveryPatientId) return false;

            let score = 0;
            let reasons = [];

            if (importedStopOrder && d.stop_order) {
              const orderDiff = Math.abs(importedStopOrder - d.stop_order);
              if (orderDiff <= 5) {
                score += 10;
                reasons.push(`Order±${orderDiff}`);
              }
            }

            if (importedTime && d.actual_delivery_time) {
              const existingTime = new Date(d.actual_delivery_time).getTime();
              const timeDiff = Math.abs(importedTime - existingTime);
              if (timeDiff <= 3600000) {
                score += 10;
                reasons.push(`Time±${Math.round(timeDiff / 60000)}min`);
              }
            }

            if (importedTR !== null && d.tracking_number) {
              const existingTR = parseInt(d.tracking_number, 10);
              if (!isNaN(existingTR)) {
                const importedBucket = Math.floor(importedTR / 20);
                const existingBucket = Math.floor(existingTR / 20);
                if (importedBucket === existingBucket) {
                  score += 10;
                  reasons.push(`TR-Range[${importedBucket * 20}-${importedBucket * 20 + 19}]`);
                }
              }
            }

          d._probScore = score;
          d._probReasons = reasons;
          return score >= 20;
        });

        if (highProbabilityMatches.length === 1) {
          const match = highProbabilityMatches[0];
          const reasonText = `Highly Probable: PID + ${match._probReasons.join(' + ')}`;
          return { match, reason: reasonText };
        } else if (highProbabilityMatches.length > 1) {
          highProbabilityMatches.sort((a, b) => (b._probScore || 0) - (a._probScore || 0));
          const bestMatch = highProbabilityMatches[0];
          const reasonText = `Highly Probable (Best): PID + ${bestMatch._probReasons.join(' + ')}`;
          return { match: bestMatch, reason: reasonText };
        }
      }
    }

    if (importedDeliveryPatientId) {
      const patientIdMatches = sameDateDeliveries.filter((d) => {
        const existingPID = (d.patient_id || '').trim();
        return existingPID === importedDeliveryPatientId;
      });

      if (patientIdMatches.length === 1) {
        const patientIdMatch = patientIdMatches[0];
        return { match: patientIdMatch, reason: `PID Match (${importedDeliveryPatientId})` };
      } else if (patientIdMatches.length > 1) {

        const importedTime = importedDelivery.actual_delivery_time ? new Date(importedDelivery.actual_delivery_time).getTime() : null;
        const importedStopOrder = importedDelivery.stop_order || null;

        let bestMatch = null;
        let bestScore = 0;

        for (const candidate of patientIdMatches) {
          let score = 0;
          let reasons = [];

          if (importedTime && candidate.actual_delivery_time) {
            const candidateTime = new Date(candidate.actual_delivery_time).getTime();
            const timeDiff = Math.abs(importedTime - candidateTime);
            const timeDiffMinutes = Math.round(timeDiff / 60000);

            if (timeDiff <= 3600000) {
              score += 10;
              reasons.push(`Time ±${timeDiffMinutes}min`);
            }
          }

          if (importedStopOrder !== null && candidate.stop_order !== null) {
            const orderDiff = Math.abs(importedStopOrder - candidate.stop_order);
            if (orderDiff <= 3) {
              score += 10;
              reasons.push(`Order ±${orderDiff}`);
            }
          }

          if (score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
            bestMatch._fuzzyReasons = reasons;
          }
        }

        if (bestMatch && bestScore >= 10) {
          const reasonText = `PID Match + ${bestMatch._fuzzyReasons.join(', ')}`;
          return { match: bestMatch, reason: reasonText };
        } else {
          return { match: null, reason: `Multiple PID matches - fuzzy criteria not met` };
        }
      }
    }

    if (importedTrackingNumber && !importedDeliveryStopId) {
      const trackingNumberMatch = sameDateDeliveries.find((d) => {
        const existingTR = (d.tracking_number || '').trim();
        const matches = existingTR === importedTrackingNumber;
        return matches;
      });
      if (trackingNumberMatch) {
        return { match: trackingNumberMatch, reason: `TR# Match (${importedTrackingNumber})` };
      }
    }

    if (!importedDeliveryPatientId && importedDelivery.store_id && !importedDeliveryStopId && !importedTrackingNumber) {
      const pickupMatch = sameDateDeliveries.find((d) =>
      d.store_id === importedDelivery.store_id && (
      !d.patient_id || d.patient_id === '') &&
      !d.stop_id &&
      !d.tracking_number
      );

      if (pickupMatch) {
        return { match: pickupMatch, reason: `Pickup Match (Store)` };
      }
    }

    if (!importedDeliveryPatientId && importedDelivery.store_id) {
      const importedTime = importedDelivery.actual_delivery_time ? new Date(importedDelivery.actual_delivery_time).getTime() : null;
      const importedAddress = (importedDelivery.delivery_address || '').toLowerCase().trim();
      const importedStopOrder = importedDelivery.stop_order;
      const importedTR = importedTrackingNumber ? importedTrackingNumber.trim() : null;

      const highProbabilityPickups = sameDateDeliveries.filter((d) => {
        if (d.patient_id) return false;
        if (d.store_id !== importedDelivery.store_id) return false;

        let score = 0;
        let reasons = [];

        const existingAddress = (d.delivery_address || '').toLowerCase().trim();
        if (importedAddress && existingAddress && importedAddress === existingAddress) {
          score += 15;
          reasons.push('Address');
        }

        if (importedTime && d.actual_delivery_time) {
          const existingTime = new Date(d.actual_delivery_time).getTime();
          const timeDiff = Math.abs(importedTime - existingTime);
          if (timeDiff <= 3600000) {
            score += 15;
            reasons.push(`Time±${Math.round(timeDiff / 60000)}min`);
          }
        }

        if (importedStopOrder && d.stop_order) {
          const orderDiff = Math.abs(importedStopOrder - d.stop_order);
          if (orderDiff <= 5) {
            score += 10;
            reasons.push(`Order±${orderDiff}`);
          }
        }

        if (importedTR && d.tracking_number) {
          const existingTR = (d.tracking_number || '').trim();
          if (importedTR === existingTR) {
            score += 10;
            reasons.push('TR#-Exact');
          }
        }

        d._pickupProbScore = score;
        d._pickupProbReasons = reasons;
        return score >= 15;
      });

      if (highProbabilityPickups.length === 1) {
        const match = highProbabilityPickups[0];
        const reasonText = `Highly Probable Pickup: Store + ${match._pickupProbReasons.join(' + ')}`;
        return { match, reason: reasonText };
      } else if (highProbabilityPickups.length > 1) {
        highProbabilityPickups.sort((a, b) => (b._pickupProbScore || 0) - (a._pickupProbScore || 0));
        const bestMatch = highProbabilityPickups[0];
        const reasonText = `Highly Probable Pickup (Best): Store + ${bestMatch._pickupProbReasons.join(' + ')}`;
        return { match: bestMatch, reason: reasonText };
      }
    }

    return { match: null, reason: 'No match found - all criteria failed' };
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
    { key: 'paid_km_override', label: 'Paid KM Override' },
    { key: 'signature_needed', label: 'Signature' },
    { key: 'fridge_item', label: 'Fridge' },
    { key: 'oversized', label: 'Oversized' },
    { key: 'after_hours_pickup', label: 'After Hrs' },
    { key: 'ampm_deliveries', label: 'AM/PM' },
    { key: 'first_delivery', label: 'First Delivery' }];
    // NOTE: PUID is intentionally excluded from change detection
    // When re-importing, we don't want to flag PUID differences as changes
    // because PUID is auto-assigned during import and may vary between imports


    fieldsToCompare.forEach((field) => {
      const existingValue = existingDelivery[field.key];
      const importedValue = importedDelivery[field.key];

      const normalizedExisting = existingValue === null || existingValue === undefined || typeof existingValue === 'string' && existingValue.trim() === '' ? null : existingValue;
      const normalizedImported = importedValue === null || importedValue === undefined || typeof importedValue === 'string' && importedValue.trim() === '' ? null : importedValue;

      if (field.key === 'actual_delivery_time') {
        const existingTimeStr = normalizedExisting ? format(new Date(normalizedExisting), 'HH:mm') : null;
        const importedTimeStr = normalizedImported ? format(new Date(normalizedImported), 'HH:mm') : null;

        if (existingTimeStr !== importedTimeStr) {
          changes.push(`${field.label}: ${existingTimeStr || 'none'} → ${importedTimeStr || 'none'}`);
        }
      } else if (field.key === 'cod_total_amount_required') {
        const existingCod = normalizedExisting ?? 0;
        const importedCod = normalizedImported ?? 0;
        if (existingCod !== importedCod) {
          const displayExisting = normalizedExisting === null ? 'none' : normalizedExisting.toString();
          const displayImported = normalizedImported === null ? 'none' : normalizedImported.toString();
          changes.push(`${field.label}: ${displayExisting} → ${displayImported}`);
        }
      } else if (field.key === 'paid_km_override') {
        const existingKm = normalizedExisting ?? 0;
        const importedKm = normalizedImported ?? 0;
        if (existingKm !== importedKm) {
          const displayExisting = normalizedExisting === null ? 'none' : normalizedExisting.toFixed(2);
          const displayImported = normalizedImported === null ? 'none' : normalizedImported.toFixed(2);
          changes.push(`${field.label}: ${displayExisting} → ${displayImported}`);
        }
      } else if (normalizedExisting !== normalizedImported) {
        let displayExisting = normalizedExisting === null ? 'none' : typeof normalizedExisting === 'boolean' ? normalizedExisting ? 'true' : 'false' : normalizedExisting.toString();
        let displayImported = normalizedImported === null ? 'none' : typeof normalizedImported === 'boolean' ? normalizedImported ? 'true' : 'false' : normalizedImported.toString();

        changes.push(`${field.label}: ${displayExisting} → ${displayImported}`);
      }
    });

    return changes;
  }, []);

  const handleFileChange = async (e) => {
    try {
      // CRITICAL: Prevent default to avoid any form submission or page reload
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      
      const selectedFiles = Array.from(e.target.files);
      
      // CRITICAL: Clear file input value immediately to prevent duplicate triggers
      if (e.target) {
        e.target.value = '';
      }
      
      if (selectedFiles.length === 0) {
        console.log('[RouteImport] No files selected');
        return;
      }
      
      // CRITICAL: Limit file selection to prevent memory issues on tablets
      if (selectedFiles.length > 10) {
        alert('Maximum 10 files at a time. Please select fewer files.');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        return;
      }
      
      console.log(`[RouteImport] Processing ${selectedFiles.length} files...`);
      
      // Prevent state updates from accumulating - use minimal processing
      let usersToSearch = allDriverUsers.length > 0 ? allDriverUsers : allUsers || [];
      const newFileDriverMap = {};
      
      // CRITICAL: Track if any drivers failed to match
      const unmatchedFiles = [];
      
      for (const file of selectedFiles) {
        const driverName = file.name
          .replace(/ Route\.(csv|tsv|txt)$/i, '')
          .replace(/\.(csv|tsv|txt)$/i, '')
          .trim();
        
        // Optimized search - break early
        let matchedDriver = null;
        for (const user of usersToSearch) {
          const userName = (user.user_name || user.full_name || '').trim();
          if (userName.toLowerCase() === driverName.toLowerCase()) {
            matchedDriver = user;
            break; // Stop searching after first match
          }
        }
        
        if (!matchedDriver) {
          unmatchedFiles.push({ file, driverName });
        }
        
        newFileDriverMap[file.name] = {
          extractedName: driverName,
          driver: matchedDriver
        };
      }
      
      // CRITICAL: If any files failed to match, attempt to reload AppUser data
      if (unmatchedFiles.length > 0) {
        console.log(`⚠️ [RouteImport] ${unmatchedFiles.length} files failed driver matching - attempting reload...`);
        setProgressMessage(`Reloading driver data - ${unmatchedFiles.length} drivers not found...`);
        setShowProgress(true);
        setProgressPercent(10);
        
        try {
          // STEP 1: Try offline DB first
          console.log('📦 [RouteImport] Attempting to reload from offline DB...');
          let refreshedAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
          
          // STEP 2: If offline DB is empty or still no matches, clear and refresh from online
          if (!refreshedAppUsers || refreshedAppUsers.length === 0) {
            console.log('📥 [RouteImport] Offline DB empty - fetching from online DB...');
            setProgressMessage('Offline DB empty - fetching drivers from online database...');
            setProgressPercent(30);
            
            refreshedAppUsers = await base44.entities.AppUser.list();
            
            if (refreshedAppUsers && refreshedAppUsers.length > 0) {
              // Save to offline DB for future
              await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, refreshedAppUsers);
              console.log(`✅ [RouteImport] Refreshed ${refreshedAppUsers.length} AppUsers from online DB`);
            }
          } else {
            console.log(`📦 [RouteImport] Loaded ${refreshedAppUsers.length} AppUsers from offline DB`);
          }
          
          setProgressPercent(50);
          
          // STEP 3: Rebuild driver list
          const isAdmin = userHasRole(currentUser, 'admin');
          if (isAdmin) {
            const allAuthUsers = await base44.entities.User.list();
            const mergedUsers = allAuthUsers.map((authUser) => {
              const appUser = refreshedAppUsers.find((au) => au.user_id === authUser.id);
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
            usersToSearch = mergedUsers;
            setAllDriverUsers(mergedUsers);
          } else {
            const pseudoUsers = refreshedAppUsers.map((au) => ({
              id: au.user_id,
              user_id: au.user_id,
              user_name: au.user_name,
              full_name: au.user_name,
              app_roles: au.app_roles || [],
              status: au.status
            }));
            usersToSearch = pseudoUsers;
            setAllDriverUsers(pseudoUsers);
          }
          
          setProgressPercent(70);
          setProgressMessage('Retrying driver matching with refreshed data...');
          
          // STEP 4: Retry matching with refreshed data
          let stillUnmatched = 0;
          for (const { file, driverName } of unmatchedFiles) {
            let matchedDriver = null;
            for (const user of usersToSearch) {
              const userName = (user.user_name || user.full_name || '').trim();
              if (userName.toLowerCase() === driverName.toLowerCase()) {
                matchedDriver = user;
                break;
              }
            }
            
            if (matchedDriver) {
              console.log(`✅ [RouteImport] Matched ${file.name} to ${matchedDriver.user_name} after reload`);
              newFileDriverMap[file.name] = {
                extractedName: driverName,
                driver: matchedDriver
              };
            } else {
              stillUnmatched++;
            }
          }
          
          setProgressPercent(100);
          
          if (stillUnmatched === 0) {
            setProgressMessage(`✅ All drivers matched after reloading AppUser data!`);
            setTimeout(() => {
              setShowProgress(false);
            }, 1500);
          } else {
            setProgressMessage(`⚠️ ${stillUnmatched} drivers still not found after reload`);
            setTimeout(() => {
              setShowProgress(false);
            }, 2000);
          }
          
        } catch (reloadError) {
          console.error('❌ [RouteImport] Failed to reload AppUser data:', reloadError);
          setProgressMessage(`❌ Failed to reload driver data: ${reloadError.message}`);
          setTimeout(() => {
            setShowProgress(false);
          }, 3000);
        }
      }
      
      // Batch state updates to prevent multiple re-renders
      setFiles(selectedFiles);
      setFileDriverMap(newFileDriverMap);
      setShowDriverMatching(true);
      
      console.log('[RouteImport] Files processed successfully');
      
    } catch (error) {
      console.error('[RouteImport] File selection error:', error);
      
      // Clear file input on error
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      
      setImportError({
        message: `File selection error: ${error.message}`,
        record: { phase: 'file-selection' },
        lineNumber: null,
        phase: 'file-selection'
      });
    }
  };

  const removeFile = (indexToRemove) => {
    setFiles(files.filter((_, index) => index !== indexToRemove));
  };

  const processCSVData = useCallback(async (csvText, fileName, selectedDriver, allDeliveriesData, patientsData, storesData, skipMatching = false) => {

    if (!csvText || !fileName || !selectedDriver || !patientsData || !storesData || !currentUser) {
      return { deliveriesToCreate: [], deliveriesToUpdate: [], skippedItems: [], errors: [] };
    }

    const statusMap = {
      'Completed': 'completed',
      'In Transit': 'in_transit',
      'Ready For Pickup': 'Ready For Pickup',
      'Pending': 'pending',
      'Picked Up': 'picked_up',
      'Failed': 'failed',
      'Cancelled': 'cancelled'
    };

    const deliveriesToCreate = [];
    const deliveriesToUpdate = [];
    const skippedItems = [];
    const errors = [];
    const lines = csvText.split(/\r?\n/).filter((line) => line.trim());

    let currentDate = null;
    let expectedDeliveries = 0;
    let lineNumber = 0;
    
    // CRITICAL: First pass - find highest stop_order in import to continue numbering from there
    let maxStopOrder = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      const dateMetaMatch = line.match(/^#(\d{4}-\d{2}-\d{2})#,(\d+),/);
      if (dateMetaMatch) continue;
      
      const values = parseCSVLine(line);
      if (values.length < 17) continue;
      
      const stopOrder = parseInt(values[3]?.trim()) || 0;
      if (stopOrder > maxStopOrder) {
        maxStopOrder = stopOrder;
      }
    }
    
    let inTransitStopCounter = maxStopOrder; // Start from highest imported stop_order

    const patientsByPID = new Map();
    let patientsWithoutPID = 0;
    patientsData.forEach((patient) => {
      if (patient.patient_id) {
        const pid = patient.patient_id.trim();
        if (pid) {
          patientsByPID.set(pid, patient);
        }
      } else {
        patientsWithoutPID++;
      }
    });

    const existingDeliveryIds = new Set(allDeliveriesData.map((d) => d.delivery_id).filter(Boolean));
    const matchedExistingDeliveryIds = new Set(); // Track which existing deliveries we've already matched in THIS import

    // CRITICAL: Pre-process to identify duplicate PIDs in THIS import
    const pidCountInImport = new Map(); // PID -> count of how many stops being imported for this PID
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      const dateMetaMatch = line.match(/^#(\d{4}-\d{2}-\d{2})#,(\d+),/);
      if (dateMetaMatch) continue; // Skip date metadata
      
      const values = parseCSVLine(line);
      if (values.length < 15) continue; // Skip invalid lines
      
      const patientPID = values[14]?.replace(/"/g, '').trim();
      if (patientPID) {
        pidCountInImport.set(patientPID, (pidCountInImport.get(patientPID) || 0) + 1);
      }
    }


    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      lineNumber = i + 1;

      if (lineNumber % 10 === 0) {
        const percent = Math.round(lineNumber / lines.length * 50);
        setProgressPercent(percent);
        setProgressMessage(`Parsing file: ${fileName} (Line ${lineNumber} / ${lines.length})...`);
      }

      if (!line.trim()) {
        continue;
      }

      const dateMetaMatch = line.match(/^#(\d{4}-\d{2}-\d{2})#,(\d+),/);
      if (dateMetaMatch) {
        currentDate = dateMetaMatch[1];
        expectedDeliveries = parseInt(dateMetaMatch[2], 10);
        continue;
      }

      const values = parseCSVLine(line);

      if (!currentDate) {

        skippedItems.push({
          lineNumber,
          reason: 'No delivery date set',
          rawData: values.slice(0, Math.min(values.length, 5)).join(', ') + (values.length > 5 ? '...' : '')
        });
        continue;
      }

      if (values.length < 17) {

        skippedItems.push({
          lineNumber,
          reason: `Insufficient fields (${values.length}/17)`,
          rawData: values.join(', ')
        });
        continue;
      }

      const storeAbbr = values[0]?.replace(/"/g, '').trim();
      const ampmRawValue = values[1]?.replace(/"/g, '').trim();
      const trackingNumber = values[2]?.replace(/"/g, '').trim();
      const stopOrder = parseInt(values[3]?.trim()) || 0;
      const column5Value = parseFloat(values[4]?.trim()); // Column 5 - check if < 0 for pending status
      const col6Value = values[5]?.replace(/"/g, '').trim(); // Column 6: delivery_time_start/actual_delivery_time/delivery_time_eta
      const col7Value = values[6]?.replace(/"/g, '').trim(); // Column 7: delivery_time_end
      const paidKmOverrideStr = values[7]?.replace(/"/g, '').trim(); // Column 8 (index 7): paid_km_override
      const paidKmOverride = paidKmOverrideStr && !isNaN(parseFloat(paidKmOverrideStr)) ? parseFloat(parseFloat(paidKmOverrideStr).toFixed(2)) : null;
      const travelDistStr = values[8]?.replace(/"/g, '').trim(); // Column 9 (index 8): travel_dist
      const travelDist = travelDistStr && !isNaN(parseFloat(travelDistStr)) ? parseFloat(parseFloat(travelDistStr).toFixed(2)) : null;
      // Column 10 (index 9) is IGNORED - COD extracted from notes instead
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

      // CRITICAL: Pass storesData directly to avoid stale closure issues
      const store = findStoreByAbbreviation(storeAbbr, storesData);
      if (!store) {
        skippedItems.push({
          lineNumber,
          reason: `Store not found: "${storeAbbr}"`,
          rawData: `${storeAbbr}, ${ampmRawValue}, ${trackingNumber}, ${stopId}, ${patientPID}`
        });

        continue;
      }

      const isPickup = !patientPID || patientPID === '' || rawNotes.toLowerCase().includes('pick up');

      let patient = null;
      let patientId = null;

      if (!isPickup) {
        patient = patientsByPID.get(patientPID);

        if (!patient) {

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

      if (!dispatcherId) {

      }

      // CRITICAL: Determine status based on Column 4 and 5 values
      // If both Col 4 and 5 are 0: pickups=en_route, deliveries=in_transit
      // If Col 4 > 0: completed
      // If Col 5 < 0: pending
      let statusFromColumns;
      if (!isNaN(column5Value) && column5Value < 0) {
        statusFromColumns = 'pending';
      } else if (!isNaN(stopOrder) && stopOrder > 0) {
        statusFromColumns = 'completed';
      } else {
        // Both Col 4 and 5 are 0 - pickups en_route, deliveries in_transit
        statusFromColumns = isPickup ? 'en_route' : 'in_transit';
      }

      // CRITICAL: For in_transit/en_route stops with stopOrder === 0, assign sequential order based on import position
      let finalStopOrder = stopOrder;
      if (stopOrder === 0 && (statusFromColumns === 'in_transit' || statusFromColumns === 'en_route')) {
        inTransitStopCounter++;
        finalStopOrder = inTransitStopCounter;

      }

      // CRITICAL: COD amount extracted from notes, NOT from column 10 (which is ignored)
      // processDeliveryNotes will handle COD extraction

      const newDeliveryData = {
        delivery_date: currentDate,
        store_id: store.id,
        dispatcher_id: dispatcherId || null,
        driver_id: selectedDriver.id,
        driver_name: selectedDriver.user_name || selectedDriver.full_name,
        tracking_number: trackingNumber,
        stop_order: finalStopOrder, // CRITICAL: Use sequential order for in_transit/en_route, else preserve imported
        stop_id: stopId || null,
        status: statusFromColumns,
        extra_time: 0,
        ampm_deliveries: ampmValue,
        paid_km_override: (paidKmOverride && paidKmOverride > (selectedDriver.extra_km_limit || 0)) ? paidKmOverride : null, // Only set if > extra_km_limit
        travel_dist: travelDist, // Column 9 - imported directly
        cod_total_amount_required: 0, // CRITICAL: Set to 0 - processDeliveryNotes will extract from notes
        cod_payments: [],
        cod_payment_type: 'No Payment',
        cod_amount: '',
        signature_needed: false,
        fridge_item: false,
        oversized: false,
        after_hours_pickup: false,
        delivery_notes: rawNotes,
        first_delivery: false,
        puid: importedPuid || null // Use imported PUID from column 13
      };
      


      // CRITICAL: Use the imported AMPM value (column 2) to determine the correct time slot
      // Column 2: 1 = AM, 2 = PM
      // This MUST be set BEFORE assigning PUID to ensure correct pickup linkage
      const assignedAMPM = ampmValue || determineDeliveryAMPM(newDeliveryData, allDeliveriesData);
      newDeliveryData.ampm_deliveries = assignedAMPM;
      

      
      // CRITICAL: Verify store has matching time slot configured
      const dateObj = new Date(currentDate + 'T00:00:00');
      const dayOfWeek = dateObj.getDay();
      const isSaturday = dayOfWeek === 6;
      const isSunday = dayOfWeek === 0;
      
      const timeSlotPrefix = isSaturday 
        ? (assignedAMPM === 'AM' ? 'saturday_am' : 'saturday_pm')
        : isSunday 
        ? (assignedAMPM === 'AM' ? 'sunday_am' : 'sunday_pm')
        : (assignedAMPM === 'AM' ? 'weekday_am' : 'weekday_pm');
      
      const slotEnabled = store[`${timeSlotPrefix}_enabled`];
      if (!slotEnabled) {

      }

      // PUID assignment will be done after all rows are parsed (see below)

      // CRITICAL: Column 6 & 7 parsing for time fields
      // - For completed/failed/cancelled (stopOrder > 0): Col 6 = actual_delivery_time
      // - For incomplete (stopOrder === 0): Col 6 = delivery_time_start AND delivery_time_eta, Col 7 = delivery_time_end
      const timeRegex = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
      
      if (stopOrder > 0) {
        // Completed/Failed/Cancelled: Col 6 = actual_delivery_time
        if (col6Value && timeRegex.test(col6Value)) {
          newDeliveryData.actual_delivery_time = `${currentDate}T${col6Value}:00`;
        }
      } else {
        // Incomplete stops: Col 6 = delivery_time_start AND delivery_time_eta, Col 7 = delivery_time_end
        if (col6Value && timeRegex.test(col6Value)) {
          newDeliveryData.delivery_time_start = col6Value;
          newDeliveryData.delivery_time_eta = col6Value;
        } else if (!col6Value && patient && patient.time_window_start) {
          // CRITICAL: If patient has delivery start time window, use it
          newDeliveryData.delivery_time_start = patient.time_window_start;
          newDeliveryData.delivery_time_eta = patient.time_window_start;
        } else if (!col6Value) {
          // No CSV time and no patient window - use store start time + 5 min
          const timeSlotPrefix = isSaturday 
            ? (assignedAMPM === 'AM' ? 'saturday_am' : 'saturday_pm')
            : isSunday 
            ? (assignedAMPM === 'AM' ? 'sunday_am' : 'sunday_pm')
            : (assignedAMPM === 'AM' ? 'weekday_am' : 'weekday_pm');

          const storeStartTimeKey = `${timeSlotPrefix}_start`;
          const storeStartTime = store[storeStartTimeKey];
          if (storeStartTime && timeRegex.test(storeStartTime)) {
            // Add 5 minutes to store start time
            const [hours, mins] = storeStartTime.split(':').map(Number);
            const newMins = (mins + 5) % 60;
            const newHours = hours + (mins + 5 >= 60 ? 1 : 0);
            const startTimeWith5Min = `${String(newHours).padStart(2, '0')}:${String(newMins).padStart(2, '0')}`;
            newDeliveryData.delivery_time_start = startTimeWith5Min;
            newDeliveryData.delivery_time_eta = startTimeWith5Min;
          }
        }

        // Set delivery_time_end from Col 7 or patient's time_window_end
        if (col7Value && timeRegex.test(col7Value)) {
          newDeliveryData.delivery_time_end = col7Value;
        } else if (!col7Value && patient && patient.time_window_end) {
          // If no Col 7 time, use patient's delivery end time window
          newDeliveryData.delivery_time_end = patient.time_window_end;
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

      // CRITICAL: For pickups with 'failed' in notes, set status to 'cancelled'
      const notesLower = rawNotes.toLowerCase();
      if (isPickup && notesLower.includes('failed')) {
        newDeliveryData.status = statusMap['Cancelled'];
      } else if (notesLower.includes('failed')) {
        newDeliveryData.status = statusMap['Failed'];
      } else if (notesLower.includes('cancel')) {
        newDeliveryData.status = statusMap['Cancelled'];
      }
      
      // CRITICAL: Check if RAW notes indicate this is a first delivery BEFORE cleaning
      const notesLowerForFirstDelivery = rawNotes.toLowerCase();
      const isFirstDeliveryInNotes = notesLowerForFirstDelivery.includes('first delivery') || 
                                     notesLowerForFirstDelivery.includes('1st delivery') ||
                                     notesLowerForFirstDelivery.includes('first del');
      
      // CRITICAL: If notes say "First Delivery", always set the flag to true
      // The notes are authoritative for historical data
      if (isFirstDeliveryInNotes) {
        newDeliveryData.first_delivery = true;
      }

      // CRITICAL: Use shared notes processor for consistency (AFTER checking for first delivery flag)
      // This will extract COD amount from notes and set cod_total_amount_required
      // Pass correct isCompleted flag based on status
      const isCompletedForNotes = statusFromColumns === 'completed';
      const cleanedNotes = processDeliveryNotes(rawNotes, newDeliveryData, patient, isPickup, isCompletedForNotes);
      newDeliveryData.delivery_notes = cleanedNotes;

      // CRITICAL: If skipMatching is true (full purge), treat everything as create
      // This ensures ALL CSV data is imported after purge, not just new/changed items
      let existingDelivery = null;
      let matchReason = skipMatching ? 'FULL_PURGE_IMPORT' : 'Unknown';

      if (!skipMatching) {
       // CRITICAL: If this PID has duplicates in the import, ONLY match by exact SID
       // This prevents stop 13 from overwriting stop 10's data
       const pidHasDuplicatesInImport = patientPID && pidCountInImport.get(patientPID) > 1;

       // CRITICAL: Always use selectedDriver.id to ensure consistent driver assignment
       // This prevents creating deliveries with incorrect/duplicate driver_id values
       const matchResult = pidHasDuplicatesInImport && stopId
         ? { match: allDeliveriesData.find(d => d.stop_id === stopId && d.delivery_date === currentDate && d.driver_id === selectedDriver.id), reason: 'SID Match (PID has duplicates)' }
         : matchDeliveryToExisting(newDeliveryData, allDeliveriesData, patientsData);

       existingDelivery = matchResult?.match || null;
       matchReason = matchResult?.reason || 'Unknown';

       // CRITICAL: If we already matched this existing delivery in this import pass, don't match it again
       // This prevents duplicate imports from overwriting each other
       if (existingDelivery && matchedExistingDeliveryIds.has(existingDelivery.id)) {
         existingDelivery = null;
       }
      }

      // CRITICAL: Import travel_dist ONLY if existing is 0
      if (existingDelivery) {
        const changes = detectChanges(existingDelivery, newDeliveryData);

        // CRITICAL: Always add to updates list, even if no changes
        // This ensures ALL CSV data gets imported after purge
        const updatedDeliveryData = {
          ...existingDelivery,
          ...newDeliveryData,
          id: existingDelivery.id
        };

        // CRITICAL: Import travel_dist only if existing is 0 AND stop is finished
        const finishedStatuses = ['completed', 'failed', 'cancelled'];
        if (finishedStatuses.includes(existingDelivery.status) && 
            (existingDelivery.travel_dist === 0 || existingDelivery.travel_dist === null) && 
            travelDist !== null) {
          updatedDeliveryData.travel_dist = travelDist;
        } else {
          // Preserve existing travel_dist
          updatedDeliveryData.travel_dist = existingDelivery.travel_dist;
        }

        // CRITICAL: Don't unset first_delivery for past deliveries with future last_delivery_date
        // Only preserve if flag is ALREADY true - don't prevent setting it to true from notes
        if (patient && patient.last_delivery_date && existingDelivery.first_delivery === true) {
          const importDeliveryDate = new Date(currentDate);
          const patientLastDeliveryDate = new Date(patient.last_delivery_date);

          if (patientLastDeliveryDate > importDeliveryDate && newDeliveryData.first_delivery === false) {
            // Past delivery, patient has future delivery, and import would unset flag - preserve existing true
            updatedDeliveryData.first_delivery = true;
          }
        }

        // CRITICAL: For incomplete stops (pending, in_transit, en_route), preserve COD payment fields AND set amount to 0
        // For completed stops, only set COD amount if not already collected
        const incompleteStatuses = ['pending', 'in_transit', 'en_route'];
        if (incompleteStatuses.includes(updatedDeliveryData.status)) {
          // Incomplete stops: preserve existing COD fields and force amount to 0
          updatedDeliveryData.cod_payment_type = existingDelivery.cod_payment_type;
          updatedDeliveryData.cod_payments = existingDelivery.cod_payments;
          updatedDeliveryData.cod_total_amount_required = 0; // Force to 0 for incomplete

        } else if (updatedDeliveryData.status === 'completed') {
          // Completed stops: only update COD amount if not already collected
          const hasPaymentRecorded = existingDelivery.cod_payments && existingDelivery.cod_payments.length > 0;
          const hasPaymentTypeSet = existingDelivery.cod_payment_type && existingDelivery.cod_payment_type !== 'No Payment';

          if (hasPaymentRecorded || hasPaymentTypeSet) {
            // Already collected - preserve existing COD data
            updatedDeliveryData.cod_total_amount_required = existingDelivery.cod_total_amount_required;
            updatedDeliveryData.cod_payment_type = existingDelivery.cod_payment_type;
            updatedDeliveryData.cod_payments = existingDelivery.cod_payments;

          }
          // Otherwise, use imported COD amount (already set in newDeliveryData)
        }

        deliveriesToUpdate.push({
          ...updatedDeliveryData,
          _changes: changes.length > 0 ? changes : ['No changes - re-importing'],
          _matchReason: matchReason
        });
        matchedExistingDeliveryIds.add(existingDelivery.id); // Mark this existing delivery as matched
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

    // PUID Update Pass: Now that all rows are parsed, assign PUIDs if not already imported
    // CRITICAL: PUIDs are now imported from column 13 - only assign if not already set
    const allParsedDeliveries = [...deliveriesToCreate, ...deliveriesToUpdate];
    const pickupMap = new Map();

    // Build a map of pickups for fallback PUID assignment
    allParsedDeliveries.forEach((d) => {
      if (!d.patient_id && d.store_id && d.stop_id) {
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries || 'none'}`;
        if (!pickupMap.has(key)) {
          pickupMap.set(key, d.stop_id);
        }
      }
    });

    // Assign PUIDs only if not already imported from CSV
    allParsedDeliveries.forEach((d) => {
      // If PUID was imported from column 13, keep it
      if (d.puid) {

      } else if (!d.patient_id && d.stop_id) {
        // Pickup without imported PUID: PUID = own stop_id
        d.puid = d.stop_id;
      } else if (d.patient_id) {
        // Patient delivery without imported PUID: find matching pickup
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries || 'none'}`;
        const matchingPuid = pickupMap.get(key);
        if (matchingPuid) {
          d.puid = matchingPuid;
        }
      }
    });

    const totalToCreate = deliveriesToCreate.length;
    const totalToUpdate = deliveriesToUpdate.length;
    const totalForThisFile = totalToCreate + totalToUpdate;

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
        // CRITICAL: Try offline DB first to avoid rate limits
        let freshAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        
        // Only fetch from API if offline DB is empty
        if (!freshAppUsers || freshAppUsers.length === 0) {
          console.log('📥 [RouteImport] Fetching AppUsers from API (offline DB empty)');
          freshAppUsers = await base44.entities.AppUser.list();
          // Save to offline DB for next time
          if (freshAppUsers && freshAppUsers.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
          }
        } else {
          console.log(`✅ [RouteImport] Loaded ${freshAppUsers.length} AppUsers from offline DB`);
        }

        
        // CRITICAL: Only admins can list User entities
        const isAdmin = userHasRole(currentUser, 'admin');
        
        if (isAdmin) {
          const allAuthUsers = await base44.entities.User.list();

          // Merge AppUsers with Auth Users
          const mergedUsers = allAuthUsers.map((authUser) => {
            const appUser = freshAppUsers.find((au) => au.user_id === authUser.id);
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
        } else {
          // Non-admins: Create pseudo-users from AppUser data
          const pseudoUsers = freshAppUsers.map((au) => ({
            id: au.user_id,
            user_id: au.user_id,
            user_name: au.user_name,
            full_name: au.user_name,
            app_roles: au.app_roles || [],
            status: au.status
          }));
          

          setAllDriverUsers(pseudoUsers);
        }
      } catch (error) {

        // Fallback to prop allUsers
        setAllDriverUsers(allUsers || []);
      }
    };

    loadAllDrivers();
  }, []); // CRITICAL: Empty dependency array to run only once on mount

  // CRITICAL: Auto-open file dialog on mount (same as PatientImport)
  useEffect(() => {
    setTimeout(() => {
      if (fileInputRef.current) {
        fileInputRef.current.click();
      }
    }, 100);
  }, []);

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
    // CRITICAL: Exclude line 1 skipped items from display
    const skipped = previewData.skippedItems
      .filter((item) => item.lineNumber !== 1)
      .map((item) => ({ 
        action: 'skipped', 
        reason: item.reason,
        lineNumber: item.lineNumber,
        rawData: item.rawData,
        patient_name: item.rawData || 'Unknown',
        status: 'skipped'
      }));
    return [...created, ...updated, ...skipped];
  }, [previewData.deliveriesToCreate, previewData.deliveriesToUpdate, previewData.skippedItems]);

  const previewDrivers = useMemo(() => {
    const driverNames = new Set(allPreviewDeliveries.map((d) => d.driver_name));
    return Array.from(driverNames).sort();
  }, [allPreviewDeliveries]);

  const previewDates = useMemo(() => {
    const dates = new Set(allPreviewDeliveries.map((d) => d.delivery_date));
    return Array.from(dates).sort();
  }, [allPreviewDeliveries]);

  const filteredPreviewDeliveries = useMemo(() => {
    const filtered = allPreviewDeliveries.filter((delivery) => {
      const dateMatch = previewFilterDate === 'all' || delivery.delivery_date === previewFilterDate;
      return dateMatch;
    });
    
    // Sort: no changes to bottom
    return filtered.sort((a, b) => {
      const aNoChange = a._changes?.[0] === 'No changes - re-importing';
      const bNoChange = b._changes?.[0] === 'No changes - re-importing';
      if (aNoChange && !bNoChange) return 1;
      if (!aNoChange && bNoChange) return -1;
      return 0;
    });
  }, [allPreviewDeliveries, previewFilterDate]);

  const previewStats = useMemo(() => {
    const creates = filteredPreviewDeliveries.filter((d) => d.action === 'create').length;
    const updates = filteredPreviewDeliveries.filter((d) => d.action === 'update').length;

    const failed = filteredPreviewDeliveries.filter((d) => d.status === 'failed').length;

    const returned = filteredPreviewDeliveries.filter((d) => {
      const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = (d.delivery_address || '').toLowerCase().includes('rtn');
      const patientNameReturn = (d.patient_name || '').toLowerCase().includes('return');
      // CRITICAL: Return is identified by markers in notes/patient name, NOT by status
      return notesReturn || addressReturn || patientNameReturn;
    }).length;

    // CRITICAL: Completed = ONLY deliveries with status === 'completed'
    const completed = filteredPreviewDeliveries.filter((d) => d.status === 'completed').length;

    // CRITICAL: Exclude line 1 skipped items from display
    const skippedItemsToShow = previewData.skippedItems.filter((item) => item.lineNumber !== 1);

    return { creates, updates, completed, failed, returned, skipped: skippedItemsToShow.length };
  }, [filteredPreviewDeliveries, previewData.skippedItems]);


  // Helper function to extract dates from CSV files without full parsing
  const extractDateRangeFromFiles = async (filesToParse) => {
    const dates = new Set();
    
    for (const file of filesToParse) {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      
      for (const line of lines) {
        // Look for date metadata lines: #YYYY-MM-DD#,TotalDeliveries,...
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

  const handlePreview = async (filesToUse = null, driverMapToUse = null) => {
    // Use provided params or fall back to state
    const activeFiles = filesToUse || files;
    const activeDriverMap = driverMapToUse || fileDriverMap;
    
    if (activeFiles.length === 0) {
      alert('Please select at least one CSV file');
      return;
    }
    
    // Validate all files have matched drivers
    const unmatchedFiles = activeFiles.filter(f => !activeDriverMap[f.name]?.driver);
    if (unmatchedFiles.length > 0) {
      alert(`Could not match driver for files:\n${unmatchedFiles.map(f => `- ${f.name} (extracted: "${activeDriverMap[f.name]?.extractedName}")`).join('\n')}\n\nPlease ensure filenames match driver names (e.g., "John Smith Route.csv")`);
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
      // STEP 0: Refresh driver data FIRST to ensure accurate driver_id matching
      setProgressMessage('Refreshing driver data...');
      setProgressPercent(3);
      
      try {
        // CRITICAL: Try offline DB first to avoid rate limits
        let freshAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        
        if (!freshAppUsers || freshAppUsers.length === 0) {
          console.log('📥 [RouteImport Preview] Fetching AppUsers from API (offline DB empty)');
          freshAppUsers = await base44.entities.AppUser.list();
          if (freshAppUsers && freshAppUsers.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
          }
        }

        
        const isAdmin = userHasRole(currentUser, 'admin');
        
        if (isAdmin) {
          const allAuthUsers = await base44.entities.User.list();
          const mergedUsers = allAuthUsers.map((authUser) => {
            const appUser = freshAppUsers.find((au) => au.user_id === authUser.id);
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
        } else {
          const pseudoUsers = freshAppUsers.map((au) => ({
            id: au.user_id,
            user_id: au.user_id,
            user_name: au.user_name,
            full_name: au.user_name,
            app_roles: au.app_roles || [],
            status: au.status
          }));
          setAllDriverUsers(pseudoUsers);
        }
        

      } catch (driverError) {

        // Continue with existing data
      }

      // STEP 1: Extract date range from import files
      setProgressMessage('Analyzing import files for date range...');
      setProgressPercent(5);
      
      const { minDate, maxDate } = await extractDateRangeFromFiles(activeFiles);

       if (!minDate || !maxDate) {
         alert('Could not detect any dates in the import files. Please ensure files contain date metadata lines (e.g., #2024-01-15#,...)');
         setIsParsing(false);
         setShowProgress(false);
         return;
       }

       setProgressMessage(`Date range: ${minDate} to ${maxDate}`);

       // CRITICAL: Clear cached delivery data for this date range to prevent stale matches
       try {
         const { invalidateDeliveryRange } = await import('../utils/dataManager');
         invalidateDeliveryRange(minDate, maxDate);
         console.log(`🗑️ [RouteImport] Cleared cache for deliveries ${minDate} to ${maxDate}`);
       } catch (e) {
         console.warn('⚠️ [RouteImport] Failed to clear delivery cache:', e.message);
       }

       setProgressPercent(10);

      setProgressMessage('Loading store data from cache...');
      // CRITICAL: Use getData instead of direct API call - respects rate limiting
      const freshStoresAll = await getData('Store', '-created_date', null, false);
      freshStoresRef.current = freshStoresAll || [];
      setAllStores(freshStoresAll || []);
      setProgressPercent(15);

      setProgressMessage('Extracting patient IDs from import files...');
       // Extract unique PIDs from import files
       const uniquePids = new Set();
       for (const file of activeFiles) {
         const text = await file.text();
         const lines = text.split(/\r?\n/).filter((line) => line.trim());
         for (const line of lines) {
           const values = parseCSVLine(line);
           const patientPID = values[14]?.replace(/"/g, '').trim();
           if (patientPID) {
             uniquePids.add(patientPID);
           }
         }
       }
       const pidArray = Array.from(uniquePids);
       setProgressPercent(18);

       setProgressMessage('Loading patient data from cache...');
       // CRITICAL: Use getData instead of direct API call - respects rate limiting
       let freshPatients = await getData('Patient', '-created_date', null, false);
       setPatients(freshPatients);
       setProgressPercent(20);

       // If cache is incomplete, fetch only the required patients from API
       const cachedPids = new Set(freshPatients?.map(p => p.patient_id).filter(Boolean) || []);
       const missingPids = pidArray.filter(pid => !cachedPids.has(pid));

       if (missingPids.length > 0) {
       setProgressMessage(`Fetching ${missingPids.length} missing patients from API...`);
       try {
       const missingPatients = await base44.entities.Patient.filter({
         patient_id: { $in: missingPids }
       });
       if (missingPatients && missingPatients.length > 0) {
         freshPatients = [...(freshPatients || []), ...missingPatients];
         setPatients(freshPatients);
         // Sync new patients to offline DB
         await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, missingPatients);
         console.log(`✅ [RouteImport] Fetched and synced ${missingPatients.length} missing patients`);
       }
       } catch (patientError) {
       console.warn('⚠️ [RouteImport] Failed to fetch missing patients:', patientError);
       }
       }

       // CRITICAL: Pre-index patients by patient_id for O(1) lookup
       if (!freshPatients || freshPatients.length === 0) {
       console.warn('⚠️ [RouteImport] No patient data available for import');
       }

       if (!freshPatients || freshPatients.length === 0) {
         console.warn('⚠️ [RouteImport] No patient data available for import');
         // Don't block import - some routes may be pickups without patients
         freshPatients = [];
       } else {
         console.log(`✅ [RouteImport] Loaded ${freshPatients.length} patients for matching`);
       }

      // STEP 2: Fetch fresh deliveries for ALL drivers in the import and date range
      setProgressMessage(`Refreshing delivery cache for all drivers (${minDate} to ${maxDate})...`);
      setProgressPercent(25);

      // Get all unique driver IDs from the file mapping
      const allDriverIds = [...new Set(activeFiles.map(f => activeDriverMap[f.name]?.driver?.id).filter(Boolean))];
      
      // CRITICAL: Clear offline DB for these drivers+dates FIRST to prevent stale data
      try {
        const { offlineDB } = await import('../utils/offlineDatabase');
        for (const driverId of allDriverIds) {
          // Get all deliveries in date range from offline DB
          const allOfflineInRange = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
          const toDelete = allOfflineInRange.filter(d => 
            d.driver_id === driverId && 
            d.delivery_date >= minDate && 
            d.delivery_date <= maxDate
          );
          
          for (const d of toDelete) {
            await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id);
          }
          console.log(`🗑️ [RouteImport] Cleared ${toDelete.length} offline deliveries for driver ${driverId} in date range`);
        }
      } catch (offlineError) {
        console.warn('⚠️ [RouteImport] Failed to clear offline DB:', offlineError);
      }
      
      // CRITICAL: Fetch fresh deliveries from BACKEND for accurate matching during preview
      // We MUST have current data to prevent duplicate creation on re-imports
      // API calls during preview are necessary to prevent creating duplicates
      let freshDeliveries = [];
      try {
        const backendDeliveries = await base44.entities.Delivery.filter({
          driver_id: { $in: allDriverIds },
          delivery_date: { $gte: minDate, $lte: maxDate }
        });
        freshDeliveries = backendDeliveries || [];
        console.log(`✅ [RouteImport] Loaded ${freshDeliveries.length} deliveries from backend for validation`);

        // Sync to offline DB for future use
        if (freshDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        }
      } catch (fetchError) {
        console.warn('⚠️ [RouteImport] Failed to fetch from backend, falling back to offline DB:', fetchError.message);
        freshDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        freshDeliveries = freshDeliveries.filter(d => 
          allDriverIds.includes(d.driver_id) &&
          d.delivery_date >= minDate &&
          d.delivery_date <= maxDate
        );
      }
      setProgressPercent(35);



      let totalToCreate = [];
      let totalToUpdate = [];
      let totalSkippedItems = [];
      let totalErrors = [];

      for (let i = 0; i < activeFiles.length; i++) {
        const file = activeFiles[i];
        const fileDriver = activeDriverMap[file.name]?.driver;
        
        if (!fileDriver) {

          continue;
        }
        
        setProgressMessage(`Processing file ${i + 1} of ${activeFiles.length}: ${file.name} (${fileDriver.user_name || fileDriver.full_name})...`);

        const text = await file.text();
        // Filter deliveries for this specific driver
        const driverDeliveries = freshDeliveries.filter(d => d.driver_id === fileDriver.id);
        
        // CRITICAL: Pass freshStoresAll directly to processCSVData to avoid stale closure
        // skipMatching=false for preview - show users what's changing vs new
        const result = await processCSVData(text, file.name, fileDriver, driverDeliveries, freshPatients, freshStoresAll, false);

        totalToCreate = [...totalToCreate, ...result.deliveriesToCreate];
        totalToUpdate = [...totalToUpdate, ...result.deliveriesToUpdate];
        totalSkippedItems = [...totalSkippedItems, ...result.skippedItems];
        totalErrors = [...totalErrors, ...result.errors];

        const currentParsingProgress = Math.round((i + 1) / activeFiles.length * 45);
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

      setImportError({
        message: error.message,
        record: {
          files: files.map((f) => `${f.name} (${fileDriverMap[f.name]?.extractedName || 'unknown'})`).join(', ')
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
      total: previewData.deliveriesToCreate.length + previewData.deliveriesToUpdate.length,
      completed: 0,
      failed: 0,
      returned: 0,
      errors: [...previewData.errors],
      fileResults: []
    };

    const failedCreations = [];
    const failedUpdates = [];

    try {
      // CRITICAL: Pause ALL sync processes before import

      smartRefreshManager.pause();
      driverLocationPoller.pause();
      

      
      const { offlineDB } = await import('../utils/offlineDatabase');

      // STEP 1: Load AppUser data (offline first)
      setProgressMessage('Loading AppUser data...');
      setProgressPercent(5);
      let freshAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      if (!freshAppUsers || freshAppUsers.length === 0) {
        console.log('📥 [RouteImport Confirm] Fetching AppUsers from API (offline DB empty)');
        freshAppUsers = await base44.entities.AppUser.list();
        if (freshAppUsers && freshAppUsers.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
        }
      }

      setProgressPercent(8);

      // STEP 2: CRITICAL - Use ALL preview deliveries (creates + updates) as CREATES via bulkCreate
      // Since we purge everything first, ALL CSV data becomes fresh creates
      // This prevents duplicates and ensures CSV is the sole source of truth
      console.log(`📦 [RouteImport Confirm] Starting import with ${previewData.deliveriesToCreate.length} creates + ${previewData.deliveriesToUpdate.length} updates`);

      const allDeliveriesToImport = [...previewData.deliveriesToCreate, ...previewData.deliveriesToUpdate];

      if (!allDeliveriesToImport || allDeliveriesToImport.length === 0) {
        console.error('❌ [RouteImport Confirm] ERROR: No deliveries to import!');
        throw new Error('No deliveries found in preview data to import');
      }

      const deliveriesToCreateFiltered = allDeliveriesToImport.map(d => {
        const { id, _changes, action, _matchReason, ...cleanData } = d;
        return cleanData;
      });
      const deliveriesToUpdateFiltered = []; // No updates - full purge means everything is a create

      console.log(`📦 [RouteImport Confirm] Filtered to ${deliveriesToCreateFiltered.length} deliveries for creation`);

      // STEP 3: Get drivers being imported
      const importedDriverIds = [...new Set(
        [...deliveriesToCreateFiltered, ...deliveriesToUpdateFiltered]
          .map(d => d.driver_id)
          .filter(Boolean)
      )];
      const importedDates = [...new Set(
        [...deliveriesToCreateFiltered, ...deliveriesToUpdateFiltered]
          .map(d => d.delivery_date)
          .filter(Boolean)
      )];


      setProgressMessage('Loading latest patient and store data from cache...');
      setProgressPercent(10);
      const freshPatients = await getData('Patient', '-created_date', null, false);
      const freshStores = await getData('Store', '-created_date', null, false);
      setProgressPercent(12);

      // CRITICAL: ALWAYS PURGE - Collect all unique driver/date combinations being imported
      const affectedDriversAndDates = new Set();
      deliveriesToCreateFiltered.forEach(d => {
        affectedDriversAndDates.add(`${d.driver_id}|${d.delivery_date}`);
      });

      const driverDatePairs = Array.from(affectedDriversAndDates).map(pair => {
        const [driverId, date] = pair.split('|');
        return { driverId, date };
      });

      // CRITICAL: CONSERVATIVE PURGE - Interleave online/offline per date for natural cooldown
      // This prevents rate limiting by alternating between API and IndexedDB operations
      setProgressMessage(`Purging existing deliveries...`);

      // Get unique driver info from import data for name-based purging
      const driverNamesToDelete = new Set();
      [...deliveriesToCreateFiltered, ...deliveriesToUpdateFiltered].forEach(d => {
        if (d.driver_name) {
          driverNamesToDelete.add(d.driver_name.trim().toLowerCase());
        }
      });

      // Group driver/date pairs by date, then by driver
      const dateToDrivers = new Map();
      for (const { driverId, date } of driverDatePairs) {
        if (!dateToDrivers.has(date)) {
          dateToDrivers.set(date, new Set());
        }
        dateToDrivers.get(date).add(driverId);
      }

      // INTERLEAVED PURGE: For each date, delete online then offline (natural cooldown between)
      let totalOnlineDeleted = 0;
      let totalOfflineDeleted = 0;
      const sortedDates = Array.from(dateToDrivers.keys()).sort();

      for (const date of sortedDates) {
        const driverIds = dateToDrivers.get(date);

        // STEP 1a: Delete from ONLINE DB for this date, driver by driver
        for (const driverId of driverIds) {
          try {
            const toDelete = await base44.entities.Delivery.filter({
              driver_id: driverId,
              delivery_date: date
            });

            if (toDelete && toDelete.length > 0) {
              for (const delivery of toDelete) {
                await base44.entities.Delivery.delete(delivery.id);
              }
              totalOnlineDeleted += toDelete.length;
              console.log(`🗑️ [RouteImport] Deleted ${toDelete.length} online deliveries for driver ${driverId} on ${date}`);
            }
          } catch (deleteError) {
            console.error(`Failed to delete online deliveries for ${driverId}/${date}:`, deleteError);
            throw deleteError;
          }
        }

        // STEP 1b: Delete from OFFLINE DB for this date, all drivers
        try {
          const allOfflineForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, date);
          const toDeleteOffline = allOfflineForDate.filter(d => driverIds.has(d.driver_id));

          if (toDeleteOffline && toDeleteOffline.length > 0) {
            const BATCH_SIZE = 20;
            for (let i = 0; i < toDeleteOffline.length; i += BATCH_SIZE) {
              const batch = toDeleteOffline.slice(i, i + BATCH_SIZE);
              await Promise.all(batch.map(d => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id)));
            }
            totalOfflineDeleted += toDeleteOffline.length;
            console.log(`🗑️ [RouteImport] Deleted ${toDeleteOffline.length} offline deliveries on ${date}`);
          }
        } catch (offlineError) {
          console.warn(`⚠️ [RouteImport] Failed to delete offline for ${date}:`, offlineError);
        }
      }

      console.log(`✅ [RouteImport] Purge complete: ${totalOnlineDeleted} online + ${totalOfflineDeleted} offline`);
      setProgressPercent(15);

      batchUpdateAMPM(deliveriesToCreateFiltered);
      batchUpdateAMPM(deliveriesToUpdateFiltered);

      // BATCH CREATE - Organize by date, bulkCreate all drivers for each date with 1sec cooldown
      if (deliveriesToCreateFiltered.length > 0) {
        setImportProgress((prev) => ({
          ...prev,
          phase: 'creating',
          total: deliveriesToCreateFiltered.length,
          current: 0
        }));
        setProgressMessage(`Creating ${deliveriesToCreateFiltered.length} new deliveries...`);

        const cleanedDeliveries = deliveriesToCreateFiltered.map(cleanDeliveryData);

        // Group deliveries by date
        const deliveriesByDate = new Map();
        cleanedDeliveries.forEach(d => {
          if (!deliveriesByDate.has(d.delivery_date)) {
            deliveriesByDate.set(d.delivery_date, []);
          }
          deliveriesByDate.get(d.delivery_date).push(d);
        });

        console.log(`📦 [RouteImport] Creating ${cleanedDeliveries.length} deliveries across ${deliveriesByDate.size} dates`);

        let totalCreated = 0;
        const sortedCreateDates = Array.from(deliveriesByDate.keys()).sort();

        for (let dateIndex = 0; dateIndex < sortedCreateDates.length; dateIndex++) {
          const date = sortedCreateDates[dateIndex];
          const deliveriesForDate = deliveriesByDate.get(date);

          try {
            console.log(`📦 [RouteImport] Date ${dateIndex + 1}/${sortedDates.length} (${date}): Creating ${deliveriesForDate.length} deliveries`);
            setProgressMessage(`Creating deliveries for ${date} (${dateIndex + 1}/${sortedDates.length})...`);

            const createdDeliveries = await retryWithBackoff(async () => {
              return await base44.entities.Delivery.bulkCreate(deliveriesForDate);
            }, 5, 3000, 2);

            console.log(`✅ [RouteImport] Date ${date}: ${createdDeliveries.length} deliveries created`);

            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, createdDeliveries);

            createdDeliveries.forEach((createdDelivery) => {
              overallResults.created++;
              if (createdDelivery.status === 'completed') {
                overallResults.completed++;
              }
              if (createdDelivery.status === 'failed') {
                overallResults.failed++;
              }
              if (isReturnDelivery(createdDelivery, freshPatients, freshStores)) {
                overallResults.returned++;
              }
            });

            totalCreated += createdDeliveries.length;
            setImportProgress((prev) => ({
              ...prev,
              created: totalCreated,
              current: totalCreated
            }));

            // Cooldown between dates to prevent rate limiting
            if (dateIndex < sortedCreateDates.length - 1) {
              await delay(1000);
            }
          } catch (dateError) {
            console.error(`❌ [RouteImport] Date ${date} failed, falling back to individual creates:`, dateError.message);

            // Fallback: try each item individually for this date
            for (const cleanData of deliveriesForDate) {
              try {
                const createdDelivery = await retryWithBackoff(async () => {
                  return await base44.entities.Delivery.create(cleanData);
                }, 3, 2000, 2);

                await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [createdDelivery]);

                overallResults.created++;
                if (cleanData.status === 'completed') {
                  overallResults.completed++;
                }
                if (cleanData.status === 'failed') {
                  overallResults.failed++;
                }
                if (isReturnDelivery(cleanData, freshPatients, freshStores)) {
                  overallResults.returned++;
                }
                totalCreated++;
                setImportProgress((prev) => ({
                  ...prev,
                  created: totalCreated,
                  current: totalCreated
                }));
              } catch (individualError) {
                console.error(`❌ [RouteImport] Individual create failed:`, cleanData.delivery_id, individualError.message);
                failedCreations.push({ data: cleanData, error: individualError.message });
              }
            }

            // Cooldown after failed date
            if (dateIndex < sortedCreateDates.length - 1) {
              await delay(1000);
            }
          }
        }
      }

      // BATCH UPDATE - SKIPPED - all deliveries are now creates after purge
      // No update phase needed since we delete entire route before import

      // Retry failed operations - directly on backend
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

            // Retry on backend
            const createdDelivery = await retryWithBackoff(async () => {
              return await base44.entities.Delivery.create(cleanData);
            }, 3, 2000, 2);
            
            // Save to IndexedDB
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [createdDelivery]);
            
            overallResults.created++;
            if (cleanData.status === 'completed') {
              overallResults.completed++;
            }
            if (cleanData.status === 'failed') {
              overallResults.failed++;
            }
            if (isReturnDelivery(cleanData, freshPatients, freshStores)) {
              overallResults.returned++;
            }
            setImportProgress((prev) => ({
              ...prev,
              created: prev.created + 1,
              current: i + 1
            }));
          } catch (error) {

            overallResults.errors.push(`Failed to create ${cleanData.patient_name || 'Store Pickup'} (${cleanData.delivery_id || 'no ID'}): ${error.message}`);
            overallResults.failed++;
            setImportProgress((prev) => ({ ...prev, errors: prev.errors + 1, current: i + 1 }));
          }
        }

        const failedUpdateOffset = failedCreations.length;
        for (let i = 0; i < failedUpdates.length; i++) {
          const { data: deliveryData } = failedUpdates[i];
          const { id, _changes, action, _matchReason, ...updatePayload } = deliveryData;

          try {
            if (!id) {
              throw new Error('Missing delivery ID');
            }

            // Retry on backend
            const updatedDelivery = await retryWithBackoff(async () => {
              return await base44.entities.Delivery.update(id, cleanDeliveryData(updatePayload));
            }, 3, 2000, 2);
            
            // Save to IndexedDB
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updatedDelivery]);
            
            overallResults.updated++;
            if (updatePayload.status === 'completed') {
              overallResults.completed++;
            }
            if (updatePayload.status === 'failed') {
              overallResults.failed++;
            }
            if (isReturnDelivery(updatePayload, freshPatients, freshStores)) {
              overallResults.returned++;
            }
            setImportProgress((prev) => ({
              ...prev,
              updated: prev.updated + 1,
              current: failedUpdateOffset + i + 1
            }));
          } catch (error) {

            overallResults.errors.push(`Failed to update ${deliveryData.patient_name || 'Store Pickup'} (ID ${id}): ${error.message}`);
            overallResults.failed++;
            setImportProgress((prev) => ({ ...prev, errors: prev.errors + 1, current: failedUpdateOffset + i + 1 }));
          }
        }
      }

      setImportProgress((prev) => ({
        ...prev,
        phase: 'syncing',
        current: 0,
        total: 0,
        filesCompleted: prev.totalFiles,
        currentFile: ''
      }));
      
      // CRITICAL: Sync imported dates to offline DB - starting with active date
      const allImportedDates = [...new Set(driverDatePairs.map(p => p.date))].sort();
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const activeDateStr = globalFilters?.getSelectedDate?.() || todayStr;
      
      // CRITICAL: Prioritize active date FIRST
      const sortedSyncDates = allImportedDates.sort((a, b) => {
        if (a === activeDateStr) return -1;
        if (b === activeDateStr) return 1;
        if (a === todayStr) return -1;
        if (b === todayStr) return 1;
        return b.localeCompare(a); // Most recent first
      });
      

      setProgressMessage(`Syncing offline database (prioritizing active date)...`);
      
      // STEP 1: Group pairs by date for efficient processing
      const pairsByDate = new Map();
      driverDatePairs.forEach(({ driverId, date }) => {
        if (!pairsByDate.has(date)) {
          pairsByDate.set(date, []);
        }
        pairsByDate.get(date).push(driverId);
      });
      
      // STEP 2: Process dates in priority order (active date first)
      let syncedCount = 0;
      for (const date of sortedSyncDates) {
        const driverIds = pairsByDate.get(date);
        if (!driverIds || driverIds.length === 0) continue;
        
        try {
          // PURGE: Delete offline deliveries for all drivers on this date
          const existingOffline = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, date);
          const toDelete = existingOffline?.filter(d => driverIds.includes(d.driver_id)) || [];
          for (const d of toDelete) {
            await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id);
          }

          
          // RESYNC: Fetch fresh deliveries from online DB for all drivers on this date
          const freshDeliveries = await base44.entities.Delivery.filter({ 
            driver_id: { $in: driverIds },
            delivery_date: date 
          });
          
          // Save to offline DB
          if (freshDeliveries && freshDeliveries.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);

          }
          
          // Collect unique patient IDs from this date's deliveries
          const patientIds = [...new Set(freshDeliveries.map(d => d.patient_id).filter(Boolean))];
          if (patientIds.length > 0) {
            const patientsForDate = await base44.entities.Patient.filter({
              id: { $in: patientIds }
            });
            if (patientsForDate && patientsForDate.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patientsForDate);

            }
          }
          
          syncedCount += driverIds.length;
        } catch (syncError) {

        }
        
        setProgressMessage(`Syncing offline database (${syncedCount}/${driverDatePairs.length} completed)...`);
      }
      


      // STEP 4: Reset isNextDelivery flags and set first incomplete stop for each driver
      setProgressMessage('Updating next delivery markers...');
      setProgressPercent(98);
      
      try {
        // Get unique drivers and dates from imported data
        const importedDriversSet = new Set(driverDatePairs.map(p => p.driverId));
        const importedDatesSet = new Set(driverDatePairs.map(p => p.date));
        
        // Find the most recent date
        const sortedDates = Array.from(importedDatesSet).sort().reverse();
        const mostRecentDate = sortedDates[0];
        
        if (mostRecentDate) {
          console.log(`🔄 [RouteImport] Processing next delivery markers for date: ${mostRecentDate}`);
          
          for (const driverId of importedDriversSet) {
            try {
              // STEP 1: Reset all isNextDelivery flags for this driver on this date
              const allDeliveriesForDriver = await base44.entities.Delivery.filter({
                driver_id: driverId,
                delivery_date: mostRecentDate
              });
              
              for (const delivery of allDeliveriesForDriver) {
                if (delivery.isNextDelivery) {
                  await base44.entities.Delivery.update(delivery.id, { isNextDelivery: false });
                }
              }
              
              // STEP 2: Find first incomplete stop (pending, in_transit, en_route)
              const incompleteStatuses = ['pending', 'in_transit', 'en_route'];
              const sortedByOrder = allDeliveriesForDriver
                .filter(d => incompleteStatuses.includes(d.status))
                .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
              
              if (sortedByOrder.length > 0) {
                const firstIncomplete = sortedByOrder[0];
                await base44.entities.Delivery.update(firstIncomplete.id, { isNextDelivery: true });
                console.log(`✅ [RouteImport] Set isNextDelivery=true for stop ${firstIncomplete.stop_order || 'N/A'} (${firstIncomplete.patient_name})`);
              }
            } catch (driverError) {
              console.warn(`⚠️ [RouteImport] Failed to update next delivery for driver ${driverId}:`, driverError.message);
            }
          }
        }
      } catch (nextDeliveryError) {
        console.warn('⚠️ [RouteImport] Failed to update next delivery markers:', nextDeliveryError.message);
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
      
      // CRITICAL: NO route optimization after import - preserve imported stop order

      
      // CRITICAL: Restart sync managers - data is now in sync (both online and offline updated simultaneously during import)
      setTimeout(async () => {
        try {
          smartRefreshManager.restart();
          driverLocationPoller.resume();
          console.log('✅ [RouteImport] Sync managers restarted after import');
        } catch (e) {
          console.warn('⚠️ [RouteImport] Failed to restart sync managers:', e.message);
        }
      }, 1000); // Brief delay for UI stability
    } catch (error) {

      
      // Sync managers auto-resumed by executeDataOperation
      
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
          files: files.map((f) => `${f.name} (${fileDriverMap[f.name]?.extractedName || 'unknown'})`).join(', '),
          created: overallResults.created,
          updated: overallResults.updated
        },
        lineNumber: null,
        phase: 'import'
      });
    } finally {
      setIsProcessing(false);
      setTimeout(() => setShowProgress(false), 1000);
      
      // Resume sync processes

      try {
        smartRefreshManager.resume();
        driverLocationPoller.resume();
      } catch (e) {

      }
    }
  };

  const getStatusBadge = (status) => {
    const statusColorMap = {
      'completed': { bg: '#10b981', text: '#ffffff' }, // Green
      'failed': { bg: '#ef4444', text: '#ffffff' }, // Red
      'cancelled': { bg: '#64748b', text: '#ffffff' }, // Slate
      'in_transit': { bg: '#3b82f6', text: '#ffffff' }, // Blue
      'en_route': { bg: '#3b82f6', text: '#ffffff' }, // Blue
      'pending': { bg: '#f59e0b', text: '#ffffff' }, // Amber
      'Ready For Pickup': { bg: '#8b5cf6', text: '#ffffff' }, // Purple
      'picked_up': { bg: '#6366f1', text: '#ffffff' }, // Indigo
      'skipped': { bg: '#f97316', text: '#ffffff' } // Orange
    };
    const color = statusColorMap[status] || { bg: '#94a3b8', text: '#ffffff' };
    return <Badge className="border-0 font-semibold" style={{ background: color.bg, color: color.text }}>{status}</Badge>;
  };

  const handleErrorStartOver = () => {
    setImportError(null);
    setFiles([]);
    setFileDriverMap({});
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

  const handleBackFromMatching = () => {
    setShowDriverMatching(false);
    setFiles([]);
    setFileDriverMap({});
  };

  const handleProceedFromMatching = async () => {
    await handlePreview(files, fileDriverMap);
    setShowDriverMatching(false);
  };

  // Auto-advance if all drivers matched
  useEffect(() => {
    if (showDriverMatching && files.length > 0) {
      const allMatched = files.every(f => fileDriverMap[f.name]?.driver);
      if (allMatched) {
        const timer = setTimeout(() => {
          handleProceedFromMatching();
        }, 800); // Brief delay for visual feedback
        return () => clearTimeout(timer);
      }
    }
  }, [showDriverMatching, files, fileDriverMap]);

  return (
    <>
      {/* Error Popup Dialog */}
      {importError &&
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
              
              {importError.record &&
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                  <p className="font-semibold text-slate-800 mb-3">Record Details:</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {importError.record.driver &&
                <>
                        <span className="text-slate-600">Driver:</span>
                        <span className="font-medium">{importError.record.driver}</span>
                      </>
                }
                    {importError.record.date &&
                <>
                        <span className="text-slate-600">Date:</span>
                        <span className="font-medium">{importError.record.date}</span>
                      </>
                }
                    {importError.record.store &&
                <>
                        <span className="text-slate-600">Store:</span>
                        <span className="font-medium">{importError.record.store}</span>
                      </>
                }
                    {importError.record.patient &&
                <>
                        <span className="text-slate-600">Patient:</span>
                        <span className="font-medium">{importError.record.patient}</span>
                      </>
                }
                    {importError.record.stopId && importError.record.stopId !== 'N/A' &&
                <>
                        <span className="text-slate-600">Stop ID:</span>
                        <span className="font-medium font-mono">{importError.record.stopId}</span>
                      </>
                }
                    {importError.record.trackingNumber && importError.record.trackingNumber !== 'N/A' &&
                <>
                        <span className="text-slate-600">TR#:</span>
                        <span className="font-medium font-mono">{importError.record.trackingNumber}</span>
                      </>
                }
                    {importError.record.time && importError.record.time !== 'N/A' &&
                <>
                        <span className="text-slate-600">Time Value:</span>
                        <span className="font-medium font-mono text-red-600">{importError.record.time}</span>
                      </>
                }
                    {importError.record.deliveryId && importError.record.deliveryId !== 'N/A' &&
                <>
                        <span className="text-slate-600">Delivery ID:</span>
                        <span className="font-medium font-mono text-xs">{importError.record.deliveryId}</span>
                      </>
                }
                    {importError.record.files &&
                <>
                        <span className="text-slate-600">Files:</span>
                        <span className="font-medium text-xs">{importError.record.files}</span>
                      </>
                }
                    {importError.record.created !== undefined &&
                <>
                        <span className="text-slate-600">Created before error:</span>
                        <span className="font-medium">{importError.record.created}</span>
                      </>
                }
                    {importError.record.updated !== undefined &&
                <>
                        <span className="text-slate-600">Updated before error:</span>
                        <span className="font-medium">{importError.record.updated}</span>
                      </>
                }
                  </div>
                </div>
            }
              
              {importError.lineNumber &&
            <div className="text-sm text-slate-600">
                  <span className="font-medium">Line Number:</span> {importError.lineNumber}
                </div>
            }
            </div>
            
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex gap-3">
              <Button
              onClick={handleErrorStartOver}
              className="flex-1 bg-blue-600 hover:bg-blue-700">

                Start Over
              </Button>
              <Button
              onClick={handleErrorCancel}
              variant="outline"
              className="flex-1">

                Cancel Import
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      }

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
        <DialogContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-[10001] translate-x-[-50%] translate-y-[-50%] gap-4 border shadow-lg duration-200 sm:rounded-lg w-[100vw] md:w-full md:max-w-7xl h-[100vh] md:h-auto md:max-h-[90vh] flex flex-col overflow-hidden p-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <DialogHeader className="px-6 py-2 text-center flex flex-col space-y-1.5 sm:text-left border-b flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)' }}>
          <DialogTitle className="text-2xl flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
            <Upload className="w-6 h-6" />
            Import Route Data
          </DialogTitle>
          <DialogDescription style={{ color: 'var(--text-slate-600)' }}>
            Upload CSV files to import delivery routes. Existing data will be automatically purged and replaced.
          </DialogDescription>
        </DialogHeader>

        {showProgress &&
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
                importProgress.phase === 'complete' ? '100%' :
                '0%'
                }
              </span>
            </div>
            <Progress
              value={isParsing ? progressPercent :
              importProgress.total > 0 ? importProgress.current / importProgress.total * 100 :
              importProgress.phase === 'complete' ? 100 : 0
              }
              className="h-2" />

            {!isParsing && (importProgress.created > 0 || importProgress.updated > 0 || importProgress.errors > 0) &&
            <div className="flex justify-between text-xs" style={{ color: 'var(--text-slate-600)' }}>
                <span>Created: {importProgress.created}</span>
                <span>Updated: {importProgress.updated}</span>
                <span>Errors: {importProgress.errors}</span>
              </div>
            }
          </div>
          }

        {showDriverMatching ?
            <div className="flex-1 overflow-y-auto p-2 md:p-6">
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-slate-900)' }}>Verify Driver Matching</h3>
                  <p className="text-sm mb-4" style={{ color: 'var(--text-slate-600)' }}>Please review the driver assignments below. If any files have unmatched drivers, go back and ensure filenames match driver names (e.g., "John Smith Route.csv").</p>
                </div>

                <div className="space-y-2">
                  {files.map((file, index) => {
                    const fileInfo = fileDriverMap[file.name];
                    const hasMatch = !!fileInfo?.driver;

                    return (
                      <motion.div
                        key={index}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-center justify-between p-3 rounded border"
                        style={{
                          background: hasMatch ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                          borderColor: hasMatch ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)',
                          borderWidth: '2px'
                        }}>
                        <div className="flex flex-col flex-1 min-w-0">
                          <span className="font-semibold truncate" style={{ color: 'var(--text-slate-900)' }}>{file.name}</span>
                          <span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Extracted: "{fileInfo?.extractedName || 'N/A'}"</span>
                        </div>
                        <div className="ml-3 flex-shrink-0">
                          {hasMatch ? (
                            <div className="flex flex-col items-end gap-1">
                              <Badge className="whitespace-nowrap font-semibold text-xs" style={{ background: 'rgba(34, 197, 94, 0.2)', color: 'var(--text-green-700)' }}>
                                ✓ Matched
                              </Badge>
                              <span className="text-xs font-mono text-slate-500">{getDriverDisplayName(fileInfo.driver)}</span>
                            </div>
                          ) : (
                            <Badge className="whitespace-nowrap font-semibold text-xs" style={{ background: 'rgba(239, 68, 68, 0.2)', color: 'var(--text-red-700)' }}>
                              ✗ No Match
                            </Badge>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>

                {files.some(f => !fileDriverMap[f.name]?.driver) && (
                  <div className="mt-6 p-4 rounded-lg border-l-4" style={{
                    background: 'rgba(239, 68, 68, 0.08)',
                    borderColor: '#ef4444'
                  }}>
                    <h4 className="font-semibold text-red-800 mb-2">⚠️ Driver Matching Issues</h4>
                    <p className="text-sm text-red-700">Some files could not be automatically matched to drivers. File names should match driver names exactly (case-insensitive). For example:</p>
                    <ul className="text-xs text-red-700 mt-2 list-disc list-inside space-y-1">
                      <li><code className="font-mono bg-red-50 px-1">John Smith Route.csv</code> → matches driver "John Smith"</li>
                      <li><code className="font-mono bg-red-50 px-1">jane_doe_route.csv</code> → matches driver "Jane Doe"</li>
                    </ul>
                  </div>
                )}
              </div>
            </div> :
            !showPreview ?
            <div className="flex-1 overflow-y-auto p-2 md:p-6">
            <div className="space-y-1">
              <div className="grid grid-cols-1 gap-3 md:gap-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="route-upload" style={{ color: 'var(--text-slate-900)' }}>Select Route Files (CSV/TSV/TXT)</Label>
                    <Input
                      ref={fileInputRef}
                      id="route-upload"
                      type="file"
                      accept=".csv,.tsv,.txt"
                      multiple
                      onChange={handleFileChange}
                      onClick={(e) => {
                        // CRITICAL: Prevent any event propagation that might trigger page reload
                        e.stopPropagation();
                      }}
                      disabled={isParsing || isProcessing || showProgress}
                      className="border-2"
                      style={{ borderColor: '#ffffff', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }} />

                    <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>Select multiple route files to import.</p>
                  </div>

                  {files.length > 0 && (
                    <div className="space-y-2">
                      <Label style={{ color: 'var(--text-slate-900)' }}>Auto-Assigned Drivers</Label>
                      <div className="space-y-2 max-h-40 md:max-h-48 overflow-y-auto border rounded-lg p-2 md:p-3 text-xs md:text-sm" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                        {files.map((file, index) => {
                          const fileInfo = fileDriverMap[file.name];
                          const hasMatch = !!fileInfo?.driver;
                          
                          return (
                            <div key={index} className="flex items-center justify-between p-2 rounded border" style={{
                              background: hasMatch ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                              borderColor: hasMatch ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'
                            }}>
                              <div className="flex flex-col flex-1 min-w-0">
                                <span className="text-sm font-medium truncate" style={{ color: 'var(--text-slate-900)' }}>{file.name}</span>
                                <span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Extracted: "{fileInfo?.extractedName || 'N/A'}"</span>
                                {hasMatch && (
                                  <span className="text-xs font-mono text-slate-500">ID: {fileInfo.driver.id?.substring(0, 8)}...</span>
                                )}
                              </div>
                              <div className="ml-3 flex-shrink-0 flex items-center gap-2">
                                {hasMatch ? (
                                   <Badge className="whitespace-nowrap font-semibold" style={{ background: 'rgba(34, 197, 94, 0.2)', color: 'var(--text-green-700)' }}>
                                     ✓ {getDriverDisplayName(fileInfo.driver)}
                                   </Badge>
                                 ) : (
                                   <Badge className="whitespace-nowrap font-semibold" style={{ background: 'rgba(239, 68, 68, 0.2)', color: 'var(--text-red-700)' }}>
                                     ✗ No match
                                   </Badge>
                                 )}
                                {!isParsing && !isProcessing && !showProgress && (
                                  <button onClick={() => removeFile(index)} style={{ color: 'var(--text-slate-400)' }} className="hover:text-red-600">
                                    <X className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                        Drivers are automatically matched by removing " Route.csv" from filenames. Import will PURGE all existing deliveries for these drivers before saving new data.
                      </p>
                    </div>
                  )}
                </div>

                {!isMobile && <div className="border rounded-lg p-4 text-sm" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-800)' }}>
                  <h4 className="font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>CSV Format (Past Routes)</h4>
                  <ul className="list-disc list-inside space-y-1">
                    <li>Date metadata: <code className="font-mono">#YYYY-MM-DD#,TotalDeliveries,...</code></li>
                    <li>Col 1: Store Abbr, Col 2: AM/PM (1=AM, 2=PM)</li>
                    <li>Col 3: TR#, Col 4: Stop Order</li>
                    <li>Col 6: Time (actual_delivery_time if completed, delivery_time_start/ETA if incomplete)</li>
                    <li>Col 7: delivery_time_end (for incomplete stops only)</li>
                    <li>Col 8: Paid KM Override, Col 9: Travel Distance</li>
                    <li>Col 10: IGNORED (not used)</li>
                    <li>Col 13: PUID, Col 14: SID, Col 15: PID</li>
                    <li>Col 17: Notes (COD extracted from here)</li>
                    <li>Matching by Stop ID (SID) + Date for updates.</li>
                  </ul>
                </div>}
              </div>



              {previewData.errors.length > 0 &&
              <div className="space-y-1 mt-4">
                  <div className="flex items-center gap-2 text-red-600 font-semibold">
                    <XCircle className="w-5 h-5" />
                    <span>Parsing Errors: {previewData.errors.length}</span>
                  </div>
                  <div className="max-h-32 overflow-y-auto bg-red-50 p-2 rounded text-xs">
                    {previewData.errors.map((err, i) =>
                  <div key={`parse-err-${i}`} className="text-red-800">{err}</div>
                  )}
                  </div>
                </div>
              }

              {previewData.skippedItems.length > 0 &&
              <div className="space-y-1 mt-4">
                  <div className="flex items-center gap-2 text-orange-600 font-semibold">
                    <AlertCircle className="w-5 h-5" />
                    <span>Skipped Items: {previewData.skippedItems.length}</span>
                  </div>
                  <div className="max-h-32 overflow-y-auto bg-orange-50 p-2 rounded text-xs">
                    {previewData.skippedItems.map((item, i) =>
                  <div key={`skipped-item-${i}`} className="text-orange-800">
                        Line {item.lineNumber}: {item.reason} - <span className="font-mono text-[10px]">{item.rawData}</span>
                      </div>
                  )}
                  </div>
                </div>
              }
            </div>
          </div> :

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-shrink-0 p-4 md:p-6 pb-4">
              <div className={`flex ${isMobile ? 'flex-col' : 'items-center justify-between'} gap-3 md:gap-4 mb-4`}>
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-xs md:text-sm truncate" style={{ color: 'var(--text-slate-500)' }}>
                  Importing for: <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>
                  {[...new Set(files.map(f => fileDriverMap[f.name]?.driver).filter(Boolean).map(d => `${getDriverDisplayName(d)} (...${d.id?.slice(-4)})`))].join(', ')}
                  </span>
                  </span>
                  <h3 className="text-base md:text-lg font-semibold" style={{ color: 'var(--text-slate-800)' }}>Preview: {filteredPreviewDeliveries.length} Deliveries</h3>
                  <span className="text-xs text-red-600 font-medium">⚠️ Existing deliveries will be purged and replaced</span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 w-full md:w-auto">
                   <Select value={previewFilterDate} onValueChange={setPreviewFilterDate}>
                    <SelectTrigger className="w-full md:w-40 text-xs md:text-sm">
                      <SelectValue placeholder="Filter date" />
                    </SelectTrigger>
                    <SelectContent className="z-[10002]">
                      <SelectItem value="all">All Dates</SelectItem>
                      {previewDates.map((date) =>
                      <SelectItem key={date} value={date}>{date}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {previewData.errors.length > 0 &&
              <div className="flex-shrink-0 px-6 pb-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-red-600 font-semibold">
                      <XCircle className="w-5 h-5" />
                      <span>Parsing Errors: {previewData.errors.length}</span>
                    </div>
                    <div className="max-h-32 overflow-y-auto bg-red-50 p-2 rounded text-xs">
                      {previewData.errors.map((err, i) =>
                    <div key={`preview-parse-err-${i}`} className="text-red-800">{err}</div>
                    )}
                    </div>
                  </div>
                </div>
              }

            <div className={`grid ${isMobile ? 'grid-cols-2 gap-2' : 'grid-cols-2 md:grid-cols-4 gap-3'}`}>
            <div className="flex flex-col items-center rounded-lg p-3 border-2" style={{ background: '#10b981', borderColor: '#10b981' }}>
                <div className="text-xs mb-1 text-white font-semibold">New Deliveries</div>
                <div className="text-2xl font-bold text-white">{previewStats.creates}</div>
            </div>

            <div className="flex flex-col items-center rounded-lg p-3 border-2" style={{ background: '#3b82f6', borderColor: '#3b82f6' }}>
                <div className="text-xs mb-1 text-white font-semibold">Updates</div>
                <div className="text-2xl font-bold text-white">{previewStats.updates}</div>
            </div>

            <div className="flex flex-col items-center rounded-lg p-3 border-2" style={{ background: '#10b981', borderColor: '#10b981' }}>
                <div className="text-xs mb-1 text-white font-semibold">Completed</div>
                <div className="text-2xl font-bold text-white">{previewStats.completed}</div>
            </div>

            <div className="flex flex-col items-center rounded-lg p-3 border-2" style={{ background: '#ef4444', borderColor: '#ef4444' }}>
                <div className="text-xs mb-1 text-white font-semibold">Failed/Returned</div>
                <div className="text-2xl font-bold text-white">
                {previewStats.failed}/{previewStats.returned}
                </div>
            </div>

            {previewStats.skipped > 0 &&
              <div className="flex flex-col items-center bg-orange-50 border border-orange-200 rounded-lg p-3">
              <div className="text-xs text-orange-700 mb-1">Skipped Items</div>
              <div className="text-2xl font-bold text-orange-800">{previewStats.skipped}</div>
              </div>
              }
            </div>  
          </div>

            {filteredPreviewDeliveries.length === 0 ?
            <div className="text-center py-8 flex-1 flex items-center justify-center px-6" style={{ color: 'var(--text-slate-500)' }}>
                No deliveries detected for import or matching filters.
              </div> :

            <div className="flex-1 border rounded-lg flex flex-col overflow-hidden min-h-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                {!isMobile && <div className="flex-shrink-0 border-b" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                  <table className="w-full text-sm table-fixed">
                    <thead>
                      <tr>
                        <th className="p-1 text-left w-40">Type</th>
                        <th className="p-1 text-left w-24">Date</th>
                        <th className="p-1 text-left w-12">A/P</th>
                        <th className="p-1 text-left w-14">Order</th>
                        <th className="p-1 text-left w-22">TR#</th>
                        <th className="p-1 text-left w-22">SID/PID</th>
                        <th className="p-1 text-left w-48">Patient/Pickup</th>
                        <th className="p-1 text-left w-24">Status</th>
                        <th className="p-1 text-left w-20">COD $</th>
                        <th className="p-1 text-left w-42">Notes</th>
                        <th className="p-1 text-left w-14">1st</th>
                        <th className="p-1 text-left flex-1">Changes</th>
                      </tr>
                    </thead>
                  </table>
                </div>}

                <div className="flex-1 overflow-y-auto min-h-0">
                  {isMobile ? (
                    // Mobile card view
                    <div className="space-y-2 p-2">
                      {filteredPreviewDeliveries.map((delivery, idx) => {
                        if (delivery.action === 'skipped') {
                          return (
                            <div key={`skipped-${idx}`} className="p-3 rounded border text-xs" style={{ 
                              background: 'rgba(249, 115, 22, 0.12)',
                              borderColor: 'rgba(249, 115, 22, 0.4)',
                              borderWidth: '2px'
                            }}>
                              <div className="flex justify-between items-start mb-2 gap-2">
                                <Badge className="border-0 font-semibold text-xs px-2 py-1 flex-shrink-0" style={{ 
                                  background: '#f97316', 
                                  color: 'white'
                                }}>
                                  ⚠ SKIPPED
                                </Badge>
                                <span className="text-xs text-slate-500">Line {delivery.lineNumber}</span>
                              </div>
                              <div className="space-y-1">
                                <div><span style={{ color: 'var(--text-slate-600)' }}>Reason:</span> <span className="font-medium text-orange-700">{delivery.reason}</span></div>
                                <div className="font-mono text-[10px] text-slate-500 truncate">{delivery.rawData}</div>
                              </div>
                            </div>
                          );
                        }
                        
                        const store = stores.find((s) => s.id === delivery.store_id);
                        const newTimeFormatted = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : 'none';
                        const patient = delivery.patient_id ? patients.find((p) => p.id === delivery.patient_id) : null;
                        const displayAddress = delivery.patient_id ?
                          formatAddressWithUnit(patient?.address || delivery.delivery_address || '', patient?.unit_number || '') :
                          formatAddressWithUnit(delivery.delivery_address || store?.address || '', delivery.unit_number || '');

                        return (
                          <div key={`${delivery.action}-${idx}`} className="p-3 rounded border text-xs" style={{ 
                            background: delivery.action === 'create' ? 'rgba(34, 197, 94, 0.12)' : 
                                       delivery.action === 'update' && delivery._changes?.[0] === 'No changes - re-importing' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                            borderColor: delivery.action === 'create' ? 'rgba(34, 197, 94, 0.4)' : 
                                        delivery.action === 'update' && delivery._changes?.[0] === 'No changes - re-importing' ? 'rgba(34, 197, 94, 0.4)' : 'rgba(59, 130, 246, 0.4)',
                            borderWidth: '2px'
                          }}>
                            <div className="flex justify-between items-start mb-2 gap-2">
                              <Badge className="border-0 font-semibold text-xs px-2 py-1 flex-shrink-0" style={{ 
                                background: delivery.action === 'create' ? '#10b981' : 
                                           delivery.action === 'update' && delivery._changes?.[0] === 'No changes - re-importing' ? '#10b981' : '#3b82f6', 
                                color: 'white'
                              }}>
                                {delivery.action === 'create' ? '✓ NEW' : 
                                 delivery.action === 'update' && delivery._changes?.[0] === 'No changes - re-importing' ? '✓ No Change' : '◇ UPDATE'}
                              </Badge>
                              <span className="font-semibold text-right" style={{ color: 'var(--text-slate-900)' }}>{delivery.delivery_date} {newTimeFormatted !== 'none' && newTimeFormatted}</span>
                            </div>
                            <div className="space-y-1">
                              <div><span style={{ color: 'var(--text-slate-600)' }}>Patient:</span> <span className="font-medium" style={{ color: 'var(--text-slate-900)' }}>{delivery.patient_name}</span></div>
                              <div><span style={{ color: 'var(--text-slate-600)' }}>Address:</span> <span style={{ color: 'var(--text-slate-600)' }}>{displayAddress}</span></div>
                              <div className="flex justify-between">
                                <div><span style={{ color: 'var(--text-slate-600)' }}>TR#:</span> <span className="font-mono">{delivery.tracking_number || '-'}</span></div>
                                <div><span style={{ color: 'var(--text-slate-600)' }}>SID:</span> <span className="font-mono">{delivery.stop_id || '-'}</span></div>
                              </div>
                              <div>{getStatusBadge(delivery.status)}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    // Desktop table view
                    <table className="w-full text-sm table-fixed">
                      <tbody>
                        {filteredPreviewDeliveries.map((delivery, idx) => {
                        if (delivery.action === 'skipped') {
                          return (
                            <tr key={`skipped-${idx}`} className="border-b" style={{ 
                              borderColor: 'var(--border-slate-200)', 
                              background: 'rgba(249, 115, 22, 0.06)',
                              borderLeft: '4px solid #f97316'
                            }}>
                              <td className="p-1 w-30 text-center">
                                <Badge className="w-full justify-center border-0 font-semibold text-xs py-1" style={{ 
                                  background: '#f97316',
                                  color: 'white'
                                }}>
                                  ⚠ SKIPPED
                                </Badge>
                              </td>
                              <td className="p-1 w-24">
                                <div className="flex flex-col">
                                  <span className="text-xs text-slate-500">Line {delivery.lineNumber}</span>
                                  <span className="text-xs font-medium text-slate-700">{(() => {
                                    const driverName = [...new Set(previewData.deliveriesToCreate.concat(previewData.deliveriesToUpdate).map(d => d.driver_name))].find(name => 
                                      name === allPreviewDeliveries.find(d => d.lineNumber === delivery.lineNumber)?.driver_name
                                    );
                                    return driverName || 'Unknown Driver';
                                  })()}</span>
                                </div>
                              </td>
                              <td colSpan="8" className="p-1">
                                <div className="flex flex-col gap-1">
                                  <span className="font-medium text-orange-700">{delivery.reason}</span>
                                  <span className="font-mono text-[10px] text-slate-500">{delivery.rawData}</span>
                                </div>
                              </td>
                            </tr>
                          );
                        }
                        
                        const store = stores.find((s) => s.id === delivery.store_id);
                        const newTimeFormatted = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : 'none';
                        const patient = delivery.patient_id ? patients.find((p) => p.id === delivery.patient_id) : null;

                        const displayAddress = delivery.patient_id ?
                        formatAddressWithUnit(patient?.address || delivery.delivery_address || '', patient?.unit_number || '') :
                        formatAddressWithUnit(delivery.delivery_address || store?.address || '', delivery.unit_number || '');

                        return (
                          <tr key={`${delivery.action}-${idx}`} className="border-b" style={{ 
                            borderColor: 'var(--border-slate-200)', 
                            background: delivery.action === 'create' ? 'rgba(34, 197, 94, 0.06)' : 
                                       delivery.action === 'update' && delivery._changes?.[0] === 'No changes - re-importing' ? 'rgba(34, 197, 94, 0.06)' : 'rgba(59, 130, 246, 0.06)',
                            borderLeft: delivery.action === 'create' ? '4px solid #10b981' : 
                                       delivery.action === 'update' && delivery._changes?.[0] === 'No changes - re-importing' ? '4px solid #10b981' : '4px solid #3b82f6'
                          }}>
                            <td className="p-1 w-30 text-center">
                             <div className="flex flex-col gap-1 items-center">
                               <Badge className="w-full justify-center border-0 font-semibold text-xs py-1" style={{ 
                                 background: delivery.action === 'create' ? '#10b981' : 
                                           delivery.action === 'update' && delivery._changes?.[0] === 'No changes - re-importing' ? '#10b981' : '#3b82f6',
                                 color: 'white'
                               }}>
                                 {delivery.action === 'create' ? '✓ NEW' : 
                                  delivery.action === 'update' && delivery._changes?.[0] === 'No changes - re-importing' ? '✓ No Change' : '◇ UPDATE'}
                               </Badge>
                               <span className="text-xs font-medium" style={{ color: 'var(--text-slate-600)' }}>
                                 {delivery.driver_name}
                               </span>
                               <span className="text-[10px] font-mono text-slate-400">
                                 ...{delivery.driver_id?.slice(-4)}
                               </span>
                             </div>
                            </td>
                            <td className="p-1 w-24">
                              <div className="flex flex-col">
                                <span className="font-medium" style={{ color: 'var(--text-slate-900)' }}>{delivery.delivery_date}</span>
                                {newTimeFormatted !== 'none' && <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{newTimeFormatted}</span>}
                              </div>
                            </td>
                            <td className="p-1 w-12 text-xs font-mono">{delivery.ampm_deliveries || '-'}</td>
                            <td className="p-1 font-mono text-xs w-14">{delivery.stop_order}</td>
                            <td className="p-1 font-mono text-xs w-22" style={{ color: 'var(--text-slate-900)' }}>
                              <div className="flex flex-col">
                                <span>{delivery.tracking_number || '-'}</span>
                                {delivery.puid && <span className="text-purple-600 text-[10px]">{delivery.puid}</span>}
                              </div>
                            </td>
                            <td className="p-1 font-mono text-xs w-22">
                              <div className="flex flex-col">
                                {delivery.stop_id && <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{delivery.stop_id}</span>}
                                {patient?.patient_id && <span style={{ color: 'var(--text-slate-600)' }}>{patient.patient_id}</span>}
                                {!delivery.stop_id && !patient?.patient_id && <span style={{ color: 'var(--text-slate-600)' }}>N/A</span>}
                              </div>
                            </td>
                            <td className="p-1 w-48">
                              <div className="flex flex-col gap-1">
                                {delivery.patient_id ?
                              <>
                                    <span className="font-medium" style={{ color: 'var(--text-slate-900)' }}>{delivery.patient_name}</span>
                                    <span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>{displayAddress}</span>
                                  </> :
                              <>
                                    <span className="text-blue-600 font-semibold">{delivery.patient_name || store?.name || 'Store Pickup'}</span>
                                    <span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>{displayAddress}</span>
                                  </>
                              }
                              </div>
                            </td>
                            <td className="p-1 w-24">{getStatusBadge(delivery.status)}</td>
                            <td className="p-1 font-mono text-xs w-20">
                              {delivery.cod_total_amount_required > 0 ?
                            <div className="flex flex-col">
                                  <span className="text-[10px]" style={{ color: 'var(--text-slate-500)' }}>{delivery.cod_payments?.[0]?.type || delivery.cod_payment_type || 'Cash'}</span>
                                  <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>${delivery.cod_total_amount_required.toFixed(2)}</span>
                                </div> :
                            <span style={{ color: 'var(--text-slate-600)' }}>-</span>}
                            </td>
                            <td className="p-1 text-xs w-42">
                              <span style={{ color: 'var(--text-slate-600)' }}>{delivery.delivery_notes || '-'}</span>
                            </td>
                            <td className="p-1 text-xs w-14">
                              {delivery.first_delivery ? <CheckCircle className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-red-500" />}
                            </td>
                            <td className="p-1 text-xs flex-1">
                              <div className="space-y-1">
                                {delivery._matchReason &&
                              <div className={`font-semibold ${delivery.action === 'create' ? 'text-red-600' : 'text-green-600'}`}>
                                    {delivery._matchReason}
                                  </div>
                              }
                                {delivery.action === 'update' && delivery._changes && delivery._changes.length > 0 &&
                              <>
                                    {delivery._changes.map((change, changeIdx) =>
                                <div key={changeIdx} className="text-orange-700 font-medium">
                                        {change}
                                      </div>
                                )}
                                  </>
                              }
                                {!delivery._matchReason && (!delivery._changes || delivery._changes.length === 0) &&
                              <span style={{ color: 'var(--text-slate-400)' }}>-</span>
                              }
                              </div>
                            </td>
                          </tr>);
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            }
          </div>
          }

        {showPreview && !importResult &&
          <div className="px-3 md:px-6 py-3 border-t" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
            <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-slate-700)' }}>Drivers Being Imported (for verification):</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {[...new Set(filteredPreviewDeliveries.map(d => d.driver_id).filter(Boolean))].map((driverId) => {
                const driverName = filteredPreviewDeliveries.find(d => d.driver_id === driverId)?.driver_name || 'Unknown';
                return (
                  <div key={driverId} className="text-xs p-2 rounded border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                    <span style={{ color: 'var(--text-slate-600)' }}>Name:</span> <span style={{ color: 'var(--text-slate-900)', fontWeight: '500' }}>{driverName}</span>
                    <br />
                    <span style={{ color: 'var(--text-slate-600)' }}>ID:</span> <span style={{ color: 'var(--text-slate-900)', fontFamily: 'monospace' }}>{driverId}</span>
                  </div>
                );
              })}
            </div>
          </div>
        }

        <div className="px-3 md:px-6 py-2 flex flex-col gap-2 md:gap-3 border-t flex-shrink-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <div className="flex gap-2 md:gap-3">
              {showDriverMatching ?
                <>
                  <Button variant="outline" onClick={handleBackFromMatching} disabled={isParsing || isProcessing || showProgress} className="flex-1" style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
                    Back
                  </Button>
                  <Button onClick={handleProceedFromMatching} disabled={isParsing || isProcessing || files.some(f => !fileDriverMap[f.name]?.driver) || showProgress} className="flex-1 bg-blue-600 hover:bg-blue-700">
                    Proceed to Preview
                  </Button>
                </> :
                !showPreview ?
                <>
                  <Button onClick={handlePreview} disabled={isParsing || isProcessing || files.length === 0 || showProgress}>
                  {isParsing ?
                  <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Parsing...
                    </> :
                  'Preview Import'
                  }
                </Button>
                <Button variant="outline" onClick={onCancel} disabled={isParsing || isProcessing || showProgress} style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
                  Cancel
                </Button>
              </> :
              importResult ?
              <>
                  <Button
                   onClick={() => {
                     setFiles([]);
                     setFileDriverMap({});
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
                   }}
                   variant="outline"
                   className="flex-1"
                   style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
                     Start New Import
                   </Button>
                   <Button
                    onClick={async () => {

                       // Data is already on backend from handleConfirmImport
                       // Dispatch immediate UI refresh events
                       window.dispatchEvent(new CustomEvent('deliveriesImported', {
                         detail: { 
                           source: 'route_import',
                           created: importResult.created,
                           updated: importResult.updated
                         }
                       }));

                       // Trigger dashboard refresh
                       window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

                       // Trigger driver location update for map
                       window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                         detail: { appUsers: null }
                       }));

                       // Trigger pull-to-sync to refresh all data
                       window.dispatchEvent(new CustomEvent('triggerPullToSync'));

                       // Just trigger parent refresh callback
                       if (onImportComplete) {
                         await onImportComplete();
                       }
                     }}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                    disabled={isProcessing}>
                      Done - Close Import
                    </Button>
                </> :
              <>
                  <Button variant="outline" onClick={() => setShowPreview(false)} disabled={isProcessing || showProgress} className="flex-1" style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back
                  </Button>
                  <Button onClick={handleConfirmImport} disabled={isProcessing || filteredPreviewDeliveries.length === 0 || showProgress} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                    {isProcessing ?
                  <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Importing...
                      </> :
                  `Confirm Import (${filteredPreviewDeliveries.length})`
                  }
                  </Button>
                </>
              }
          </div>

          {importResult &&
            <div className="space-y-4 p-6 border rounded-lg" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
                <h3 className="font-bold text-green-800">Import Complete!</h3>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
              <div className="flex items-center justify-center gap-1">
                <span style={{ color: 'var(--text-slate-700)' }}>Created:</span>
                <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{importResult.created}</span>
              </div>

              <div className="flex items-center justify-center gap-1">
                <span style={{ color: 'var(--text-slate-700)' }}>Updated:</span>
                <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{importResult.updated}</span>
              </div>

              <div className="flex items-center justify-center gap-1">
                <span style={{ color: 'var(--text-slate-700)' }}>Skipped:</span>
                <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{importResult.skipped}</span>
              </div>
            </div>
            {importResult.errors && importResult.errors.length > 0 &&
              <div className="mt-4">
                  <h4 className="font-semibold text-red-600 mb-2">Errors ({importResult.errors.length}):</h4>
                  <div className="bg-white border border-red-200 rounded p-3 max-h-40 overflow-y-auto text-xs">
                    {importResult.errors.map((err, idx) =>
                  <div key={idx} className="text-red-700 mb-1">{err}</div>
                  )}
                  </div>
                </div>
              }
            </div>
            }
        </div>
      </DialogContent>
    </Dialog>
    </>);

}