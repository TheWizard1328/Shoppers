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
import { batchUpdateAMPM, determineDeliveryAMPM, getPickupStopIdForDelivery } from '../utils/ampmUtils';
import { getAllDriverUsers } from '../utils/driverSelectors';

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
  const patientNameLower = (patient?.full_name || '').toLowerCase();

  if (delivery.status === 'returned') return true;
  if (notesLower.includes('return')) return true;
  if (!delivery.patient_id) {
    const store = validStores.find((s) => s.id === delivery.store_id);
    if (store && (notesLower.includes('return') || store.name?.toLowerCase().includes('return'))) {
      return true;
    }
  }
  if (patientNameLower.includes('return')) return true;
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

  const findStoreByAbbreviation = useCallback((abbr) => {
    if (!abbr) return null;
    // CRITICAL: Always use allStores which contains stores from ALL cities
    // Do NOT fallback to props stores as they may be filtered by current city
    const storesToSearch = allStores.length > 0 ? allStores : (stores || []);
    if (!Array.isArray(storesToSearch)) return null;
    const found = storesToSearch.find((s) => s.abbreviation?.toLowerCase() === abbr.toLowerCase());
    if (!found) {
      console.warn(`[RouteImport] Store abbreviation "${abbr}" not found in ${storesToSearch.length} stores. Available abbreviations:`, 
        storesToSearch.map(s => s.abbreviation).filter(Boolean).slice(0, 20));
    }
    return found;
  }, [allStores, stores]);

  const findDispatcherByStore = useCallback((store) => {
    if (!store) return null;
    
    // Use allDriverUsers (all cities) or fallback to allUsers prop
    const usersToSearch = allDriverUsers.length > 0 ? allDriverUsers : (allUsers || []);

    if (store.dispatcher_id) {
      const dispatcher = usersToSearch.find((u) => u.id === store.dispatcher_id);
      if (dispatcher) {
        console.log(`[RouteImport] Found dispatcher via ID for store ${store.name}:`, dispatcher.user_name || dispatcher.full_name);
        return dispatcher;
      } else {
        console.warn(`[RouteImport] Store ${store.name} has dispatcher_id (${store.dispatcher_id}) but no matching user found. Falling back to name-based lookup.`);
      }
    }

    if (store.dispatcher_name) {
      console.warn(`[RouteImport] Falling back to name-based dispatcher lookup for store ${store.name}`);
      const dispatcherNameLower = store.dispatcher_name.toLowerCase().trim();
      const dispatcher = usersToSearch.find((u) => {
        const userName = (u.user_name || u.full_name || '').toLowerCase().trim();
        return u.app_roles?.includes('dispatcher') && userName === dispatcherNameLower;
      });

      if (dispatcher) {
        console.log(`[RouteImport] Found dispatcher via name fallback for store ${store.name}:`, dispatcher.user_name || dispatcher.full_name);
        return dispatcher;
      } else {
        console.warn(`[RouteImport] No dispatcher found by name "${store.dispatcher_name}" for store ${store.name}`);
      }
    }

    console.warn(`[RouteImport] No dispatcher found for store ${store.name} after trying both ID and name.`);
    return null;
  }, [allDriverUsers, allUsers]);

  const matchDeliveryToExisting = useCallback((importedDelivery, existingDeliveries, patientsData) => {
    if (!importedDelivery || !existingDeliveries || !Array.isArray(existingDeliveries) || !patientsData || !Array.isArray(patientsData)) {
      console.warn("[RouteImport] matchDeliveryToExisting called with invalid arguments.");
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

    console.log(`🔍 [RouteImport] Checking for match - Date: ${importedDeliveryDate}, Driver: "${importedDriverName}", AM/PM: ${importedAMPM || 'N/A'}, Found ${sameDateDeliveries.length} deliveries on same date for same driver`);
    console.log(`🔍 [RouteImport] Import details - SID: "${importedDeliveryStopId}", PID: "${importedDeliveryPatientId}", TR: "${importedTrackingNumber}"`);

    // Check for multiple patient deliveries in same slot (require SID for patients only)
    let hasMultipleInSlot = false;
    if (importedAMPM && importedDeliveryPatientId) {
      const sameSlotDeliveries = sameDateDeliveries.filter((d) => d.ampm_deliveries === importedAMPM);
      const patientDeliveriesInSlot = sameSlotDeliveries.filter((d) => d.patient_id === importedDeliveryPatientId);
      if (patientDeliveriesInSlot.length > 1) {
        hasMultipleInSlot = true;
        console.log(`⚠️ [RouteImport] Found ${patientDeliveriesInSlot.length} deliveries for patient "${importedPatient?.full_name}" in ${importedAMPM} slot - REQUIRING SID match`);
      }
    }

    if (hasMultipleInSlot) {
      if (importedDeliveryStopId) {
        const sidMatch = sameDateDeliveries.find((d) => {
          const existingSID = (d.stop_id || '').trim();
          const matches = existingSID === importedDeliveryStopId;
          if (matches) {
            console.log(`✅ [RouteImport] SID MATCH FOUND (multiple in slot): "${existingSID}" === "${importedDeliveryStopId}"`);
          }
          return matches;
        });
        if (sidMatch) {
          console.log(`✅ [RouteImport] Matched by stop_id (required due to multiple in slot). Delivery ID: ${sidMatch.id}`);
          return { match: sidMatch, reason: `SID Match (${importedDeliveryStopId})` };
        } else {
          console.log(`🚫 [RouteImport] No SID match found - will create NEW delivery (multiple identical deliveries in slot)`);
          return { match: null, reason: 'Multiple in slot - SID required but not matched' };
        }
      } else {
        console.log(`🚫 [RouteImport] No SID provided but multiple identical deliveries in slot - will create NEW delivery`);
        return { match: null, reason: 'Multiple in slot - no SID provided' };
      }
    }

    if (importedDeliveryStopId) {
      const sidMatch = sameDateDeliveries.find((d) => {
        const existingSID = (d.stop_id || '').trim();
        const matches = existingSID === importedDeliveryStopId;
        if (matches) {
          console.log(`✅ [RouteImport] SID MATCH FOUND: "${existingSID}" === "${importedDeliveryStopId}" for driver "${importedDriverName}"`);
        }
        return matches;
      });
      if (sidMatch) {
        console.log(`✅ [RouteImport] Matched by stop_id (${importedDeliveryStopId}), date, and driver. Delivery ID: ${sidMatch.id}`);
        return { match: sidMatch, reason: `SID Match (${importedDeliveryStopId})` };
      } else {
        console.log(`❌ [RouteImport] No SID match for "${importedDeliveryStopId}". Existing SIDs on this date for this driver:`,
        sameDateDeliveries.map((d) => d.stop_id).filter(Boolean));
        console.log(`🔍 [RouteImport] SID not matched - attempting highly probable match based on PID, stop order, time, and TR range...`);

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
            console.log(`✅ [RouteImport] Highly probable match found (score: ${match._probScore}): ${reasonText}`);
            return { match, reason: reasonText };
          } else if (highProbabilityMatches.length > 1) {
            highProbabilityMatches.sort((a, b) => (b._probScore || 0) - (a._probScore || 0));
            const bestMatch = highProbabilityMatches[0];
            const reasonText = `Highly Probable (Best): PID + ${bestMatch._probReasons.join(' + ')}`;
            console.log(`✅ [RouteImport] Multiple high probability matches, selecting best (score: ${bestMatch._probScore}): ${reasonText}`);
            return { match: bestMatch, reason: reasonText };
          } else {
            console.log(`🚫 [RouteImport] No highly probable match found for delivery - continuing to other matching methods...`);
          }
        } else {
          console.log(`🔍 [RouteImport] No PID available - will try pickup matching methods below...`);
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
        console.log(`✅ [RouteImport] Single PID MATCH FOUND: "${patientIdMatch.patient_id}" === "${importedDeliveryPatientId}" for driver "${importedDriverName}"`);
        console.log(`✅ [RouteImport] Matched by patient_id (${importedDeliveryPatientId}), date, and driver. Delivery ID: ${patientIdMatch.id}`);
        return { match: patientIdMatch, reason: `PID Match (${importedDeliveryPatientId})` };
      } else if (patientIdMatches.length > 1) {
        console.log(`🔍 [RouteImport] Found ${patientIdMatches.length} deliveries with PID "${importedDeliveryPatientId}", applying fuzzy matching...`);

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
              console.log(`✅ [RouteImport] Time match: ${timeDiffMinutes} minutes difference (within 60min threshold)`);
            }
          }

          if (importedStopOrder !== null && candidate.stop_order !== null) {
            const orderDiff = Math.abs(importedStopOrder - candidate.stop_order);
            if (orderDiff <= 3) {
              score += 10;
              reasons.push(`Order ±${orderDiff}`);
              console.log(`✅ [RouteImport] Stop order match: ${orderDiff} positions difference (within ±3 threshold)`);
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
          console.log(`✅ [RouteImport] Fuzzy match successful with score ${bestScore}: ${reasonText}`);
          return { match: bestMatch, reason: reasonText };
        } else {
          console.log(`❌ [RouteImport] Multiple PID matches but no fuzzy criteria met - will create NEW delivery`);
          return { match: null, reason: `Multiple PID matches - fuzzy criteria not met` };
        }
      } else {
        console.log(`❌ [RouteImport] No PID match for "${importedDeliveryPatientId}". Existing PIDs on this date for this driver:`,
        sameDateDeliveries.map((d) => d.patient_id).filter(Boolean).slice(0, 10));
      }
    }

    if (importedTrackingNumber && !importedDeliveryStopId) {
      const trackingNumberMatch = sameDateDeliveries.find((d) => {
        const existingTR = (d.tracking_number || '').trim();
        const matches = existingTR === importedTrackingNumber;
        if (matches) {
          console.log(`✅ [RouteImport] TR MATCH FOUND: "${existingTR}" === "${importedTrackingNumber}" for driver "${importedDriverName}"`);
        }
        return matches;
      });
      if (trackingNumberMatch) {
        console.log(`✅ [RouteImport] Matched by tracking_number (${importedTrackingNumber}), date, and driver. Delivery ID: ${trackingNumberMatch.id}`);
        return { match: trackingNumberMatch, reason: `TR# Match (${importedTrackingNumber})` };
      } else {
        console.log(`❌ [RouteImport] No TR match for "${importedTrackingNumber}". Existing TRs on this date for this driver:`,
        sameDateDeliveries.map((d) => d.tracking_number).filter(Boolean).slice(0, 10));
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
        console.log(`✅ [RouteImport] Matched generic pickup by store_id, date, and driver. Delivery ID: ${pickupMatch.id}`);
        return { match: pickupMatch, reason: `Pickup Match (Store)` };
      }
    }

    if (!importedDeliveryPatientId && importedDelivery.store_id) {
      const importedTime = importedDelivery.actual_delivery_time ? new Date(importedDelivery.actual_delivery_time).getTime() : null;
      const importedAddress = (importedDelivery.delivery_address || '').toLowerCase().trim();
      const importedStopOrder = importedDelivery.stop_order;
      const importedTR = importedTrackingNumber ? importedTrackingNumber.trim() : null;

      console.log(`🔍 [RouteImport] Attempting highly probable pickup match for store_id: ${importedDelivery.store_id}`);

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
        console.log(`✅ [RouteImport] Highly probable pickup match found (score: ${match._pickupProbScore}): ${reasonText}`);
        return { match, reason: reasonText };
      } else if (highProbabilityPickups.length > 1) {
        highProbabilityPickups.sort((a, b) => (b._pickupProbScore || 0) - (a._pickupProbScore || 0));
        const bestMatch = highProbabilityPickups[0];
        const reasonText = `Highly Probable Pickup (Best): Store + ${bestMatch._pickupProbReasons.join(' + ')}`;
        console.log(`✅ [RouteImport] Multiple high probability pickup matches, selecting best (score: ${bestMatch._pickupProbScore}): ${reasonText}`);
        return { match: bestMatch, reason: reasonText };
      }
    }

    console.log(`❌ [RouteImport] NO MATCH FOUND for driver "${importedDriverName}" - will create new delivery`);
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
    { key: 'signature_needed', label: 'Signature' },
    { key: 'fridge_item', label: 'Fridge' },
    { key: 'oversized', label: 'Oversized' },
    { key: 'after_hours_pickup', label: 'After Hours' },
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
      } else if (normalizedExisting !== normalizedImported) {
        let displayExisting = normalizedExisting === null ? 'none' : typeof normalizedExisting === 'boolean' ? normalizedExisting ? 'true' : 'false' : normalizedExisting.toString();
        let displayImported = normalizedImported === null ? 'none' : typeof normalizedImported === 'boolean' ? normalizedImported ? 'true' : 'false' : normalizedImported.toString();

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

  const processCSVData = useCallback(async (csvText, fileName, selectedDriver, allDeliveriesData, patientsData) => {
    console.log(`[RouteImport] Processing file: ${fileName}`);

    if (!csvText || !fileName || !selectedDriver || !patientsData || !stores || !allUsers || !currentUser) {
      console.error('[RouteImport] Missing required data for processing');
      return { deliveriesToCreate: [], deliveriesToUpdate: [], skippedItems: [], errors: [] };
    }

    const statusMap = {
      'Completed': 'completed',
      'In Transit': 'in_transit',
      'Ready For Pickup': 'Ready For Pickup',
      'Pending': 'pending',
      'Picked Up': 'picked_up',
      'Failed': 'failed',
      'Cancelled': 'cancelled',
      'Returned': 'returned'
    };

    const deliveriesToCreate = [];
    const deliveriesToUpdate = [];
    const skippedItems = [];
    const errors = [];
    const lines = csvText.split(/\r?\n/).filter((line) => line.trim());

    let currentDate = null;
    let expectedDeliveries = 0;
    let lineNumber = 0;

    console.log(`[RouteImport] Creating patient lookup map from ${patientsData.length} patients`);
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

    console.log(`[RouteImport] Patient PID map created with ${patientsByPID.size} entries`);
    console.log(`[RouteImport] Patients without PID: ${patientsWithoutPID}`);
    if (patientsByPID.size > 0) {
      console.log(`[RouteImport] Sample PIDs:`, Array.from(patientsByPID.keys()).slice(0, 10));
    }

    const existingDeliveryIds = new Set(allDeliveriesData.map((d) => d.delivery_id).filter(Boolean));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      lineNumber = i + 1;

      if (lineNumber % 10 === 0) {
        const percent = Math.round(lineNumber / lines.length * 50);
        setProgressPercent(percent);
        setProgressMessage(`Parsing file: ${fileName} (Line ${lineNumber} / ${lines.length})...`);
      }

      if (!line.trim()) {
        console.log(`[RouteImport] Row ${lineNumber}: Skipping empty line.`);
        continue;
      }

      const dateMetaMatch = line.match(/^#(\d{4}-\d{2}-\d{2})#,(\d+),/);
      if (dateMetaMatch) {
        currentDate = dateMetaMatch[1];
        expectedDeliveries = parseInt(dateMetaMatch[2], 10);
        console.log(`📅 Row ${lineNumber}: Date metadata found - Date: ${currentDate}, Expected Deliveries: ${expectedDeliveries}`);
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

      if (values.length < 16) {
        console.warn(`⚠️ Row ${lineNumber}: Insufficient fields (${values.length} out of 16+ expected), skipping line.`);
        skippedItems.push({
          lineNumber,
          reason: `Insufficient fields (${values.length}/16)`,
          rawData: values.join(', ')
        });
        continue;
      }

      const storeAbbr = values[0]?.replace(/"/g, '').trim();
      const ampmRawValue = values[1]?.replace(/"/g, '').trim();
      const trackingNumber = values[2]?.replace(/"/g, '').trim();
      const stopOrder = parseInt(values[3]?.trim()) || 0;
      const completionTimeStr = values[5]?.replace(/"/g, '').trim();
      const stopId = (values[12] || '').replace(/"/g, '').trim();
      const patientPID = values[13]?.replace(/"/g, '').trim();
      const rawNotes = (values[15] || '').replace(/"/g, '').trim();

      let ampmValue = null;
      if (ampmRawValue === '1') {
        ampmValue = 'AM';
      } else if (ampmRawValue === '2') {
        ampmValue = 'PM';
      } else if (ampmRawValue === 'AM' || ampmRawValue === 'PM') {
        ampmValue = ampmRawValue;
      }

      console.log(`[RouteImport] Row ${lineNumber} - Order: ${stopOrder}, StoreAbbr: "${storeAbbr}", AM/PM: "${ampmValue || 'none'}" (raw: "${ampmRawValue}"), TR: "${trackingNumber}", SID: "${stopId}", PID: "${patientPID}"`);

      const store = findStoreByAbbreviation(storeAbbr);
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
        console.log(`✅ Row ${lineNumber}: Found patient "${patient.full_name}" (ID: ${patient.id}) for PID "${patientPID}"`);
      }

      const dispatcher = findDispatcherByStore(store);
      const dispatcherId = dispatcher ? dispatcher.id : null;

      if (!dispatcherId) {
        console.warn(`⚠️ Row ${lineNumber}: Could not find dispatcher for store "${store.name}".`);
      }

      const newDeliveryData = {
        delivery_date: currentDate,
        store_id: store.id,
        dispatcher_id: dispatcherId || null,
        driver_id: selectedDriver.id,
        driver_name: selectedDriver.user_name || selectedDriver.full_name,
        tracking_number: trackingNumber,
        stop_order: stopOrder,
        stop_id: stopId || null,
        status: 'completed',
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
        puid: null
      };

      const assignedAMPM = ampmValue || determineDeliveryAMPM(newDeliveryData, allDeliveriesData);
      newDeliveryData.ampm_deliveries = assignedAMPM;

      // PUID assignment will be done after all rows are parsed (see below)

      if (completionTimeStr && currentDate) {
        // Validate time format before setting
        const timeRegex = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
        if (timeRegex.test(completionTimeStr)) {
          newDeliveryData.actual_delivery_time = `${currentDate}T${completionTimeStr}:00`;
          console.log(`🕒 Row ${lineNumber}: Set local time "${completionTimeStr}" on date "${currentDate}" as: "${newDeliveryData.actual_delivery_time}"`);
        } else {
          console.warn(`⚠️ Row ${lineNumber}: Invalid time format "${completionTimeStr}", skipping time assignment`);
          // Don't throw - just skip the time but continue with the record
        }
      }

      console.log(`🔢 Row ${lineNumber}: Set stop_order to ${stopOrder} (from column 4)`);
      console.log(`🕒 Row ${lineNumber}: Set ampm_deliveries to "${newDeliveryData.ampm_deliveries}" (1→AM, 2→PM from column 2)`);

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
        console.log(`📦 Row ${lineNumber}: Populated delivery data with patient info. Unit: "${newDeliveryData.unit_number}", Instructions: "${newDeliveryData.delivery_instructions}"`);
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
        console.log(`🛍️ Row ${lineNumber}: Populated delivery data for store pickup.`);
      }

      let cleanedNotes = rawNotes.replace(/ - /g, '\n');
      const notesLower = cleanedNotes.toLowerCase();

      if (notesLower.includes('first delivery')) {
        newDeliveryData.first_delivery = true;
        cleanedNotes = cleanedNotes.replace(/first delivery/gi, '').trim();
        cleanedNotes = cleanedNotes.replace(/^[,\s\n]+|[,\s\n]+$/g, '').replace(/\s{2,}/g, ' ').replace(/\n{2,}/g, '\n');
        console.log(`⭐ Row ${lineNumber}: Found "First Delivery" in notes, setting first_delivery=true`);
        console.log(`📝 Row ${lineNumber}: Original notes: "${rawNotes}"`);
        console.log(`📝 Row ${lineNumber}: Cleaned notes after removing "First Delivery": "${cleanedNotes}"`);
      }

      if (notesLower.includes('failed')) {
        newDeliveryData.status = statusMap['Failed'];
      } else if (notesLower.includes('cancel')) {
        newDeliveryData.status = statusMap['Cancelled'];
      } else if (notesLower.includes('return')) {
        newDeliveryData.status = statusMap['Returned'];
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

      if (patientId) {
        const codRegex = /(cod|dod)\s*[\$]?\s*([\d.]+)\s*(cash|debit|credit|check|cheque)?/gi;
        const codMatches = [...cleanedNotes.matchAll(codRegex)];

        if (codMatches.length > 0) {
          const codPayments = [];
          let totalCodAmount = 0;

          codMatches.forEach((match, idx) => {
            const codType = (match[1] || '').toLowerCase();
            const amount = parseFloat(match[2]);
            let paymentType = (match[3] || '').toLowerCase();

            if (codType === 'dod') {
              paymentType = 'Debit';
              console.log(`💳 Row ${lineNumber}: DOD detected - forcing payment type to Debit`);
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
              console.log(`💰 Row ${lineNumber}: Found ${codType.toUpperCase()} #${idx + 1}: $${amount} (${paymentType})`);
            }
          });

          if (codPayments.length > 0) {
            newDeliveryData.cod_payments = codPayments;
            newDeliveryData.cod_total_amount_required = totalCodAmount;
            newDeliveryData.cod_payment_type = codPayments[0].type;
            newDeliveryData.cod_amount = totalCodAmount.toString();
            console.log(`💰 Row ${lineNumber}: Total COD for patient delivery: $${totalCodAmount} (${codPayments.length} payment(s))`);
          } else {
            console.log(`💰 Row ${lineNumber}: COD found but all amounts are 0 - setting to null`);
          }
        } else {
          console.log(`💰 Row ${lineNumber}: No COD/DOD found in notes for patient delivery`);
        }
      } else {
        console.log(`💰 Row ${lineNumber}: Pickup delivery - COD extraction skipped`);
      }

      const linesToRemove = [
      /(?:unit|apt|apartment|suite)\s*#?\s*\d+/i,
      /#\d+/i,
      /\d+\s+buzz\s+\d+/i,
      /(?:cod|dod)\s*[\$]?\s*[\d.]+/i,
      /\b(cash|debit|credit|check|cheque)\b/i,
      /\bsignature\b/i,
      /\b(fridge|cold|refrigerat(?:e|ed|or)?|refrig)\b/i,
      /\b(oversized|large|bulky|big)\b/i,
      /\bafter[\s-]?hours\b/i,
      /\b(failed|cancel|cancelled|return|pickup|pick up)\b/i,
      /\bfirst delivery\b/i];


      const noteLines = cleanedNotes.split('\n');
      const filteredNoteLines = noteLines.filter((noteLine) => {
        const noteLineLower = noteLine.toLowerCase().trim();

        if (!noteLineLower) return false;

        if (noteLineLower.includes('interstore')) {
          return true;
        }

        for (const pattern of linesToRemove) {
          if (pattern.test(noteLine)) {
            console.log(`🗑️ Row ${lineNumber}: Removing line from notes: "${noteLine}"`);
            return false;
          }
        }

        return true;
      });

      cleanedNotes = filteredNoteLines.join('\n').trim();

      newDeliveryData.delivery_notes = cleanedNotes;
      if (newDeliveryData.delivery_notes === '' || newDeliveryData.delivery_notes === '-') {
        newDeliveryData.delivery_notes = null;
      }

      console.log(`📝 Row ${lineNumber}: Cleaned notes: "${newDeliveryData.delivery_notes}"`);

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
          console.log(`🔄 Row ${lineNumber}: Identified as an update for existing delivery (ID: ${existingDelivery.id}) with ${changes.length} changes: ${changes.join(', ')}`);
        } else {
          console.log(`⏭️ Row ${lineNumber}: Skipping - no significant changes detected for existing delivery (ID: ${existingDelivery.id}).`);
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
        console.log(`✨ Row ${lineNumber}: Identified as a new delivery (DID: ${newDeliveryId}).`);
      }
    }

    // PUID Assignment Pass: Now that all rows are parsed, assign PUIDs
    // Matching criteria: Date + Driver + Store (col 1) + AM/PM (col 2)
    // For pickups: PUID = own stop_id
    // For patient deliveries: Find pickup with matching Date + Driver + Store + AM/PM
    console.log(`📌 [RouteImport] Starting PUID assignment pass for ${deliveriesToCreate.length + deliveriesToUpdate.length} deliveries...`);
    
    // Build a map of pickups by date + driver_id + store_id + ampm_deliveries for quick lookup
    const allParsedDeliveries = [...deliveriesToCreate, ...deliveriesToUpdate];
    const pickupMap = new Map();
    
    allParsedDeliveries.forEach((d) => {
      if (!d.patient_id && d.store_id && d.stop_id) {
        // This is a pickup - index by date + driver + store + ampm
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries || 'none'}`;
        if (!pickupMap.has(key)) {
          pickupMap.set(key, d.stop_id);
          console.log(`📌 [RouteImport] Indexed pickup: date=${d.delivery_date}, driver=${d.driver_id}, store=${d.store_id}, AM/PM=${d.ampm_deliveries || 'none'}, SID=${d.stop_id}`);
        }
      }
    });
    
    console.log(`📌 [RouteImport] Pickup map has ${pickupMap.size} entries`);
    
    // Now assign PUIDs
    allParsedDeliveries.forEach((d) => {
      if (!d.patient_id && d.stop_id) {
        // Pickup: PUID = own stop_id
        d.puid = d.stop_id;
      } else if (d.patient_id) {
        // Patient delivery: find matching pickup by date + driver + store + AM/PM
        const key = `${d.delivery_date}_${d.driver_id}_${d.store_id}_${d.ampm_deliveries || 'none'}`;
        const matchingPuid = pickupMap.get(key);
        if (matchingPuid) {
          d.puid = matchingPuid;
          console.log(`📌 [RouteImport] Assigned PUID "${matchingPuid}" to patient delivery (SID: ${d.stop_id}, date=${d.delivery_date}, driver=${d.driver_id}, store=${d.store_id}, AM/PM: ${d.ampm_deliveries})`);
        } else {
          d.puid = null;
          console.log(`⚠️ [RouteImport] No pickup found for patient delivery (SID: ${d.stop_id}, date=${d.delivery_date}, driver=${d.driver_id}, store=${d.store_id}, AM/PM: ${d.ampm_deliveries}) - PUID left blank`);
        }
      }
    });

    const totalToCreate = deliveriesToCreate.length;
    const totalToUpdate = deliveriesToUpdate.length;
    const totalForThisFile = totalToCreate + totalToUpdate;

    console.log(`File "${fileName}": ${totalToCreate} to create, ${totalToUpdate} to update. Total: ${totalForThisFile}`);

    setProgressPercent(50);
    setProgressMessage('Parsing complete, preparing deliveries for ' + fileName + '...');

    console.log(`[RouteImport] File ${fileName} processed: ${deliveriesToCreate.length} new, ${deliveriesToUpdate.length} updates, ${skippedItems.length} skipped, ${errors.length} errors`);

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
        console.log('[RouteImport] Fetching ALL users from ALL cities...');
        const allAppUsers = await base44.entities.AppUser.list();
        const allAuthUsers = await base44.entities.User.list();
        
        // Merge AppUsers with Auth Users
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
        console.log(`[RouteImport] Loaded ${mergedUsers.length} users from ALL cities`);
      } catch (error) {
        console.error('[RouteImport] Error loading all drivers:', error);
        // Fallback to prop allUsers
        setAllDriverUsers(allUsers || []);
      }
    };
    
    loadAllDrivers();
  }, [allUsers]);

  const availableDrivers = useMemo(() => {
    const usersToUse = allDriverUsers.length > 0 ? allDriverUsers : (allUsers || []);
    
    if (!Array.isArray(usersToUse) || usersToUse.length === 0) {
      console.warn('[RouteImport] No users available for driver selection');
      return [];
    }

    const drivers = getAllDriverUsers(usersToUse, false);
    console.log('[RouteImport] Available drivers:', drivers.length, drivers.map((d) => d.user_name || d.full_name));
    return sortUsers(drivers);
  }, [allDriverUsers, allUsers]);

  const allPreviewDeliveries = useMemo(() => {
    const created = previewData.deliveriesToCreate.map((d) => ({ ...d, action: 'create' }));
    const updated = previewData.deliveriesToUpdate.map((d) => ({ ...d, action: 'update' }));
    return [...created, ...updated];
  }, [previewData.deliveriesToCreate, previewData.deliveriesToUpdate]);

  const previewDrivers = useMemo(() => {
    const driverNames = new Set(allPreviewDeliveries.map((d) => d.driver_name));
    return Array.from(driverNames).sort();
  }, [allPreviewDeliveries]);

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

    const failed = filteredPreviewDeliveries.filter((d) => d.status === 'failed').length;

    const returned = filteredPreviewDeliveries.filter((d) => {
      const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = (d.delivery_address || '').toLowerCase().includes('rtn');
      return d.status === 'returned' || notesReturn || addressReturn;
    }).length;

    return { creates, updates, completed, failed, returned, skipped: previewData.skippedItems.length };
  }, [filteredPreviewDeliveries, previewData.skippedItems]);


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
      // CRITICAL: Use allDriverUsers (fetched from ALL cities) to find the selected driver
      const usersToSearch = allDriverUsers.length > 0 ? allDriverUsers : (allUsers || []);
      const selectedUser = usersToSearch.find((u) => u.id === selectedDriverId);
      if (!selectedUser) throw new Error('Selected driver not found');

      console.log(`[RouteImport] Fetching fresh store data from ALL cities...`);
      setProgressMessage('Fetching store data from all cities...');
      // CRITICAL: Fetch ALL stores without any city filter
      const freshStoresAll = await base44.entities.Store.list('-created_date');
      setAllStores(freshStoresAll || []);
      console.log(`[RouteImport] Fresh store data loaded: ${freshStoresAll?.length || 0} stores from ALL cities`);
      if (freshStoresAll && freshStoresAll.length > 0) {
        console.log(`[RouteImport] Store abbreviations available:`, freshStoresAll.map(s => `${s.abbreviation || 'N/A'} (${s.name})`).slice(0, 30));
      }

      console.log(`[RouteImport] Fetching fresh patient data from ALL stores/cities...`);
      setProgressMessage('Fetching patient data from all stores...');
      // CRITICAL: Fetch ALL patients without any filter - ensures we can match any patient
      const freshPatients = await base44.entities.Patient.list('-created_date');
      setPatients(freshPatients);
      console.log(`[RouteImport] Fresh patient data loaded: ${freshPatients?.length || 0} patients from ALL stores`);

      if (!freshPatients || freshPatients.length === 0) {
        alert('No patient data available.');
        setIsParsing(false);
        setShowProgress(false);
        return;
      }

      if (freshPatients.length > 0) {
        console.log(`[RouteImport] Sample patient data:`, freshPatients.slice(0, 3).map((p) => ({
          id: p.id,
          patient_id: p.patient_id,
          full_name: p.full_name
        })));
      }

      console.log('[RouteImport] Fetching fresh delivery data from ALL cities for duplicate detection...');
      setProgressMessage('Fetching delivery data from all cities for duplicate detection...');
      // CRITICAL: Fetch ALL deliveries without any filter to ensure we can match deliveries
      // from any city/store - the list() method may have a limit, so we need to fetch more
      const freshDeliveries = await base44.entities.Delivery.filter({}, '-created_date', 10000);
      console.log(`[RouteImport] Loaded ${freshDeliveries.length} existing deliveries from ALL cities for comparison`);

      if (freshDeliveries.length > 0) {
        console.log('[RouteImport] Sample of existing deliveries:');
        freshDeliveries.slice(0, 3).forEach((d) => {
          console.log(`  - ID: ${d.id}, Date: "${d.delivery_date}", SID: "${d.stop_id || 'none'}", PID: "${d.patient_id || 'none'}", TR: "${d.tracking_number || 'none'}"`);
        });
      }

      let totalToCreate = [];
      let totalToUpdate = [];
      let totalSkippedItems = [];
      let totalErrors = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log(`[RouteImport] Processing file ${i + 1} of ${files.length}: ${file.name}`);
        setProgressMessage(`Processing file ${i + 1} of ${files.length}: ${file.name}...`);

        const text = await file.text();
        const result = await processCSVData(text, file.name, selectedUser, freshDeliveries, freshPatients);

        console.log(`[RouteImport] Processing complete for file ${file.name}:`, {
          toCreate: result.deliveriesToCreate.length,
          toUpdate: result.deliveriesToUpdate.length,
          skipped: result.skippedItems.length,
          errors: result.errors.length
        });

        totalToCreate = [...totalToCreate, ...result.deliveriesToCreate];
        totalToUpdate = [...totalToUpdate, ...result.deliveriesToUpdate];
        totalSkippedItems = [...totalSkippedItems, ...result.skippedItems];
        totalErrors = [...totalErrors, ...result.errors];

        const currentParsingProgress = Math.round((i + 1) / files.length * 50);
        setProgressPercent(50 + currentParsingProgress);
      }

      console.log(`📌 [RouteImport] PUID assignment was done during parsing. Total: ${totalToCreate.length} to create, ${totalToUpdate.length} to update`);

      setProgressPercent(100);
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
          driver: availableDrivers.find(d => d.id === selectedDriverId)?.user_name || 'Unknown',
          files: files.map(f => f.name).join(', ')
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
      failed: 0,
      returned: 0,
      errors: [...previewData.errors],
      fileResults: []
    };

    const failedCreations = [];
    const failedUpdates = [];

    try {
      // Notify parent to pause smart refresh during import
      if (typeof window !== 'undefined' && window.__routeImportStartCallback) {
        window.__routeImportStartCallback();
      }
      
      setProgressMessage('Fetching latest patient and store data from ALL cities...');
      // CRITICAL: Fetch ALL patients and stores without filters
      const freshPatients = await base44.entities.Patient.list('-created_date');
      const freshStores = await base44.entities.Store.list('-created_date');

      const deliveriesToCreateFiltered = filteredPreviewDeliveries.filter((d) => d.action === 'create');
      const deliveriesToUpdateFiltered = filteredPreviewDeliveries.filter((d) => d.action === 'update');

      console.log(`📤 [RouteImport] Batch updating AM/PM for ${deliveriesToCreateFiltered.length} deliveries to create...`);
      batchUpdateAMPM(deliveriesToCreateFiltered);
      console.log(`📤 [RouteImport] Batch updating AM/PM for ${deliveriesToUpdateFiltered.length} deliveries to update...`);
      batchUpdateAMPM(deliveriesToUpdateFiltered);

      // BATCH CREATE: Use bulkCreate for new deliveries (much faster than individual creates)
      if (deliveriesToCreateFiltered.length > 0) {
        setImportProgress((prev) => ({
          ...prev,
          phase: 'creating',
          total: deliveriesToCreateFiltered.length,
          current: 0
        }));
        setProgressMessage(`Creating ${deliveriesToCreateFiltered.length} new deliveries using batch insert...`);

        // Clean all deliveries for batch creation
        const cleanedDeliveries = deliveriesToCreateFiltered.map(cleanDeliveryData);

        // Batch create in chunks of 50 to avoid API limits
        const BATCH_SIZE = 50;
        const batches = [];
        for (let i = 0; i < cleanedDeliveries.length; i += BATCH_SIZE) {
          batches.push(cleanedDeliveries.slice(i, i + BATCH_SIZE));
        }

        console.log(`📤 [RouteImport] Creating ${cleanedDeliveries.length} deliveries in ${batches.length} batch(es) of up to ${BATCH_SIZE}...`);

        let totalCreated = 0;
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          const batch = batches[batchIndex];
          try {
            console.log(`📤 [RouteImport] Batch ${batchIndex + 1}/${batches.length}: Creating ${batch.length} deliveries...`);
            
            await retryWithBackoff(async () => {
              await base44.entities.Delivery.bulkCreate(batch);
            }, 3, 1000, 2);

            // Count successful creates
            batch.forEach((cleanData) => {
              overallResults.created++;
              overallResults.completed++;
              if (cleanData.status === 'returned' || isReturnDelivery(cleanData, freshPatients, freshStores)) {
                overallResults.returned++;
              }
            });

            totalCreated += batch.length;
            setImportProgress((prev) => ({
              ...prev,
              created: totalCreated,
              current: totalCreated
            }));

            console.log(`✅ [RouteImport] Batch ${batchIndex + 1} complete: ${batch.length} deliveries created`);
            
            // Small delay between batches
            if (batchIndex < batches.length - 1) {
              await delay(500);
            }
          } catch (error) {
            console.warn(`⚠️ Batch ${batchIndex + 1} failed, falling back to individual creates:`, error.message);
            
            // Fallback: try individual creates for this batch
            for (const cleanData of batch) {
              try {
                await base44.entities.Delivery.create(cleanData);
                overallResults.created++;
                overallResults.completed++;
                if (cleanData.status === 'returned' || isReturnDelivery(cleanData, freshPatients, freshStores)) {
                  overallResults.returned++;
                }
                totalCreated++;
                setImportProgress((prev) => ({
                  ...prev,
                  created: totalCreated,
                  current: totalCreated
                }));
                await delay(100);
              } catch (individualError) {
                console.warn(`⚠️ Individual create failed for ${cleanData.delivery_id || 'unknown'}:`, individualError.message);
                failedCreations.push({ data: cleanData, error: individualError.message });
                
                // Check for Invalid time value error and show detailed popup
                if (individualError.message && individualError.message.includes('Invalid time value')) {
                  setImportError({
                    message: `Invalid time value error`,
                    record: {
                      driver: cleanData.driver_name || 'Unknown',
                      date: cleanData.delivery_date || 'Unknown',
                      store: freshStores.find(s => s.id === cleanData.store_id)?.name || cleanData.store_id || 'Unknown',
                      patient: cleanData.patient_name || 'Store Pickup',
                      stopId: cleanData.stop_id || 'N/A',
                      trackingNumber: cleanData.tracking_number || 'N/A',
                      time: cleanData.actual_delivery_time || 'N/A',
                      deliveryId: cleanData.delivery_id || 'N/A'
                    },
                    lineNumber: null,
                    phase: 'create'
                  });
                  throw new Error(`Import stopped due to invalid time value. See error details.`);
                }
              }
            }
          }
        }
      }

      // Updates still need to be individual (no bulk update API for different records)
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

            console.log(`🔄 [RouteImport] Updating delivery ${i + 1}/${deliveriesToUpdateFiltered.length}: ${cleanPayload.patient_name || 'Store Pickup'}`);
            await base44.entities.Delivery.update(id, cleanPayload);

            overallResults.updated++;
            overallResults.completed++;
            if (cleanPayload.status === 'returned' || isReturnDelivery(cleanPayload, freshPatients, freshStores)) {
              overallResults.returned++;
            }
            setImportProgress((prev) => ({
              ...prev,
              updated: prev.updated + 1,
              current: i + 1
            }));
            await delay(100);
          } catch (error) {
            console.warn(`⚠️ Update failed for delivery ID ${deliveryData.id}, will retry later:`, error.message);
            failedUpdates.push({ data: deliveryData, error: error.message });
            setImportProgress((prev) => ({ ...prev, current: i + 1 }));
            
            // Check for Invalid time value error and show detailed popup
            if (error.message && error.message.includes('Invalid time value')) {
              setImportError({
                message: `Invalid time value error`,
                record: {
                  driver: deliveryData.driver_name || 'Unknown',
                  date: deliveryData.delivery_date || 'Unknown',
                  store: freshStores.find(s => s.id === deliveryData.store_id)?.name || deliveryData.store_id || 'Unknown',
                  patient: deliveryData.patient_name || 'Store Pickup',
                  stopId: deliveryData.stop_id || 'N/A',
                  trackingNumber: deliveryData.tracking_number || 'N/A',
                  time: deliveryData.actual_delivery_time || 'N/A',
                  deliveryId: deliveryData.delivery_id || deliveryData.id || 'N/A'
                },
                lineNumber: null,
                phase: 'update'
              });
              throw new Error(`Import stopped due to invalid time value. See error details.`);
            }
            await delay(300);
          }
        }
      }

      // Retry failed operations
      const totalFailed = failedCreations.length + failedUpdates.length;
      if (totalFailed > 0) {
        console.log(`🔄 [RouteImport] Retrying ${totalFailed} failed operations (${failedCreations.length} creates, ${failedUpdates.length} updates)...`);
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
            console.log(`🔄 [RouteImport] Retrying create ${i + 1}/${failedCreations.length}: ${cleanData.patient_name || 'Store Pickup'}`);

            await retryWithBackoff(async () => {
              await base44.entities.Delivery.create(cleanData);
            }, 5, 500, 1.5);

            overallResults.created++;
            overallResults.completed++;
            if (cleanData.status === 'returned' || isReturnDelivery(cleanData, freshPatients, freshStores)) {
              overallResults.returned++;
            }
            setImportProgress((prev) => ({
              ...prev,
              created: prev.created + 1,
              current: i + 1
            }));
            console.log(`✅ [RouteImport] Retry successful for ${cleanData.patient_name || 'Store Pickup'}`);
          } catch (error) {
            console.error(`❌ Retry failed for delivery ${cleanData.delivery_id || 'unknown'}:`, error);
            overallResults.errors.push(`Failed to create ${cleanData.patient_name || 'Store Pickup'} (${cleanData.delivery_id || 'no ID'}): ${error.message}`);
            overallResults.failed++;
            setImportProgress((prev) => ({ ...prev, errors: prev.errors + 1, current: i + 1 }));
          }
          await delay(200);
        }

        const failedUpdateOffset = failedCreations.length;
        for (let i = 0; i < failedUpdates.length; i++) {
          const { data: deliveryData } = failedUpdates[i];
          const { id, _changes, action, _matchReason, ...updatePayload } = deliveryData;

          try {
            if (!id) {
              throw new Error('Missing delivery ID');
            }

            console.log(`🔄 [RouteImport] Retrying update ${i + 1}/${failedUpdates.length}: ${updatePayload.patient_name || 'Store Pickup'}`);

            await retryWithBackoff(async () => {
              await base44.entities.Delivery.update(id, cleanDeliveryData(updatePayload));
            }, 5, 500, 1.5);

            overallResults.updated++;
            overallResults.completed++;
            if (updatePayload.status === 'returned' || isReturnDelivery(updatePayload, freshPatients, freshStores)) {
              overallResults.returned++;
            }
            setImportProgress((prev) => ({
              ...prev,
              updated: prev.updated + 1,
              current: failedUpdateOffset + i + 1
            }));
            console.log(`✅ [RouteImport] Retry successful for ${updatePayload.patient_name || 'Store Pickup'}`);
          } catch (error) {
            console.error(`❌ Retry failed for delivery ID ${id}:`, error);
            overallResults.errors.push(`Failed to update ${deliveryData.patient_name || 'Store Pickup'} (ID ${id}): ${error.message}`);
            overallResults.failed++;
            setImportProgress((prev) => ({ ...prev, errors: prev.errors + 1, current: failedUpdateOffset + i + 1 }));
          }
          await delay(200);
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
          driver: availableDrivers.find(d => d.id === selectedDriverId)?.user_name || 'Unknown',
          files: files.map(f => f.name).join(', '),
          created: overallResults.created,
          updated: overallResults.updated
        },
        lineNumber: null,
        phase: 'import'
      });
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
      'pending': 'bg-yellow-100 text-yellow-800',
      'Ready For Pickup': 'bg-purple-100 text-purple-800',
      'returned': 'bg-orange-100 text-orange-800',
      'picked_up': 'bg-indigo-100 text-indigo-800'
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
                    {importError.record.driver && (
                      <>
                        <span className="text-slate-600">Driver:</span>
                        <span className="font-medium">{importError.record.driver}</span>
                      </>
                    )}
                    {importError.record.date && (
                      <>
                        <span className="text-slate-600">Date:</span>
                        <span className="font-medium">{importError.record.date}</span>
                      </>
                    )}
                    {importError.record.store && (
                      <>
                        <span className="text-slate-600">Store:</span>
                        <span className="font-medium">{importError.record.store}</span>
                      </>
                    )}
                    {importError.record.patient && (
                      <>
                        <span className="text-slate-600">Patient:</span>
                        <span className="font-medium">{importError.record.patient}</span>
                      </>
                    )}
                    {importError.record.stopId && importError.record.stopId !== 'N/A' && (
                      <>
                        <span className="text-slate-600">Stop ID:</span>
                        <span className="font-medium font-mono">{importError.record.stopId}</span>
                      </>
                    )}
                    {importError.record.trackingNumber && importError.record.trackingNumber !== 'N/A' && (
                      <>
                        <span className="text-slate-600">TR#:</span>
                        <span className="font-medium font-mono">{importError.record.trackingNumber}</span>
                      </>
                    )}
                    {importError.record.time && importError.record.time !== 'N/A' && (
                      <>
                        <span className="text-slate-600">Time Value:</span>
                        <span className="font-medium font-mono text-red-600">{importError.record.time}</span>
                      </>
                    )}
                    {importError.record.deliveryId && importError.record.deliveryId !== 'N/A' && (
                      <>
                        <span className="text-slate-600">Delivery ID:</span>
                        <span className="font-medium font-mono text-xs">{importError.record.deliveryId}</span>
                      </>
                    )}
                    {importError.record.files && (
                      <>
                        <span className="text-slate-600">Files:</span>
                        <span className="font-medium text-xs">{importError.record.files}</span>
                      </>
                    )}
                    {importError.record.created !== undefined && (
                      <>
                        <span className="text-slate-600">Created before error:</span>
                        <span className="font-medium">{importError.record.created}</span>
                      </>
                    )}
                    {importError.record.updated !== undefined && (
                      <>
                        <span className="text-slate-600">Updated before error:</span>
                        <span className="font-medium">{importError.record.updated}</span>
                      </>
                    )}
                  </div>
                </div>
              )}
              
              {importError.lineNumber && (
                <div className="text-sm text-slate-600">
                  <span className="font-medium">Line Number:</span> {importError.lineNumber}
                </div>
              )}
            </div>
            
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex gap-3">
              <Button 
                onClick={handleErrorStartOver} 
                className="flex-1 bg-blue-600 hover:bg-blue-700"
              >
                Start Over
              </Button>
              <Button 
                onClick={handleErrorCancel} 
                variant="outline"
                className="flex-1"
              >
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
        <DialogContent className="fixed left-[50%] top-[50%] z-[10001] translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background shadow-lg duration-200 sm:rounded-lg w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 py-2 text-center flex flex-col space-y-1.5 sm:text-left border-b border-slate-200 flex-shrink-0">
          <DialogTitle className="text-2xl flex items-center gap-2">
            <Upload className="w-6 h-6" />
            Import Route Data
          </DialogTitle>
          <DialogDescription>
            Upload CSV files to import delivery routes for a selected driver.
          </DialogDescription>
        </DialogHeader>

        {showProgress &&
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
            <div className="flex justify-between text-xs text-slate-600">
                <span>Created: {importProgress.created}</span>
                <span>Updated: {importProgress.updated}</span>
                <span>Errors: {importProgress.errors}</span>
              </div>
            }
          </div>
          }

        {!showPreview ?
          <div className="flex-1 overflow-y-auto p-6">
            <div className="space-y-6">
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
                      disabled={isParsing || isProcessing || showProgress} />

                    <p className="text-xs text-slate-500">Select multiple route files to import.</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="driver-select">Select Driver *</Label>
                    <Select value={selectedDriverId} onValueChange={setSelectedDriverId} disabled={isParsing || isProcessing || showProgress}>
                      <SelectTrigger id="driver-select" className="w-full">
                        <SelectValue placeholder="Choose a driver..." />
                      </SelectTrigger>
                      <SelectContent className="z-[10002]">
                        {availableDrivers.length > 0 ?
                        availableDrivers.map((driver) =>
                        <SelectItem key={driver.id} value={driver.id}>
                              {getDriverDisplayName(driver)}
                            </SelectItem>
                        ) :
                        <SelectItem value="none" disabled>
                            No drivers available
                          </SelectItem>
                        }
                      </SelectContent>
                    </Select>
                    {availableDrivers.length === 0 &&
                    <p className="text-xs text-red-600">
                        No drivers found. Please ensure users have the 'driver' or 'admin' role assigned.
                      </p>
                    }
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
                  <h4 className="font-semibold mb-2">CSV Format</h4>
                  <ul className="list-disc list-inside space-y-1">
                    <li>Date metadata: <code className="font-mono">#YYYY-MM-DD#,TotalDeliveries,...</code></li>
                    <li>Positional data (no headers): <code className="font-mono">Store Abbr (col 1), AM/PM (col 2), TR# (col 3), Stop Order (col 4), ?, Time (col 6), ..., COD Total (col 10), ..., SID (col 13), PID (col 14), ?, Notes (col 16)</code></li>
                    <li>Matching by Stop ID (SID) + Date for updates.</li>
                    <li>PUIDs auto-assigned by matching pickups to patient deliveries.</li>
                  </ul>
                </div>
              </div>

              {files.length > 0 &&
              <div className="space-y-2">
                  <Label className="text-sm font-medium">Selected Files ({files.length})</Label>
                  <div className="space-y-1 max-h-32 overflow-y-auto border rounded-lg p-2">
                    {files.map((file, index) =>
                  <div key={index} className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded text-sm">
                        <span className="truncate flex-1">{file.name}</span>
                        {!isParsing && !isProcessing && !showProgress &&
                    <button onClick={() => removeFile(index)} className="ml-2 text-slate-400 hover:text-red-600">
                            <X className="w-4 h-4" />
                          </button>
                    }
                      </div>
                  )}
                  </div>
                </div>
              }

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
            <div className="flex-shrink-0 p-6 pb-4">
              <div className="flex items-center justify-between gap-4 mb-4">
                <div className="flex flex-col">
                  <span className="text-sm text-slate-500">Importing for: <span className="font-semibold text-slate-700">{availableDrivers.find(d => d.id === selectedDriverId)?.user_name || availableDrivers.find(d => d.id === selectedDriverId)?.full_name || 'Unknown Driver'}</span></span>
                  <h3 className="text-lg font-semibold text-slate-800">Preview: {filteredPreviewDeliveries.length} Total Deliveries ({previewData.skippedItems.length} Skipped)</h3>
                </div>
                <div className="flex items-center gap-3">
                  <Select value={previewFilterDate} onValueChange={setPreviewFilterDate}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Filter by date" />
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

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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

            <div className="flex flex-col items-center bg-red-50 border border-red-200 rounded-lg p-3">
                <div className="text-xs text-red-700 mb-1">Failed/Returned</div>
                <div className="text-2xl font-bold text-red-800">
                {previewStats.failed}/{previewStats.returned}
                </div>
            </div>

            {previewData.skippedItems.length > 0 && (
                <div className="flex flex-col items-center bg-orange-50 border border-orange-200 rounded-lg p-3">
                <div className="text-xs text-orange-700 mb-1">Skipped Items</div>
                <div className="text-2xl font-bold text-orange-800">{previewStats.skipped}</div>
                </div>
            )}
            </div>  
          </div>

            {filteredPreviewDeliveries.length === 0 ?
            <div className="text-center text-slate-500 py-8 flex-1 flex items-center justify-center px-6">
                No deliveries detected for import or matching filters.
              </div> :

            <div className="flex-1 border rounded-lg flex flex-col overflow-hidden bg-white min-h-0">
                <div className="flex-shrink-0 bg-slate-100 border-b">
                  <table className="w-full text-sm table-fixed">
                    <thead>
                      <tr>
                        <th className="p-1 text-left w-20">Type</th>
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
                </div>

                <div className="flex-1 overflow-y-auto min-h-0">
                  <table className="w-full text-sm table-fixed">
                    <tbody>
                      {filteredPreviewDeliveries.map((delivery, idx) => {
                      const store = stores.find((s) => s.id === delivery.store_id);
                      const newTimeFormatted = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : 'none';
                      const patient = delivery.patient_id ? patients.find((p) => p.id === delivery.patient_id) : null;

                      const displayAddress = delivery.patient_id ?
                      formatAddressWithUnit(patient?.address || delivery.delivery_address || '', patient?.unit_number || '') :
                      formatAddressWithUnit(delivery.delivery_address || store?.address || '', delivery.unit_number || '');

                      return (
                        <tr key={`${delivery.action}-${idx}`} className={`border-b ${delivery.action === 'create' ? 'bg-green-50 hover:bg-green-100' : 'bg-blue-50 hover:bg-blue-100'}`}>
                            <td className="p-1 w-20">
                              <Badge className={delivery.action === 'create' ? "bg-green-200 text-green-800" : "bg-blue-200 text-blue-800"}>
                                {delivery.action === 'create' ? 'New' : 'Update'}
                              </Badge>
                            </td>
                            <td className="p-1 w-24">
                              <div className="flex flex-col">
                                <span className="font-medium">{delivery.delivery_date}</span>
                                {newTimeFormatted !== 'none' && <span className="text-xs text-slate-500">{newTimeFormatted}</span>}
                              </div>
                            </td>
                            <td className="p-1 w-12 text-xs font-mono">{delivery.ampm_deliveries || '-'}</td>
                            <td className="p-1 font-mono text-xs w-14">{delivery.stop_order}</td>
                            <td className="p-1 font-mono text-xs w-22">
                              <div className="flex flex-col">
                                <span>{delivery.tracking_number || '-'}</span>
                                {delivery.puid && <span className="text-purple-600 text-[10px]">{delivery.puid}</span>}
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
                              <div className="flex flex-col gap-1">
                                {delivery.patient_id ?
                              <>
                                    <span className="font-medium">{delivery.patient_name}</span>
                                    <span className="text-xs text-slate-600">{displayAddress}</span>
                                  </> :
                              <>
                                    <span className="text-blue-600 font-semibold">{delivery.patient_name || store?.name || 'Store Pickup'}</span>
                                    <span className="text-xs text-slate-600">{displayAddress}</span>
                                  </>
                              }
                              </div>
                            </td>
                            <td className="p-1 w-24">{getStatusBadge(delivery.status)}</td>
                            <td className="p-1 font-mono text-xs w-20">
                              {delivery.cod_total_amount_required > 0 ? (
                                <div className="flex flex-col">
                                  <span className="text-slate-500 text-[10px]">{delivery.cod_payments?.[0]?.type || delivery.cod_payment_type || 'Cash'}</span>
                                  <span className="font-semibold">${delivery.cod_total_amount_required.toFixed(2)}</span>
                                </div>
                              ) : '-'}
                            </td>
                            <td className="p-1 text-xs w-42">
                              <span className="text-slate-600">{delivery.delivery_notes || '-'}</span>
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
                              <span className="text-slate-400">-</span>
                              }
                              </div>
                            </td>
                          </tr>);
                    })}
                    </tbody>
                  </table>
                </div>
              </div>
            }
          </div>
          }

        <div className="bg-white px-6 py-2 flex flex-col gap-3 border-t border-slate-200 flex-shrink-0">
          <div className="flex gap-3">
            {!showPreview ?
              <>
                <Button onClick={handlePreview} disabled={isParsing || isProcessing || files.length === 0 || !selectedDriverId || showProgress}>
                  {isParsing ?
                  <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Parsing...
                    </> :
                  'Preview Import'
                  }
                </Button>
                <Button variant="outline" onClick={onCancel} disabled={isParsing || isProcessing || showProgress}>
                  Cancel
                </Button>
              </> :
              importResult ?
              <>
                  <Button
                  onClick={() => {
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
                  }}
                  variant="outline"
                  className="flex-1">
                    Start New Import
                  </Button>
                  <Button
                  onClick={() => {
                    if (onImportComplete) {
                      onImportComplete();
                    }
                  }}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                    Done - Close Import
                  </Button>
                </> :
              <>
                  <Button variant="outline" onClick={() => setShowPreview(false)} disabled={isProcessing || showProgress} className="flex-1">
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
            <div className="space-y-4 p-6 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
                <h3 className="font-bold text-green-800">Import Complete!</h3>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
              <div className="flex items-center justify-center gap-1">
                <span className="text-slate-700">Created:</span>
                <span className="font-semibold">{importResult.created}</span>
              </div>

              <div className="flex items-center justify-center gap-1">
                <span className="text-slate-700">Updated:</span>
                <span className="font-semibold">{importResult.updated}</span>
              </div>

              <div className="flex items-center justify-center gap-1">
                <span className="text-slate-700">Skipped:</span>
                <span className="font-semibold">{importResult.skipped}</span>
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