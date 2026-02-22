import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Patient } from "@/entities/Patient";
import { Delivery } from "@/entities/Delivery";
import { User } from "@/entities/User";
import { AppUser } from "@/entities/AppUser";
import { Store } from "@/entities/Store";
import { City } from "@/entities/City";
import { getGlobalFilters, updateGlobalFilter, setGlobalFilters } from '../components/utils/filterState';
import { getEffectiveUser } from "../components/utils/auth";
import { userHasRole, isAppOwner, canAccessImports } from '../components/utils/userRoles';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { createPageUrl } from "@/utils";
import { getStoreColor, hexToRgba } from "@/components/utils/colorGenerator";
import {
  Search,
  Plus,
  Users,
  Upload,
  X,
  UserPlus,
  Filter,
  User as UserIcon,
  Loader2 } from
"lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { format, addDays, differenceInCalendarDays, getDay, isSameDay, startOfWeek, addWeeks, addMonths, subWeeks, subMonths } from "date-fns";

import PatientCard from "../components/patients/PatientCard";
import PatientForm from "../components/patients/PatientForm";
import PatientDetails from "../components/patients/PatientDetails";
import PatientImport from "../components/patients/PatientImport";
import DeliveryForm from "../components/deliveries/DeliveryForm";
import { getData, invalidate } from "../components/utils/dataManager";
import { sortStores, sortUsers, sortCities } from "../components/utils/sorting";
import { getDriverDisplayName, mergeUsersWithAppUsers } from '../components/utils/driverUtils';
import { formatPhoneNumber } from '../components/utils/phoneFormatter';
import { ResizableDivider } from '../components/ui/resizable-divider';
import { useAppData } from '../components/utils/AppDataContext';
import { getUserAgentInfo } from '../components/utils/deviceUtils';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';

// Helper function to calculate distance between two coordinates (in kilometers)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
  Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
  Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Helper function to parse address and notes for unit number
const parseAddressAndUnit = (address, notes) => {
  let cleanedAddress = address ? String(address).trim() : null;
  let cleanedNotes = notes ? String(notes).trim() : null;
  let unitNumber = null;

  // Prioritize finding unit in address
  if (cleanedAddress) {
    // Regex to find common unit patterns: #123, Unit 123, Apt 123, Suite 123, Ste 123
    const unitRegex = /(?:#|unit|apt|apartment|suite|ste)\s*(\w+)/i;
    const match = cleanedAddress.match(unitRegex);

    if (match && match[1]) {
      unitNumber = match[1].trim();
      // Remove the matched unit part from the address
      cleanedAddress = cleanedAddress.replace(unitRegex, '').trim();
    }
  }

  // If not found in address, try notes
  if (!unitNumber && cleanedNotes) {
    const unitRegex = /(?:#|unit|apt|apartment|suite|ste)\s*(\w+)/i;
    const match = cleanedNotes.match(unitRegex);
    if (match && match[1]) {
      unitNumber = match[1].trim();
      // Remove the matched unit part from the notes
      cleanedNotes = cleanedNotes.replace(unitRegex, '').trim();
    }
  }

  // Further clean up: remove extra spaces, trailing punctuation
  if (cleanedAddress) {
    cleanedAddress = cleanedAddress.replace(/\s\s+/g, ' ').replace(/[,;.]\s*$/, '').trim();
  }
  if (cleanedNotes) {
    cleanedNotes = cleanedNotes.replace(/\s\s+/g, ' ').replace(/[,;.]\s*$/, '').trim();
  }

  return { cleanedAddress, cleanedNotes, unitNumber };
};

// --- ADVANCED PATIENT SORTING LOGIC ---

// Helper to parse keywords from notes (now unused, but kept for context if needed in other files)
const parseSortingKeywords = (notes) => {
  if (!notes) return null;
  const notesLower = notes.toLowerCase();

  // Check for Daily
  const dailyMatch = notesLower.match(/daily/);
  if (dailyMatch) return { type: 'daily' };

  // Check for Weekly patterns
  const weeklyXMatch = notesLower.match(/weekly\s*x\s*(\d+)/);
  if (weeklyXMatch) {
    const weeks = parseInt(weeklyXMatch[1], 10);
    return { type: 'multi-weekly', weeks };
  }

  const weeklyMatch = notesLower.match(/weekly(?:\s*\((.*?)\))?/);
  if (weeklyMatch) {
    const dayStr = weeklyMatch[1] || '';
    const days = dayStr.split(',').map((d) => d.trim().slice(0, 3).toLowerCase()).filter((d) => d);
    return { type: 'weekly', days };
  }

  // Check for Bi-Weekly
  const biWeeklyMatch = notesLower.match(/bi-weekly/);
  if (biWeeklyMatch) return { type: 'multi-weekly', weeks: 2 };

  // Check for Monthly
  const monthlyMatch = notesLower.match(/monthly/);
  if (monthlyMatch) return { type: 'monthly' };

  return null;
};

// Helper to check recurring status from BOOLEAN FIELDS (not notes)
const getRecurringInfo = (patient) => {
  if (!patient) return null;

  // Check boolean fields for recurring patterns
  if (patient.recurring_daily) {
    return { type: 'daily' };
  }

  // Check for weekly patterns
  const weeklyDays = [];
  const dayMap = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']; // Adjusted to match typical 'getDay' order if needed, but here it's about checking boolean fields
  dayMap.forEach((day) => {
    if (patient[`recurring_weekly_${day}`]) {
      weeklyDays.push(day);
    }
  });

  if (weeklyDays.length > 0) {
    return { type: 'weekly', days: weeklyDays };
  }

  if (patient.recurring_biweekly) {
    return { type: 'multi-weekly', weeks: 2 };
  }

  if (patient.recurring_weekly_x4) {
    return { type: 'multi-weekly', weeks: 4 };
  }

  if (patient.recurring_bimonthly) {
    return { type: 'bi-monthly' };
  }

  if (patient.recurring_monthly) {
    return { type: 'monthly' };
  }

  return null;
};

// Get days since last delivery, accounting for null dates
const getDaysSinceLastDelivery = (lastDeliveryDate, today) => {
  if (!lastDeliveryDate) return 99999; // Very high number for no delivery, distinguish from "over 90 days"
  try {
    return differenceInCalendarDays(today, new Date(lastDeliveryDate));
  } catch (e) {
    console.error("Error parsing last_delivery_date:", lastDeliveryDate, e);
    return 99999;
  }
};

// Helper to get an overall priority value for recurring patterns
const getPatientRecurringPriorityValue = (recurringInfo) => {
  if (!recurringInfo) return 999; // Non-recurring gets lowest priority
  switch (recurringInfo.type) {
    case 'daily':
      return 1;
    case 'weekly':
      return 2;
    case 'multi-weekly':
      // Differentiate bi-weekly and weekly x4
      if (recurringInfo.weeks === 2) return 3; // Bi-weekly
      if (recurringInfo.weeks === 4) return 4; // Weekly x4
      return 998; // Fallback for other multi-weekly with specific "weeks" that should still be higher than monthly/bimonthly if present.
    case 'monthly':
      return 5;
    case 'bi-monthly':
      return 6;
    default:
      return 999;
  }
};

// Helper to build day order starting from today's day of week
const getDayOrderFromToday = () => {
  const allDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const todayIndex = getDay(new Date()); // 0 = Sunday, 1 = Monday, etc.
  // Rotate array so today is first
  return [...allDays.slice(todayIndex), ...allDays.slice(0, todayIndex)];
};

// Main sorting function - matches projection engine logic
const sortPatients = (patients) => {
  const today = new Date();
  const dayMapForGetDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const todayDayStr = dayMapForGetDay[getDay(today)];

  // Day order starts from TODAY, not Monday
  const dayOrderFromToday = getDayOrderFromToday();

  return [...patients].sort((a, b) => {
    // PRIORITY 1: Active deliveries (on today's route) to top, sorted by stop_order
    const aOnRoute = a.todayDelivery && ['picked_up', 'in_transit', 'pending'].includes(a.todayDelivery.status);
    const bOnRoute = b.todayDelivery && ['picked_up', 'in_transit', 'pending'].includes(b.todayDelivery.status);

    if (aOnRoute && bOnRoute) {
      return (a.todayDelivery.stop_order || Infinity) - (b.todayDelivery.stop_order || Infinity);
    }
    if (aOnRoute) return -1;
    if (bOnRoute) return 1;

    // PRIORITY 2: Patients with exclusion keywords to bottom
    if (a.displayPriority === 'excluded' && b.displayPriority !== 'excluded') return 1;
    if (a.displayPriority !== 'excluded' && b.displayPriority === 'excluded') return -1;

    // PRIORITY 3: Inactive patients to bottom
    if (a.status === 'inactive' && b.status !== 'inactive') return 1;
    if (a.status !== 'inactive' && b.status === 'inactive') return -1;

    // Get recurring info for both
    const aRecurring = getRecurringInfo(a);
    const bRecurring = getRecurringInfo(b);
    const aDaysSince = getDaysSinceLastDelivery(a.last_delivery_date, today);
    const bDaysSince = getDaysSinceLastDelivery(b.last_delivery_date, today);

    // PRIORITY 4: Recurring patients come before non-recurring
    const aHasRecurring = aRecurring !== null;
    const bHasRecurring = bRecurring !== null;

    if (aHasRecurring && !bHasRecurring) return -1;
    if (!aHasRecurring && bHasRecurring) return 1;

    // PRIORITY 5: Among recurring patients, sort by pattern priority and day of week from today
    if (aHasRecurring && bHasRecurring) {
      // Sort by recurring pattern priority (daily → weekly → bi-weekly → weekly x4 → monthly → bi-monthly)
      const aRecurringPriority = getPatientRecurringPriorityValue(aRecurring);
      const bRecurringPriority = getPatientRecurringPriorityValue(bRecurring);

      if (aRecurringPriority !== bRecurringPriority) {
        return aRecurringPriority - bRecurringPriority;
      }

      // Same recurring type - sort by day of week (starting from today)
      if (aRecurring.type === 'weekly' && bRecurring.type === 'weekly') {
        // Find the nearest scheduled day for each (from today's perspective)
        const aNearestDayIndex = aRecurring.days && aRecurring.days.length > 0 ?
        Math.min(...aRecurring.days.map((day) => dayOrderFromToday.indexOf(day)).filter((i) => i >= 0)) :
        Infinity;
        const bNearestDayIndex = bRecurring.days && bRecurring.days.length > 0 ?
        Math.min(...bRecurring.days.map((day) => dayOrderFromToday.indexOf(day)).filter((i) => i >= 0)) :
        Infinity;

        if (aNearestDayIndex !== bNearestDayIndex) {
          return aNearestDayIndex - bNearestDayIndex;
        }
      }

      // Handle multi-weekly patterns (bi-weekly, weekly x4)
      if (aRecurring.type === 'multi-weekly' && bRecurring.type === 'multi-weekly') {
        const aWeeks = aRecurring.weeks || 2;
        const bWeeks = bRecurring.weeks || 2;

        if (aWeeks !== bWeeks) {
          return aWeeks - bWeeks;
        }

        // Find scheduled days
        let aScheduledDays = [];
        let bScheduledDays = [];
        dayMapForGetDay.forEach((day) => {
          if (a[`recurring_weekly_${day}`]) aScheduledDays.push(day);
          if (b[`recurring_weekly_${day}`]) bScheduledDays.push(day);
        });

        const aNearestDayIndex = aScheduledDays.length > 0 ?
        Math.min(...aScheduledDays.map((day) => dayOrderFromToday.indexOf(day)).filter((i) => i >= 0)) :
        Infinity;
        const bNearestDayIndex = bScheduledDays.length > 0 ?
        Math.min(...bScheduledDays.map((day) => dayOrderFromToday.indexOf(day)).filter((i) => i >= 0)) :
        Infinity;

        if (aNearestDayIndex !== bNearestDayIndex) {
          return aNearestDayIndex - bNearestDayIndex;
        }
      }

      // Within same recurring type and day, sort by most recent delivery (most recent first)
      if (aDaysSince !== bDaysSince) {
        return aDaysSince - bDaysSince; // Lower days since = more recent = comes first
      }
    }

    // PRIORITY 6: Non-recurring patients - sort by most recent delivery first
    if (!aHasRecurring && !bHasRecurring) {
      // Patients with no delivery date go to bottom
      const aHasDate = a.last_delivery_date && a.last_delivery_date !== '';
      const bHasDate = b.last_delivery_date && b.last_delivery_date !== '';

      if (!aHasDate && !bHasDate) {
        return (a.full_name || '').localeCompare(b.full_name || '');
      }
      if (!aHasDate) return 1;
      if (!bHasDate) return -1;

      // Sort by most recent delivery first
      if (aDaysSince !== bDaysSince) {
        return aDaysSince - bDaysSince;
      }
    }

    // PRIORITY 7: Sort by distance from store
    const aDistance = a.distance_from_store || Infinity;
    const bDistance = b.distance_from_store || Infinity;

    if (aDistance !== bDistance) {
      return aDistance - bDistance;
    }

    // PRIORITY 8: Final tiebreaker - alphabetically by name
    return (a.full_name || '').localeCompare(b.full_name || '');
  });
};

// Helper function to determine the primary app role for a user
const getPrimaryRole = (user) => {
  if (!user || !user.app_roles || user.app_roles.length === 0) {
    return 'guest';
  }
  if (user.app_roles.includes('admin')) {
    return 'admin';
  }
  if (user.app_roles.includes('dispatcher')) {
    return 'dispatcher';
  }
  if (user.app_roles.includes('driver')) {
    return 'driver';
  }
  return 'guest'; // Fallback for any other roles not explicitly checked
};

// Store Overview Component
function StoreOverview({ stores, onStoreSelect, allPatients, deliveries, importStats, getAssignedDrivers }) {
  // CRITICAL FIX: Move all hooks to the top
  const today = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);

  const getStoreStats = useCallback((store) => {
    const storePatients = allPatients.filter((p) => p.store_id === store.id);
    const storePatientIds = new Set(storePatients.map((p) => p.id));
    const storeDeliveries = deliveries.filter((d) => storePatientIds.has(d.patient_id) && d.delivery_date === today);

    console.log(`[StoreOverview] ${store.name}: ${storePatients.length} patients, ${storeDeliveries.length} deliveries`);

    // Check for returns - delivery notes containing 'return' or patient address containing 'rtn'
    const isReturn = (delivery) => {
      if (!delivery) return false;
      const patient = allPatients.find((p) => p.id === delivery.patient_id);
      const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      return notesReturn || addressReturn;
    };

    const returnedDeliveries = storeDeliveries.filter((d) => d.status === 'returned' || isReturn(d));
    const failedDeliveries = storeDeliveries.filter((d) => d.status === 'failed' && !isReturn(d));

    return {
      activeRoutes: storeDeliveries.filter((d) => ['picked_up', 'in_transit', 'pending'].includes(d.status)).length,
      completedRoutes: storeDeliveries.filter((d) => d.status === 'delivered' || d.status === 'completed').length,
      failedRoutes: failedDeliveries.length,
      returnedRoutes: returnedDeliveries.length,
      totalRoutes: storeDeliveries.length
    };
  }, [allPatients, deliveries, today]);

  const getStoreImportStats = useCallback((store) => {
    if (!importStats || !importStats.byStore || !store) {
      return { new: 0, updated: 0 };
    }
    return importStats.byStore[store.id] || { new: 0, updated: 0 };
  }, [importStats]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-6 pb-4 flex-shrink-0">
        <h2 className="text-xl font-semibold" style={{ color: 'var(--text-slate-800)' }}>
          Select Store to View Patients
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="card-container" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(275px, 1fr))',
          gap: '1rem',
          justifyContent: 'start'
        }}>
          {stores.map((store) => {
            const stats = getStoreStats(store);
            const driversInfo = getAssignedDrivers(store);
            const storeImportStats = getStoreImportStats(store);

            console.log(`[StoreOverview] Rendering card for ${store.name}: ${store.patientCount} patients`);

            return (
              <Card
                key={store.id} className="rounded-xl border shadow cursor-pointer hover:shadow-md transition-all duration-200"

                style={{
                  background: 'var(--bg-white)',
                  color: 'var(--text-slate-900)',
                  borderColor: store.color || 'var(--border-slate-200)',
                  borderWidth: '2px'
                }}
                onClick={() => {
                  console.log(`[Patients] Clicked store: ${store.name} (${store.id})`);
                  onStoreSelect(store.id);
                }}>

                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-base" style={{ color: 'var(--text-slate-900)' }}>{store.name}</h3>
                        {store.abbreviation &&
                        <Badge
                          variant="outline" className="text-foreground px-2.5 py-0.5 text-xs font-semibold opacity-75 rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"

                          style={{
                            backgroundColor: 'transparent',
                            backgroundImage: store.color ? `linear-gradient(to bottom right, ${store.color}, ${hexToRgba(store.color, 0.8)})` : 'linear-gradient(to bottom right, #10B981, #059669)',
                            color: store.color ? 'white' : '#475569',
                            borderColor: store.color || '#e2e8f0'
                          }}>

                            {store.abbreviation}
                          </Badge>
                        }
                      </div>
                      <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{store.address}</p>
                      <p className="text-sm font-medium" style={{ color: 'var(--text-slate-600)' }}>{store.phone ? formatPhoneNumber(store.phone) : ''}</p>
                    </div>
                    <div className="text-center ml-3">
                      <div className="text-3xl font-bold text-emerald-600 mb-1">
                        {store.patientCount || 0}
                      </div>
                      <div className="text-xs mb-1" style={{ color: 'var(--text-slate-500)' }}>patients</div>
                    </div>
                  </div>
                  <div className="pt-2 mt-2" style={{ borderTop: '1px solid var(--border-slate-100)' }}>
                    {stats.totalRoutes > 0 &&
                    <div className="flex justify-center gap-3 text-xs font-medium flex-wrap">
                        <span className="text-blue-600">Active: {stats.activeRoutes}</span>
                        <span className="text-green-600">Comp: {stats.completedRoutes}</span>
                        <span className="text-red-600">Failed: {stats.failedRoutes}</span>
                        <span className="text-orange-600">Returns: {stats.returnedRoutes}</span>
                      </div>
                    }

                    {/* Driver Assignments - Table Layout */}
                    <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                      <div className="font-semibold mb-1" style={{ color: 'var(--text-slate-700)' }}>Assigned Drivers:</div>
                      <table className="w-full text-xs table-fixed">
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
                            <th className="w-1/3 text-left py-1 pr-2 font-medium" style={{ color: 'var(--text-slate-600)' }}>Day</th>
                            <th className="w-1/3 text-center py-1 px-2 font-medium" style={{ color: 'var(--text-slate-600)' }}>AM</th>
                            <th className="w-1/3 text-center py-1 pl-2 font-medium" style={{ color: 'var(--text-slate-600)' }}>PM</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                          { day: 'Mon-Fri', am: driversInfo.weekdayAM, pm: driversInfo.weekdayPM },
                          { day: 'Saturday', am: driversInfo.saturdayAM, pm: driversInfo.saturdayPM },
                          { day: 'Sunday', am: driversInfo.sundayAM, pm: driversInfo.sundayPM }].
                          map(({ day, am, pm }) =>
                          <tr key={day}>
                                <td className="w-1/3 text-left py-1 pr-2" style={{ color: 'var(--text-slate-700)' }}>{day}</td>
                                <td className="w-1/3 text-center py-1 px-2">
                                  {am !== 'Off' ?
                              <Badge
                                variant="outline" className="text-foreground px-2.5 py-0.5 text-xs font-semibold opacity-75 rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"

                                style={{
                                  backgroundColor: 'transparent',
                                  backgroundImage: store.color ? `linear-gradient(to bottom right, ${store.color}, ${hexToRgba(store.color, 0.8)})` : 'linear-gradient(to bottom right, #10B981, #059669)',
                                  color: store.color ? 'white' : '#475569',
                                  borderColor: store.color || '#e2e8f0',
                                  width: '80px',
                                  display: 'flex',
                                  justifyContent: 'center',
                                  alignItems: 'center'
                                }}>

                                      {am}
                                    </Badge> :

                              'Off'
                              }
                                </td>
                                <td className="w-1/3 text-center py-1 pl-2">
                                  {pm !== 'Off' ?
                              <Badge
                                variant="outline" className="text-foreground px-2.5 py-0.5 text-xs font-semibold opacity-75 rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"

                                style={{
                                  backgroundColor: 'transparent',
                                  backgroundImage: store.color ? `linear-gradient(to bottom right, ${store.color}, ${hexToRgba(store.color, 0.8)})` : 'linear-gradient(to bottom right, #10B981, #059669)',
                                  color: store.color ? 'white' : '#475569',
                                  borderColor: store.color || '#e2e8f0',
                                  width: '80px',
                                  display: 'flex',
                                  justifyContent: 'center',
                                  alignItems: 'center'
                                }}>

                                      {pm}
                                    </Badge> :

                              'Off'
                              }
                                </td>
                              </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* Import Stats - Only shown if there are stats */}
                    {importStats && (storeImportStats.new > 0 || storeImportStats.updated > 0) &&
                    <div className="mt-2 pt-2 flex gap-3 text-xs font-medium" style={{ borderTop: '1px solid var(--border-slate-100)' }}>
                        {storeImportStats.new > 0 &&
                      <span className="text-green-600">
                            New: {storeImportStats.new}
                          </span>
                      }
                        {storeImportStats.updated > 0 &&
                      <span className="text-blue-600">
                            Updated: {storeImportStats.updated}
                          </span>
                      }
                      </div>
                    }
                  </div>
                </CardContent>
              </Card>);

          })}
        </div>
        {stores.length === 0 &&
        <Card className="mt-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardContent className="p-6 text-center" style={{ color: 'var(--text-slate-500)' }}>No stores found for this city.</CardContent>
        </Card>
        }
      </div>
    </div>);

}


export default function Patients() {
  const location = useLocation();
  const navigate = useNavigate();

  // Get data from AppDataContext for real-time updates
  const {
    deliveries: contextDeliveries = [],
    patients: contextPatients = [],
    stores: contextStores = [],
    drivers: contextDrivers = [],
    users: contextUsers = [],
    appUsers: contextAppUsers = [],
    cities: contextCities = [],
    isDataLoaded: contextDataLoaded
  } = useAppData();

  const [allPatients, setAllPatients] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [stores, setStores] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(undefined); // Use undefined to distinguish from null (no user)
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [storeFilter, setStoreFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showPatientForm, setShowPatientForm] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [editingPatient, setEditingPatient] = useState(null);
  const [hasAccess, setHasAccess] = useState(false); // Default to false
  const [showPatientImport, setShowPatientImport] = useState(false);
  const [showDeliveryForm, setShowDeliveryForm] = useState(false);
  const [patientForNewDelivery, setPatientForNewDelivery] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [importStats, setImportStats] = useState(null);
  const [importInProgress, setImportInProgress] = useState(false);

  // NEW: State for patient form callback
  const [patientFormCallback, setPatientFormCallback] = useState(null);

  const [cities, setCities] = useState([]);
  const [selectedCityId, setSelectedCityId] = useState("all");

  // Unfiltered deliveries for patient history (all drivers)
  const [allDriverDeliveries, setAllDriverDeliveries] = useState([]);

  // Add state for right panel width
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const saved = localStorage.getItem('rxdeliver_patients_panel_width');
    return saved ? parseInt(saved, 10) : 440;
  });

  // Add state for header container width tracking
  const [headerElement, setHeaderElement] = useState(null);
  const headerRef = useCallback((node) => {
    if (node !== null) {
      setHeaderElement(node);
    }
  }, []);
  const [headerWidth, setHeaderWidth] = useState(0);
  const [useCompactLayout, setUseCompactLayout] = useState(false);

  // Device detection - memoized to prevent unnecessary re-renders
  const isMobile = useMemo(() => {
    const { deviceType } = getUserAgentInfo();
    console.log(`[Patients - isMobile calculation] deviceType: ${deviceType}, isMobile: ${deviceType === 'Mobile'}`);
    return deviceType === 'Mobile';
  }, []);

  // ALL HOOKS MUST BE CALLED HERE - BEFORE ANY EARLY RETURNS

  // Sync context data to local state for real-time updates
  useEffect(() => {
    if (contextDataLoaded) {
      console.log("🔄 [Patients] Syncing data from AppDataContext");
      console.log(`   contextUsers.length: ${contextUsers.length}, contextAppUsers.length: ${contextAppUsers.length}`);
      console.log(`   contextCities.length: ${contextCities.length}`);

      // Always sync when context updates
      setAllPatients(contextPatients);
      setDeliveries(contextDeliveries);
      setStores(contextStores);
      setDrivers(contextDrivers);
      setCities(contextCities); // CRITICAL: Get cities from Layout via context

      // CRITICAL FIX: Use contextUsers if available, otherwise fall back to contextAppUsers
      const finalUsers = contextUsers.length > 0 ? contextUsers : contextAppUsers;
      console.log(`   Setting allUsers to: ${finalUsers.length} users`);
      setAllUsers(finalUsers);

      // Force refresh of import stats display when data changes
      setImportStats((prev) => prev ? { ...prev, timestamp: new Date() } : null);
    }
  }, [contextDataLoaded, contextPatients, contextDeliveries, contextStores, contextDrivers, contextUsers, contextAppUsers, contextCities]);

  // Fetch ALL deliveries (unfiltered by driver) for patient history calendar
  useEffect(() => {
    const fetchAllDeliveries = async () => {
      if (!hasAccess || !contextDataLoaded) return;

      try {
        const allDeliveries = await getData('Delivery', '-delivery_date');
        setAllDriverDeliveries(allDeliveries || []);
      } catch (error) {
        console.error('[Patients] Error fetching all deliveries:', error);
      }
    };

    fetchAllDeliveries();
  }, [hasAccess, contextDataLoaded]);

  // Wrapped functions in useCallback for stability and to prevent unnecessary re-renders
  // CRITICAL: Use allDriverDeliveries (unfiltered) to show patient's full delivery history
  const getPatientDeliveries = useCallback((patientId) => {
    return allDriverDeliveries.filter((d) => d.patient_id === patientId);
  }, [allDriverDeliveries]);

  const getDeliveryStats = useCallback((patientId) => {
    // This function calculates stats based on the currently loaded 'deliveries' state.
    // It is triggered on every re-render, ensuring counts are up-to-date.
    const patientDeliveries = getPatientDeliveries(patientId);

    if (patientDeliveries.length === 0) {
      return {
        totalDeliveries: 0,
        lastDeliveryDate: null
      };
    }

    const lastDelivery = patientDeliveries.
    filter((d) => d.delivery_date).
    sort((a, b) => new Date(b.delivery_date) - new Date(a.delivery_date))[0];

    // Get most common day - FIX: Add time component to avoid timezone shift
    const dayCounts = patientDeliveries.reduce((acc, d) => {
      try {
        // CRITICAL FIX: Add T12:00:00 to force noon local time, avoiding timezone shifts
        const day = format(new Date(d.delivery_date + 'T12:00:00'), 'EEEE');
        acc[day] = (acc[day] || 0) + 1;
      } catch (e) {/* ignore invalid dates */}
      return acc;
    }, {});

    const mostCommonDay = Object.keys(dayCounts).length > 0 ?
    Object.keys(dayCounts).reduce((a, b) => dayCounts[a] > dayCounts[b] ? a : b) :
    null;

    return {
      totalDeliveries: patientDeliveries.length,
      lastDeliveryDate: lastDelivery ? lastDelivery.delivery_date : null,
      mostCommonDay: mostCommonDay,
      dayFrequency: dayCounts
    };
  }, [getPatientDeliveries]);


  const getStoreOverview = useCallback((cityIdOverride = null) => {
    const currentCityFilter = cityIdOverride !== null ? cityIdOverride : selectedCityId;

    // CRITICAL: Admins see ALL stores regardless of city filter
    let cityStores;
    if (currentUser && userHasRole(currentUser, 'admin')) {
      cityStores = [...stores]; // All stores for admins
    } else {
      cityStores = stores.filter((store) =>
      currentCityFilter === "all" || store.city_id === currentCityFilter
      );
    }

    // Filter stores by dispatcher's assigned stores (non-admins only)
    if (currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      cityStores = cityStores.filter((store) => dispatcherStoreIds.includes(store.id));
    }

    return cityStores.map((store) => {
      const storePatients = allPatients.filter((p) => p.store_id === store.id);

      return {
        ...store,
        patientCount: storePatients.length
      };
    }).sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
  }, [stores, selectedCityId, allPatients, currentUser]);


  const handleStoreOverviewClick = useCallback((storeId) => {
    console.log(`[Patients] handleStoreOverviewClick called with storeId: ${storeId}`);
    setStoreFilter(storeId);

    // Auto-select the store's city
    const selectedStore = stores.find((s) => s.id === storeId);
    if (selectedStore?.city_id) {
      setSelectedCityId(selectedStore.city_id);
    }

    const urlParams = new URLSearchParams(location.search);
    urlParams.set('store', storeId);
    const newUrl = `${location.pathname}?${urlParams.toString()}`;
    console.log(`[Patients] Navigating to: ${newUrl}`);
    navigate(newUrl, { replace: true });
  }, [navigate, location.pathname, location.search, stores]);

  const getStoreName = useCallback((storeId) => {
    const store = stores.find((s) => s.id === storeId);
    return store ? store.name : "Unknown Store";
  }, [stores]);

  const getStorePatientCount = useCallback((storeId) => {
    return allPatients.filter((p) => p.store_id === storeId).length;
  }, [allPatients]);

  const getDistanceFromStore = useCallback((patient) => {
    if (patient.distance_from_store) {
      return patient.distance_from_store;
    }
    if (!patient.store_id || !patient.latitude || !patient.longitude) {
      return null;
    }
    const store = stores.find((s) => s.id === patient.store_id);
    if (!store?.latitude || !store?.longitude) {
      return null;
    }
    return calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
  }, [stores]);

  const getAssignedDriversForStore = useCallback((store) => {
    if (!store) return {
      weekdayAM: 'N/A', weekdayPM: 'N/A',
      saturdayAM: 'N/A', saturdayPM: 'N/A',
      sundayAM: 'N/A', sundayPM: 'N/A'
    };

    // Helper to find driver by ID and return their display name
    const getDriverName = (driverId, fallbackName, isEnabled) => {
      // If disabled, return 'Off'
      if (isEnabled === false) return 'Off';

      if (driverId && allUsers && allUsers.length > 0) {
        // CRITICAL FIX: Match against both id (for merged users) and user_id (for AppUser records)
        const driver = allUsers.find((d) => d && (d.id === driverId || d.user_id === driverId));
        if (driver) {
          return getDriverDisplayName(driver);
        }
      }

      // Fallback to legacy name field if ID not found
      if (fallbackName) {
        const driver = allUsers.find((d) => d && d.full_name === fallbackName);
        if (driver) {
          return getDriverDisplayName(driver);
        }
        return fallbackName;
      }

      return 'N/A';
    };

    return {
      weekdayAM: getDriverName(store.weekday_am_driver_id, store.driver_weekday_am, store.weekday_am_enabled),
      weekdayPM: getDriverName(store.weekday_pm_driver_id, store.driver_weekday_pm, store.weekday_pm_enabled),
      saturdayAM: getDriverName(store.saturday_am_driver_id, store.driver_saturday_am, store.saturday_am_enabled),
      saturdayPM: getDriverName(store.saturday_pm_driver_id, store.driver_saturday_pm, store.saturday_pm_enabled),
      sundayAM: getDriverName(store.sunday_am_driver_id, store.sunday_am_am, store.sunday_am_enabled),
      sundayPM: getDriverName(store.sunday_pm_driver_id, store.sunday_pm_pm, store.sunday_pm_enabled)
    };
  }, [allUsers]);

  // Initial user authentication and access check.
  // This useEffect will run once to establish currentUser and hasAccess.
  useEffect(() => {
    const initUserAndAccess = async () => {
      // Keep isLoading true initially until access is determined AND context data is loaded.
      const fetchedUser = await getEffectiveUser();
      setCurrentUser(fetchedUser); // Setting currentUser will trigger the next useEffect.

      if (!fetchedUser) {
        console.warn("No user found, access denied");
        setHasAccess(false);
        // If no user, isLoading will eventually be set to false by the combined effect.
        return;
      }

      console.log(`🔑 [Patients] === USER ROLE CHECK ===`);
      console.log(`   User: ${getDriverDisplayName(fetchedUser)}`);
      console.log(`   Platform role: ${fetchedUser.role}`);
      console.log(`   App roles (array): ${JSON.stringify(fetchedUser.app_roles)}`);
      console.log(`   Primary app role: ${getPrimaryRole(fetchedUser)}`);
      console.log(`   ✅ IS APP OWNER (dual admin check via function): ${isAppOwner(fetchedUser)}`);

      if (userHasRole(fetchedUser, 'admin') || userHasRole(fetchedUser, 'dispatcher')) {
        console.log("✅ [Patients] Admin/Dispatcher access granted");
        setHasAccess(true);
        // Cities will be loaded from AppDataContext - no need to fetch here
      } else {
        const isDriverOnly = userHasRole(fetchedUser, 'driver') &&
        !userHasRole(fetchedUser, 'admin') &&
        !userHasRole(fetchedUser, 'dispatcher');
        if (isDriverOnly) {
          console.log("❌ [Patients] Driver-only user, access denied");
          setHasAccess(false);
        } else {
          console.log("❌ [Patients] User role not explicitly granted access, denying by default.");
          setHasAccess(false);
        }
        setCities([]); // No cities for unauthorized users or drivers
      }
    };

    initUserAndAccess();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        // Close all possible overlays/forms and clear search
        setSearchTerm("");
        setShowPatientForm(false);
        setSelectedPatient(null);
        setEditingPatient(null);
        setShowPatientImport(false);
        setShowDeliveryForm(false);
        setPatientForNewDelivery(null);
        setShowDeleteConfirm(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []); // Runs only once on mount

  // Combined useEffect for final isLoading state
  useEffect(() => {
    // isLoading remains true until all conditions are met or access is definitively denied.
    if (currentUser === undefined) {// Still waiting for initUserAndAccess to run
      setIsLoading(true);
    } else if (!hasAccess) {// Access denied after initUserAndAccess
      setIsLoading(false);
    } else if (hasAccess && contextDataLoaded && cities.length > 0) {// All good, data and access ready
      setIsLoading(false);
    }
    // If hasAccess is true but contextDataLoaded is false, or cities are not yet loaded, isLoading remains true.
  }, [currentUser, hasAccess, contextDataLoaded, cities]);

  // Effect to read store filter from URL query parameters and update state
  // ALSO: Auto-redirect dispatchers to their first assigned store (bypass Store Overview)
  useEffect(() => {
    const urlParams = new URLSearchParams(location.search);
    const storeIdFromQuery = urlParams.get('store');

    if (storeIdFromQuery && storeFilter !== storeIdFromQuery) {
      setStoreFilter(storeIdFromQuery);
    } else if (!storeIdFromQuery && storeFilter !== "all") {
      setStoreFilter("all");
    }

    // Auto-select store for dispatchers when no store is in URL
    if (!storeIdFromQuery && currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (dispatcherStoreIds.length > 0) {
        // Pick the first assigned store and navigate directly to it
        const firstStoreId = dispatcherStoreIds[0];
        const newParams = new URLSearchParams(location.search);
        newParams.set('store', firstStoreId);
        navigate(`${location.pathname}?${newParams.toString()}`, { replace: true });
      }
    }
  }, [location.search, currentUser]);

  // New useEffect to handle auto-selection of city once data is loaded
  useEffect(() => {
    // Only run if cities are loaded, current user is available, and no city has been manually selected yet.
    if (cities.length > 0 && currentUser && selectedCityId === "all") {
      // 1. If user has a city_id set in their profile, use that first
      if (currentUser.city_id) {
        setSelectedCityId(currentUser.city_id);
        return;
      }

      // 2. Fallback to first city if no city_id is set for the user or if geolocation is not used
      if (cities.length > 0) {
        setSelectedCityId(cities[0].id);
      }
    }
  }, [cities, currentUser, selectedCityId]);

  // Add ResizeObserver to track header width and dynamically calculate layout
  useEffect(() => {
    console.log(`[Patients - ResizeObserver useEffect] Starting... isMobile: ${isMobile}, headerElement exists: ${!!headerElement}`);

    if (!headerElement) {
      console.log(`[Patients - ResizeObserver useEffect] headerElement is null, exiting`);
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        setHeaderWidth(width);

        // Simple two-rule breakpoint logic:
        // Rule 1: isMobile = true, OR
        // Rule 2: Screen width < 840px
        const shouldBeCompact = isMobile || width < 840;
        console.log(`[Patients - ResizeObserver] isMobile: ${isMobile}, width: ${width}, shouldBeCompact: ${shouldBeCompact}`);
        setUseCompactLayout(shouldBeCompact);
      }
    });

    resizeObserver.observe(headerElement);
    console.log(`[Patients - ResizeObserver] Observer attached successfully`);

    return () => {
      resizeObserver.disconnect();
    };
  }, [headerElement, isMobile]);

  // Memoized filtered patients - MOVED EARLIER TO FIX INITIALIZATION ERROR
  const filteredPatients = useMemo(() => {
    let availablePatients = allPatients || [];

    // SIMPLIFIED: Dispatcher filtering by store_id only
    if (currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (dispatcherStoreIds.length > 0) {
        availablePatients = availablePatients.filter((p) => {
          return p && p.store_id && dispatcherStoreIds.includes(p.store_id);
        });
      } else {
        // If dispatcher has no assigned stores, show nothing
        availablePatients = [];
      }
    }

    // Apply search filter
    if (searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase();
      availablePatients = availablePatients.filter((patient) => {
        if (!patient) return false;
        const searchFields = [
        patient.full_name,
        patient.address,
        patient.phone,
        patient.patient_id,
        patient.notes];

        return searchFields.some((field) => field && String(field).toLowerCase().includes(searchLower));
      });
    }

    // Apply city filter - applies to ALL users (admins included)
    if (selectedCityId !== "all") {
      const storesInSelectedCity = new Set(stores.filter((s) => s.city_id === selectedCityId).map((s) => s.id));
      availablePatients = availablePatients.filter((p) => p && storesInSelectedCity.has(p.store_id));
    }

    // Apply store filter
    if (storeFilter && storeFilter !== 'all') {
      availablePatients = availablePatients.filter((p) => p && p.store_id === storeFilter);
    }

    // Apply status filter
    if (statusFilter && statusFilter !== 'all') {
      availablePatients = availablePatients.filter((p) => p && p.status === statusFilter);
    }

    return availablePatients.map((patient) => ({
      ...patient,
      // Enrich patient object with last_delivery_date if not already present
      last_delivery_date: getDeliveryStats(patient.id).lastDeliveryDate
    }));
  }, [allPatients, searchTerm, storeFilter, statusFilter, selectedCityId, stores, getDeliveryStats, currentUser]);


  // Augment filteredPatients with today's delivery info and display priority
  const patientsWithDeliveryInfoAndPriority = useMemo(() => {
    const today = format(new Date(), 'yyyy-MM-dd');
    // Filter for deliveries that are for today and are still 'active' (not yet delivered/cancelled)
    const todayActiveDeliveries = deliveries.filter((d) => d.delivery_date === today && ['pending', 'picked_up', 'in_transit'].includes(d.status));

    const getPatientScoreForDisplayPriority = (patient, recurringInfo, daysSince) => {
      // High scores here indicate lower display priority
      // This is a simplified version just for display badges, not the full sorting logic
      if (daysSince >= 99999) return 450; // No last delivery date, very low priority

      if (!recurringInfo) {
        if (daysSince >= 28) return 50;
        if (daysSince >= 14) return 60;
        if (daysSince >= 7) return 70;
        return 80;
      }

      switch (recurringInfo.type) {
        case 'daily':
          return daysSince <= 14 ? 0 : 400;
        case 'weekly':
          const dayMapForGetDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
          const todayDayStr = dayMapForGetDay[getDay(new Date())];
          if (recurringInfo.days.includes(todayDayStr)) {
            return daysSince <= 14 ? 10 : 400;
          }
          return 300;
        case 'multi-weekly':
          if (patient.last_delivery_date) {
            const lastDeliveryDate = new Date(patient.last_delivery_date);
            const nextDue = addWeeks(lastDeliveryDate, recurringInfo.weeks);
            const daysUntilDue = differenceInCalendarDays(nextDue, new Date());
            if (daysUntilDue <= 3 && daysUntilDue >= -3) {
              return daysSince <= recurringInfo.weeks * 7 + 7 ? 20 : 400;
            }
          }
          return 350;
        case 'bi-monthly':
          if (patient.last_delivery_date) {
            const lastDeliveryDate = new Date(patient.last_delivery_date);
            const nextDue = addMonths(lastDeliveryDate, 2);
            const daysUntilDue = differenceInCalendarDays(nextDue, new Date());
            if (daysUntilDue <= 7 && daysUntilDue >= -7) {
              return daysSince <= 90 ? 25 : 400;
            }
          }
          return 370;
        case 'monthly':
          if (patient.last_delivery_date) {
            const lastDeliveryDate = new Date(patient.last_delivery_date);
            const nextDue = addMonths(lastDeliveryDate, 1);
            const daysUntilDue = differenceInCalendarDays(nextDue, new Date());
            if (daysUntilDue <= 3 && daysUntilDue >= -3) {
              return daysSince <= 60 ? 30 : 400;
            }
          }
          return 380;
        default:
          return 500;
      }
    };


    return filteredPatients.map((patient) => {
      const patientTodayDelivery = todayActiveDeliveries.find((d) => d.patient_id === patient.id);
      const daysSince = getDaysSinceLastDelivery(patient.last_delivery_date, new Date());
      const recurring = getRecurringInfo(patient);

      let displayPriority = 'normal';

      // If patient is on an active route today, this is highest priority for display
      if (patientTodayDelivery) {
        displayPriority = 'on_route';
      } else if (patient.status === 'inactive') {
        displayPriority = 'inactive';
      } else {
        // Derive priority from the sorting score logic, but simplified for display
        const score = getPatientScoreForDisplayPriority(patient, recurring, daysSince);
        if (score <= 30) {
          displayPriority = 'urgent';
        } else if (daysSince >= 28) {
          displayPriority = 'overdue';
        } else if (daysSince >= 14) {
          displayPriority = 'due_soon';
        } else if (score >= 300) {
          displayPriority = 'low';
        }
      }

      // Negative keywords (deceased, old, moved, wrong, do not deliver) are the absolute lowest display priority
      const negativeKeywords = ['deceased', 'old', 'moved', 'wrong', 'do not deliver'];
      const patientDataString = [patient.full_name, patient.address, patient.notes].filter(Boolean).join(' ').toLowerCase();
      if (negativeKeywords.some((kw) => patientDataString.includes(kw))) {
        displayPriority = 'excluded';
      }

      // Calculate distance for sorting and display
      const distanceFromStore = getDistanceFromStore(patient);

      return {
        ...patient,
        todayDelivery: patientTodayDelivery,
        displayPriority: displayPriority,
        distance_from_store: distanceFromStore // Add the calculated distance here
      };
    });
  }, [filteredPatients, deliveries, getDistanceFromStore]);


  const handleSaveDelivery = useCallback(async (deliveryData) => {
    const { createDeliveryLocal } = await import('../components/utils/offlineMutations');
    const trackingNumber = `DLV${Date.now()}`;
    try {
      await createDeliveryLocal({ ...deliveryData, tracking_number: trackingNumber });
      invalidate('Delivery'); // Invalidate Delivery cache
      invalidate('Patient'); // Invalidate Patient cache as last_delivery_date might change
      setShowDeliveryForm(false);
      setPatientForNewDelivery(null);
    } catch (error) {
      console.error("Error creating delivery:", error);
      alert("Failed to schedule delivery.");
      throw error;
    }
  }, []);

  const handleAddToRoute = useCallback((patient) => {
    const store = stores.find((s) => s.id === patient.store_id);
    if (!store) {
      setPatientForNewDelivery(patient);
      setShowDeliveryForm(true);
      return;
    }

    // Use the suggested date from the patient card if provided
    const suggestedDate = patient.suggestedDate || (() => {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const currentTotalMinutes = currentHour * 60 + currentMinute;
      const currentDay = now.getDay();
      const isWeekend = currentDay === 0 || currentDay === 6;

      let latestPickupTime = null;
      if (isWeekend) {
        if (store.weekend_pm_enabled && store.weekend_pm_end) {
          latestPickupTime = store.weekend_pm_end;
        } else if (store.weekend_am_enabled && store.weekend_am_end) {
          latestPickupTime = store.weekend_am_end;
        }
      } else {
        if (store.weekday_pm_enabled && store.weekday_pm_end) {
          latestPickupTime = store.weekday_pm_end;
        } else if (store.weekday_am_enabled && store.weekday_am_end) {
          latestPickupTime = store.weekday_am_end;
        }
      }

      let isAfterPickup = false;
      if (latestPickupTime) {
        const [pickupHour, pickupMinute] = latestPickupTime.split(':').map(Number);
        const pickupTotalMinutes = pickupHour * 60 + pickupMinute;
        isAfterPickup = currentTotalMinutes > pickupTotalMinutes;
      }

      const isAfter6PM = currentHour >= 18;

      if (isAfterPickup || isAfter6PM) {
        const nextDay = new Date(now);
        nextDay.setDate(now.getDate() + 1);
        return format(nextDay, 'yyyy-MM-dd');
      } else {
        return format(now, 'yyyy-MM-dd');
      }
    })();

    setPatientForNewDelivery({
      ...patient,
      suggestedDate: suggestedDate
    });

    setShowDeliveryForm(true);
  }, [stores]);

  const handleSavePatient = useCallback(async (patientData, shouldReturnPatient = false) => {
    try {
      const { createPatientLocal, updatePatientLocal } = await import('../components/utils/offlineMutations');
      const isEditing = !!editingPatient;
      let savedPatient;

      // IMPORTANT: DO NOT process address/unit extraction for manual patient edits.
      // The PatientForm already provides `address` and `unit_number` fields
      // based on direct user input. Automatic extraction logic (`parseAddressAndUnit`)
      // is primarily intended for CSV imports where raw address strings might contain units.

      if (isEditing) {
        await updatePatientLocal(editingPatient.id, patientData);
        // Create the updated patient object for immediate UI update
        savedPatient = {
          ...editingPatient,
          ...patientData,
          updated_date: new Date().toISOString() // Ensure updated_date is current
        };
      } else {
        savedPatient = await createPatientLocal(patientData);
      }

      // Update local state immediately without full reload - this refreshes only affected cards
      setAllPatients((prev) => {
        if (isEditing) {
          // Update existing patient in the list
          return prev.map((p) => p.id === savedPatient.id ? savedPatient : p);
        } else {
          // Add new patient to the list
          return [...prev, savedPatient];
        }
      });

      // Only invalidate Patient cache (not all caches) for future fetches by AppDataContext
      invalidate('Patient');

      // If we need to return the patient (called from DeliveryForm), invoke the callback
      if (shouldReturnPatient && patientFormCallback) {
        patientFormCallback(savedPatient);
        setPatientFormCallback(null);
      }

      // Close form immediately - no need to wait for data reload
      setShowPatientForm(false);
      setEditingPatient(null);

      // If we just edited the selected patient, update the selection too
      if (isEditing && selectedPatient?.id === savedPatient.id) {
        setSelectedPatient(savedPatient);
      }
    } catch (error) {
      console.error("Error saving patient:", error);
      alert("Failed to save patient. Please try again.");
    }
  }, [editingPatient, selectedPatient, patientFormCallback]);

  const handleEditPatient = useCallback((patient) => {
    setSelectedPatient(patient);
    setEditingPatient(patient);
    setShowPatientForm(true);
  }, []);

  const handleDeletePatient = useCallback(async (patient) => {
    // Allow admins to delete patients
    if (!userHasRole(currentUser, 'admin')) {
      alert('You do not have permission to delete patients.');
      return;
    }

    try {
      const { deletePatientLocal } = await import('../components/utils/offlineMutations');
      await deletePatientLocal(patient.id);
      invalidate('Patient'); // Invalidate only Patient cache for AppDataContext
      // Remove the patient from the local state immediately
      setAllPatients((prev) => prev.filter((p) => p.id !== patient.id));
      // If the deleted patient was selected, clear selection
      if (selectedPatient?.id === patient.id) {
        setSelectedPatient(null);
      }
    } catch (error) {
      console.error('Error deleting patient:', error);
      alert('Failed to delete patient.');
    }
  }, [currentUser, selectedPatient]);

  const handleImportPatients = useCallback(async (importResults) => {
    setImportInProgress(true);
    try {
      // The import has already been completed in the PatientImport component
      // We just need to refresh the data and show a success message
      console.log('Import completed with results:', importResults);

      // Calculate store-specific statistics from the import results
      const storeImportStats = {};
      let totalNew = 0;
      let totalUpdated = 0;

      if (importResults.fileResults && Array.isArray(importResults.fileResults)) {
        importResults.fileResults.forEach((result) => {
          if (result.status === 'new' || result.status === 'updated') {
            const storeId = result.store_id;
            if (!storeImportStats[storeId]) {
              storeImportStats[storeId] = { new: 0, updated: 0 };
            }
            if (result.status === 'new') {
              storeImportStats[storeId].new++;
              totalNew++;
            } else if (result.status === 'updated') {
              storeImportStats[storeId].updated++;
              totalUpdated++;
            }
          }
        });
      }

      // Store import stats in state for display on store cards
      setImportStats({
        totalNew: totalNew,
        totalUpdated: totalUpdated,
        byStore: storeImportStats,
        timestamp: new Date()
      });

      // Invalidate all relevant caches. AppDataContext will handle refetching data.
      invalidate('Patient');
      invalidate('Store');
      invalidate('City'); // Assuming cities might be impacted by store updates, though usually static
      invalidate('Delivery'); // In case last_delivery_date changes for updated patients
      invalidate('User'); // Users are unlikely to change through patient import, but for completeness
      invalidate('AppUser'); // AppUsers are unlikely to change through patient import, but for completeness

      // Show success message based on results
      const successfulCount = totalNew + totalUpdated;
      if (successfulCount > 0) {
        alert(`Successfully imported ${successfulCount} patients! ${totalNew} new, ${totalUpdated} updated.${importResults.failed > 0 ? ` ${importResults.failed} failed.` : ''}`);
      } else if (importResults.failed > 0) {
        alert(`Import failed: ${importResults.failed} patients could not be imported.`);
      }

      // Close the import modal
      setShowPatientImport(false);
    } finally {
      setImportInProgress(false);
    }
  }, []);

  const handleDeleteAllPatients = useCallback(async () => {
    if (!isAppOwner(currentUser)) {
      alert('You do not have permission to delete all patients. This action is restricted to the App Owner.');
      return;
    }

    if (filteredPatients.length === 0) {
      alert('No patients found matching the current view to delete.');
      return;
    }

    const confirmed = confirm(`Are you sure you want to delete ${filteredPatients.length} patients displayed? This action cannot be undone.`);
    if (!confirmed) return;

    try {
      let deletedCount = 0;
      let errorCount = 0;

      const { deletePatientLocal } = await import('../components/utils/offlineMutations');
      for (const patient of filteredPatients) {
        try {
          await deletePatientLocal(patient.id);
          deletedCount++;

          if (deletedCount < filteredPatients.length) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } catch (error) {
          console.error(`Error deleting patient ${patient.id}:`, error);
          errorCount++;

          if (error.message && error.message.includes('429')) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      invalidate('Patient'); // Invalidate only Patient cache after bulk delete for AppDataContext
      // Filter out deleted patients from the local state
      setAllPatients((prev) => prev.filter((p) => !filteredPatients.some((dp) => dp.id === p.id)));
      setSelectedPatient(null);

      if (errorCount === 0) {
        alert(`Successfully deleted ${deletedCount} patients.`);
      } else {
        alert(`Deleted ${deletedCount} patients successfully. ${errorCount} deletions failed.`);
      }
    } catch (error) {
      console.error('Error during deletion process:', error);
      alert('Error during deletion process. Please check which patients were deleted and try again if needed.');
    }
  }, [currentUser, filteredPatients]);

  const handlePatientStatusChange = useCallback(async (patient, isActive) => {
    const userRole = currentUser?.app_role;
    if (!['admin', 'dispatcher'].includes(userRole)) {
      alert('You do not have permission to change patient status.');
      return;
    }
    try {
      const { updatePatientLocal } = await import('../components/utils/offlineMutations');
      const newStatus = isActive ? 'active' : 'inactive';
      await updatePatientLocal(patient.id, { status: newStatus });
      invalidate('Patient'); // Invalidate only Patient cache for AppDataContext
      // Update the local state immediately
      setAllPatients((prev) => prev.map((p) => p.id === patient.id ? { ...p, status: newStatus } : p));
      // If the selected patient's status changed, update the selected patient too
      if (selectedPatient?.id === patient.id) {
        setSelectedPatient((prev) => prev ? { ...prev, status: newStatus } : null);
      }
    } catch (error) {
      console.error('Error updating patient status:', error);
      alert('Failed to update patient status.');
    }
  }, [currentUser, selectedPatient]);

  // Memoize the sorted patients
  const sortedAndFilteredPatients = React.useMemo(() => {
    // Apply the advanced sorting logic to the augmented patients
    return sortPatients(patientsWithDeliveryInfoAndPriority);
  }, [patientsWithDeliveryInfoAndPriority]);

  // Determine if we are in an "overview" context
  // Show Store Overview only when first landing on page (no store param in URL) and no search
  const urlParams = new URLSearchParams(location.search);
  const storeParamInUrl = urlParams.get('store');
  const inOverviewContext = !storeParamInUrl && !searchTerm;

  const userRole = currentUser?.app_role;
  const canManagePatients = ['admin', 'dispatcher'].includes(userRole);
  const canCreatePatients = ['admin', 'dispatcher'].includes(userRole);
  const isAdmin = ['admin'].includes(userRole);

  // Show import button only for users with dual admin access
  const showImportButton = canAccessImports(currentUser);

  // Function to render either the dispatcher message or the admin store overview
  const renderStoreOverviewCards = useCallback(() => {
    // This function will be the main conditional render for the overview vs list.
    // It should return JSX for the overview, or null if the patient list should be rendered.

    // If not in an "overview" context, then this function doesn't render anything,
    // allowing the patient list to be rendered.
    if (!inOverviewContext) {
      return null;
    }

    // Now we are in an "overview" context (storeFilter="all" and no searchTerm)
    // Check role to determine what type of overview to show
    // We explicitly check app_role from currentUser for consistency with other parts of the component.
    // The `userRoles` array was temporary for the initial access check in useEffect.
    if (currentUser?.app_role === 'dispatcher') {
      return (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-6 pb-4 flex-shrink-0">
            <h2 className="text-xl font-semibold" style={{ color: 'var(--text-slate-800)' }}>
              Select Store to View Patients
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <Card className="mt-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardContent className="p-6 text-center" style={{ color: 'var(--text-slate-500)' }}>
                Please select a store to view patients from the dropdown above.
              </CardContent>
            </Card>
          </div>
        </div>);

    }

    // If not dispatcher (and in overview context), it must be an admin (due to how 'inOverviewContext' is used in the main render flow)
    // For admin in overview context, show ALL stores, regardless of the currently selectedCityId in the filter dropdown
    const effectiveCityIdForAdminOverview = isAdmin ? "all" : selectedCityId;
    const storeData = getStoreOverview(effectiveCityIdForAdminOverview);

    if (storeData.length === 0) {
      return (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-6 pb-4 flex-shrink-0">
            <h2 className="text-xl font-semibold" style={{ color: 'var(--text-slate-800)' }}>
              Select Store to View Patients
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <Card className="mt-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardContent className="p-6 text-center" style={{ color: 'var(--text-slate-500)' }}>No stores found for this city.</CardContent>
            </Card>
          </div>
        </div>);

    }

    return (
      <StoreOverview
        stores={storeData}
        allPatients={allPatients}
        deliveries={deliveries}
        onStoreSelect={handleStoreOverviewClick}
        importStats={importStats}
        getAssignedDrivers={getAssignedDriversForStore} />);


  }, [inOverviewContext, currentUser, isAdmin, selectedCityId, getStoreOverview, allPatients, deliveries, handleStoreOverviewClick, importStats, getAssignedDriversForStore]);

  // NOW WE CAN HAVE EARLY RETURNS AFTER ALL HOOKS ARE CALLED

  if (isLoading) {
    return (
      <div className="h-screen flex flex-col">
        <div className="flex-shrink-0 p-6" style={{ borderBottom: '1px solid var(--border-slate-200)', background: 'var(--bg-white)' }}>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Patient Database</h1>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p style={{ color: 'var(--text-slate-600)' }}>Loading patient data...</p>
        </div>
      </div>);

  }

  if (!hasAccess) {
    return (
      <div className="h-screen flex flex-col">
        <div className="flex-shrink-0 p-6" style={{ borderBottom: '1px solid var(--border-slate-200)', background: 'var(--bg-white)' }}>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Patient Database</h1>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-red-600">You do not have permission to view this page.</p>
        </div>
      </div>);

  }

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-slate-50)' }}>
      {/* Static Header - Only show when NOT in overview context */}
      {!inOverviewContext &&
      <div className="flex-shrink-0 shadow-sm" style={{ background: 'var(--bg-white)', borderBottom: '1px solid var(--border-slate-200)' }}>
          <div className="p-4" ref={headerRef}>
            {useCompactLayout ? (
          /* Mobile Layout */
          <>
                <div className="flex flex-col gap-3 mb-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <SmartRefreshIndicator inline={true} />
                      <h1 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Patient Database</h1>
                      <Badge
                    className="text-white px-2.5 py-0.5 text-sm font-semibold rounded-md"
                    style={{
                      backgroundColor: storeFilter !== 'all' ?
                      stores.find((s) => s.id === storeFilter)?.color || '#10B981' :
                      '#10B981'
                    }}>
                        {sortedAndFilteredPatients.length}
                      </Badge>
                    </div>
                    {canCreatePatients &&
                <Button
                  onClick={() => {setShowPatientForm(true);setEditingPatient(null);}}
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700 gap-1 h-9">
                        <Plus className="w-4 h-4" />
                        Add
                      </Button>
                }
                  </div>
                </div>
              </>) : (

          /* Desktop Layout */
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
          <div>
            <div className="flex items-center gap-3">
              <SmartRefreshIndicator inline={true} />
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Patient Database</h1>
                    <Badge className="bg-primary text-white px-3 py-1 text-lg font-semibold rounded-[10px] inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent shadow hover:bg-primary/80"

                style={{
                  backgroundColor: storeFilter !== 'all' ?
                  stores.find((s) => s.id === storeFilter)?.color || '#10B981' :
                  '#10B981'
                }}>
                      {sortedAndFilteredPatients.length}
                    </Badge>
                  </div>
                  <p className="mt-1" style={{ color: 'var(--text-slate-600)' }}>Manage patient information and delivery preferences</p>
                </div>
                <div className="flex gap-3 flex-wrap items-center">
                  {showImportButton && !isMobile &&
              <Button onClick={() => setShowPatientImport(true)} variant="outline" className="hidden md:inline-flex bg-yellow-200 px-4 py-2 text-sm font-medium rounded-md items-center justify-center whitespace-nowrap ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border border-input hover:bg-accent hover:text-accent-foreground h-10 gap-2">
                      <Upload className="w-4 h-4" />
                      Import Patients
                    </Button>
              }
                  {canCreatePatients &&
              <Button
                onClick={() => {setShowPatientForm(true);setEditingPatient(null);}}
                className="bg-emerald-600 hover:bg-emerald-700 gap-2">
                      <Plus className="w-4 h-4" />
                      Add Patient
                    </Button>
              }
                </div>
              </div>)
          }

            {/* Search & Filter - Dynamic Responsive Layout based on container width */}
            <div className={`flex flex-col gap-4`}>
              {useCompactLayout ?
            // Mobile/Compact Layout: 2 rows
            <>
                  {/* Row 1: Search and Import Button */}
                  <div className="flex gap-2 items-center">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                      <Input
                    placeholder="Search patients..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10 w-full" />
                      {searchTerm &&
                  <Button variant="ghost" size="icon" className="absolute right-2 top-1/2 transform -translate-y-1/2 h-7 w-7" onClick={() => setSearchTerm("")}>
                          <X className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                        </Button>
                  }
                    </div>
                    {showImportButton && !isMobile &&
                <Button
                  onClick={() => setShowPatientImport(true)}
                  variant="outline"
                  size="sm"
                  className="bg-yellow-200 gap-1 h-9 flex-shrink-0">
                        <Upload className="w-4 h-4" />
                        Import
                      </Button>
                }
                  </div>

                  {/* Row 2: All filters */}
                  <div className="flex gap-2 flex-wrap">
                    {/* City Filter - MOVED FIRST */}
                    <div className="space-y-1 flex-1">
                      <span className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>City</span>
                      <Select
                    value={selectedCityId}
                    onValueChange={(cityId) => {
                      setSelectedCityId(cityId);

                      // When selecting "All Cities", also select "All Stores"
                      if (cityId === 'all') {
                        setStoreFilter('all');
                        const urlParams = new URLSearchParams(location.search);
                        urlParams.set('store', 'all');
                        navigate(`${location.pathname}?${urlParams.toString()}`, { replace: true });
                      }
                      // For specific city, reset store to 'all' but keep on Patient Database screen
                      else if (storeFilter !== 'all') {
                        setStoreFilter('all');
                        const urlParams = new URLSearchParams(location.search);
                        urlParams.set('store', 'all');
                        navigate(`${location.pathname}?${urlParams.toString()}`, { replace: true });
                      }
                    }}
                    disabled={!userHasRole(currentUser, 'admin') && currentUser.city_id}>
                        <SelectTrigger className="w-full h-9" style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                          <SelectValue placeholder="City..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-[300px] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                          {userHasRole(currentUser, 'admin') ?
                      <>
                              <SelectItem value="all">All Cities</SelectItem>
                              {cities.map((city) =>
                        <SelectItem key={city.id} value={city.id}>{city.name}</SelectItem>
                        )}
                            </> :

                      cities.
                      filter((city) => currentUser.city_id ? city.id === currentUser.city_id : true).
                      map((city) =>
                      <SelectItem key={city.id} value={city.id}>{city.name}</SelectItem>
                      )
                      }
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Store Filter - Hide if dispatcher with only one store */}
                    {!(userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && currentUser.store_ids?.length === 1) &&
                <div className="space-y-1 flex-1">
                        <span className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>Store</span>
                        <Select
                    value={storeFilter}
                    onValueChange={(value) => {
                      console.log(`[Patients] Store filter changed to: ${value}`);
                      setStoreFilter(value);

                      // Auto-select corresponding city when store is selected
                      if (value !== 'all') {
                        const selectedStore = stores.find((s) => s.id === value);
                        if (selectedStore?.city_id && selectedStore.city_id !== selectedCityId) {
                          setSelectedCityId(selectedStore.city_id);
                        }
                      }

                      const urlParams = new URLSearchParams(location.search);
                      urlParams.set('store', value);
                      navigate(`${location.pathname}?${urlParams.toString()}`, { replace: true });
                    }}>
                          <SelectTrigger className="w-full h-9" style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                            <SelectValue placeholder="Store..." />
                          </SelectTrigger>
                          <SelectContent className="max-h-[300px] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                            <SelectItem value="all">
                              {selectedCityId === "all" ? "All Patients" : `All in ${cities.find((c) => c.id === selectedCityId)?.name || "city"}`}
                            </SelectItem>
                            {stores.
                      filter((store) => {
                        // Admins see ALL stores when city is "all"
                        if (userHasRole(currentUser, 'admin') && selectedCityId === "all") return true;
                        // Filter by selected city
                        if (selectedCityId !== "all" && store.city_id !== selectedCityId) return false;
                        // Filter by dispatcher's assigned stores
                        if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
                          return currentUser.store_ids?.includes(store.id);
                        }
                        return true;
                      }).
                      map((store) =>
                      <SelectItem key={store.id} value={store.id}>
                                  {store.name}
                                </SelectItem>
                      )}
                          </SelectContent>
                        </Select>
                      </div>
                }

                    {/* Status Filter */}
                    <div className="space-y-1 flex-1">
                      <span className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>Status</span>
                      <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="w-full h-9" style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                          <SelectValue placeholder="Status..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-[300px] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                          <SelectItem value="all">All Statuses</SelectItem>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="inactive">Inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </> :

            // Desktop Layout: Single row with spacer
            <div className="flex gap-4 items-end">
                  {/* Search */}
                  <div className="relative w-80 flex-shrink-0">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                    <Input
                  placeholder="Search patients..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 w-full" />
                    {searchTerm &&
                <Button variant="ghost" size="icon" className="absolute right-2 top-1/2 transform -translate-y-1/2 h-7 w-7" onClick={() => setSearchTerm("")}>
                        <X className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                      </Button>
                }
                  </div>

                  {/* Spacer */}
                  <div className="flex-1"></div>

                  {/* Dropdowns */}
                  <div className="flex gap-3">
                    {/* City Filter - MOVED FIRST */}
                    <div className="space-y-1 w-40 flex-shrink-0">
                      <span className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>City</span>
                      <Select
                    value={selectedCityId}
                    onValueChange={(cityId) => {
                      setSelectedCityId(cityId);

                      // When "All Cities" is selected, also select "All Stores"
                      if (cityId === 'all') {
                        setStoreFilter('all');
                        const urlParams = new URLSearchParams(location.search);
                        urlParams.set('store', 'all');
                        navigate(`${location.pathname}?${urlParams.toString()}`, { replace: true });
                      }
                      // For specific city, reset store to 'all' to stay on Patient Database
                      else if (storeFilter !== 'all') {
                        setStoreFilter('all');
                        const urlParams = new URLSearchParams(location.search);
                        urlParams.set('store', 'all');
                        navigate(`${location.pathname}?${urlParams.toString()}`, { replace: true });
                      }
                    }}
                    disabled={!userHasRole(currentUser, 'admin') && currentUser.city_id}>
                        <SelectTrigger className="w-full" style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                          <SelectValue placeholder="Filter by city..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-[300px] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                          {userHasRole(currentUser, 'admin') ?
                      <>
                              <SelectItem value="all">All Cities</SelectItem>
                              {cities.map((city) =>
                        <SelectItem key={city.id} value={city.id}>{city.name}</SelectItem>
                        )}
                            </> :

                      cities.
                      filter((city) => currentUser.city_id ? city.id === currentUser.city_id : true).
                      map((city) =>
                      <SelectItem key={city.id} value={city.id}>{city.name}</SelectItem>
                      )
                      }
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Store Filter - Hide if dispatcher with only one store */}
                    {!(userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && currentUser.store_ids?.length === 1) &&
                <div className="space-y-1 w-40 flex-shrink-0">
                        <span className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>Store</span>
                        <Select
                    value={storeFilter}
                    onValueChange={(value) => {
                      console.log(`[Patients] Store filter changed to: ${value}`);
                      setStoreFilter(value);

                      // Auto-select corresponding city when store is selected
                      if (value !== 'all') {
                        const selectedStore = stores.find((s) => s.id === value);
                        if (selectedStore?.city_id && selectedStore.city_id !== selectedCityId) {
                          setSelectedCityId(selectedStore.city_id);
                        }
                      }

                      const urlParams = new URLSearchParams(location.search);
                      urlParams.set('store', value);
                      navigate(`${location.pathname}?${urlParams.toString()}`, { replace: true });
                    }}>
                          <SelectTrigger className="w-full" style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                            <SelectValue placeholder="Filter by store..." />
                          </SelectTrigger>
                          <SelectContent className="max-h-[300px] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                            <SelectItem value="all">
                              {selectedCityId === "all" ? "All Patients" : `All in ${cities.find((c) => c.id === selectedCityId)?.name || "selected city"}`}
                            </SelectItem>
                            {stores.
                      filter((store) => {
                        // Admins see ALL stores when city is "all"
                        if (userHasRole(currentUser, 'admin') && selectedCityId === "all") return true;
                        // Filter by selected city
                        if (selectedCityId !== "all" && store.city_id !== selectedCityId) return false;
                        // Filter by dispatcher's assigned stores
                        if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
                          return currentUser.store_ids?.includes(store.id);
                        }
                        return true;
                      }).
                      map((store) =>
                      <SelectItem key={store.id} value={store.id}>
                                  {store.name}
                                </SelectItem>
                      )}
                          </SelectContent>
                        </Select>
                      </div>
                }

                    {/* Status Filter */}
                    <div className="space-y-1 w-40 flex-shrink-0">
                      <span className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>Status</span>
                      <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="w-full" style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                          <SelectValue placeholder="Status..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-[300px] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                          <SelectItem value="all">All Statuses</SelectItem>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="inactive">Inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
            }
            </div>
          </div>
        </div>
      }

      {/* Patient Database Header - Only show IN overview context */}
      {inOverviewContext &&
      <div className="flex-shrink-0 shadow-sm" style={{ background: 'var(--bg-white)', borderBottom: '1px solid var(--border-slate-200)' }}>
          <div className="p-4">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <SmartRefreshIndicator inline={true} />
                  <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Store Overview</h1>
                </div>
                <p className="mt-1" style={{ color: 'var(--text-slate-600)' }}>Select a store to view and manage patients</p>
              </div>
              {/* Import button - ONLY for users with import access and not on mobile */}
              {showImportButton && !isMobile &&
            <div className="flex justify-end md:justify-start">
                  <Button onClick={() => setShowPatientImport(true)} variant="outline" className="hidden md:inline-flex bg-yellow-200 px-4 py-2 text-sm font-medium rounded-md items-center justify-center whitespace-nowrap ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border border-input hover:bg-accent hover:text-accent-foreground h-10 gap-2">
                    <Upload className="w-4 h-4" />
                    Import Patients
                  </Button>
                </div>
            }
            </div>
          </div>
        </div>
      }

      {/* Scrollable Content */}
      <div className="flex flex-1 overflow-hidden">
        {renderStoreOverviewCards() ||
        <>
            {/* Left Panel - Patient List */}
            <div className="flex-1 flex flex-col">
              {/* Patients Grid - Responsive */}
              <div className="flex-1 p-6 overflow-y-auto">
                <AnimatePresence>
                  {sortedAndFilteredPatients.length === 0 ?
                <Card className="col-span-full" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                      <CardContent className="p-6 text-center" style={{ color: 'var(--text-slate-500)' }}>
                        {allPatients.length === 0 ?
                    "No patients found in your assigned stores." :

                    <div className="space-y-2">
                            <p>No patients match your search criteria or filters.</p>
                            {isAdmin && storeFilter !== "all" &&
                      <Button
                        variant="outline"
                        onClick={() => {
                          setStoreFilter("all");
                          setSearchTerm("");
                          const urlParams = new URLSearchParams(location.search);
                          urlParams.delete('store');
                          navigate(`${location.pathname}?${urlParams.toString()}`, { replace: true });
                        }}
                        className="mt-2">
                                Back to Store Overview
                              </Button>
                      }
                          </div>
                    }
                      </CardContent>
                    </Card> :

                <div
                  className="grid gap-4"
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
                      {sortedAndFilteredPatients.map((patient) =>
                  <PatientCard
                    key={patient.id}
                    patient={patient}
                    store={stores.find((s) => s.id === patient.store_id)}
                    drivers={drivers}
                    allPatients={allPatients}
                    allDeliveries={deliveries}
                    onEdit={(p) => handleEditPatient(p)}
                    onDelete={(p) => handleDeletePatient(p)}
                    onCreateDelivery={(p) => handleAddToRoute(p)}
                    onSelect={(p) => setSelectedPatient(p)}
                    isSelected={selectedPatient?.id === patient.id}
                    showStoreBadge={storeFilter === "all" || storeFilter === "all" && selectedCityId !== "all"}
                    displayPriority={patient.displayPriority}
                    todayDelivery={patient.todayDelivery}
                    onStatusToggle={handlePatientStatusChange} />

                  )}
                    </div>
                }
                </AnimatePresence>
              </div>
            </div>

            {/* Resizable Divider for Right Panel */}
            <ResizableDivider
            storageKey="rxdeliver_patients_panel_width"
            defaultWidth={440}
            minWidth={320}
            maxWidth={600}
            onWidthChange={setRightPanelWidth}
            side="right" />


            {/* Right Panel - Delivery Analytics and Recent Deliveries */}
            <div
            className="p-6 overflow-y-auto hidden lg:block"
            style={{ width: `${rightPanelWidth}px`, flexShrink: 0, background: 'var(--bg-slate-100)', borderLeft: '1px solid var(--border-slate-200)' }}>
              <PatientDetails
              patient={selectedPatient}
              deliveries={selectedPatient ? getPatientDeliveries(selectedPatient.id) : []}
              deliveryStats={selectedPatient ? getDeliveryStats(selectedPatient.id) : null} />

            </div>
          </>
        }
      </div>

      {/* Modals */}
      <AnimatePresence>
        {showPatientForm &&
        <>
          {console.log('🔍 [Patients] Rendering PatientForm with props:', {
            citiesCount: cities?.length,
            currentUserCityId: currentUser?.city_id,
            storesCount: stores?.length
          })}
          <PatientForm
            patient={editingPatient}
            onSave={handleSavePatient}
            onCancel={() => {
              setShowPatientForm(false);
              setEditingPatient(null);
              setPatientFormCallback(null);
            }}
            stores={stores}
            cities={cities}
            allPatients={allPatients}
            currentUser={currentUser}
            returnPatientOnSave={!!patientFormCallback} />
        </>
        }
      </AnimatePresence>

      <AnimatePresence>
        {showDeliveryForm &&
        <DeliveryForm
          initialPatientId={patientForNewDelivery?.id}
          suggestedDate={patientForNewDelivery?.suggestedDate}
          patients={allPatients}
          stores={stores}
          drivers={drivers}
          currentUser={currentUser}
          allDeliveries={deliveries}
          onSave={handleSaveDelivery}
          onCancel={() => {
            setShowDeliveryForm(false);
            setPatientForNewDelivery(null);
          }}
          closeOnSave={true}
          onCreatePatient={(callback) => {
            setPatientFormCallback(() => callback);
            setShowPatientForm(true);
          }} />

        }
      </AnimatePresence>

      <AnimatePresence>
        {showPatientImport &&
        <PatientImport
          stores={stores}
          onImportComplete={handleImportPatients}
          onCancel={() => setShowPatientImport(false)}
          patients={allPatients}
          allUsers={allUsers} />

        }
      </AnimatePresence>

      {/* Floating Import Progress Indicator */}
      <AnimatePresence>
        {importInProgress &&
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 50 }}
          transition={{ duration: 0.3 }}
          className="fixed bottom-6 right-6 p-4 bg-blue-600 text-white rounded-lg shadow-lg flex items-center gap-3 z-50">

            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Import in progress... Please wait.</span>
          </motion.div>
        }
      </AnimatePresence>
    </div>);

}