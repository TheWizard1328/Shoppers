import React, { useState, useEffect, useMemo } from "react";
import { Patient } from "@/entities/Patient";
import { Store } from "@/entities/Store";
import { User } from "@/entities/User";
import { AppUser } from "@/entities/AppUser";
import { base44 } from "@/api/base44Client";
import { getData, getDeliveriesForDateRange } from '../components/utils/dataManager';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Calendar as CalendarIcon,
  TrendingUp,
  TrendingDown,
  Clock,
  MapPin,
  Package,
  AlertCircle,
  CheckCircle,
  XCircle,
  Truck,
  Target } from
"lucide-react";
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, subDays, subWeeks, subMonths, subYears, parseISO, startOfQuarter, endOfQuarter, subQuarters } from "date-fns";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { getEffectiveUser } from "../components/utils/auth";
import { getDriverDisplayName, getDriverNameForComparison } from '../components/utils/driverUtils';
import { sortUsers } from '../components/utils/sorting';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';

const calculateDistance = (lat1, lng1, lat2, lng2) => {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 0;
  const toRad = (value) => value * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
  Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const MetricCard = ({ title, value, subtitle, icon: Icon, trend, previousValue, color = "blue" }) => {
  const colorClasses = {
    blue: "text-blue-600 bg-blue-100",
    green: "text-green-600 bg-green-100",
    orange: "text-orange-600 bg-orange-100",
    purple: "text-purple-600 bg-purple-100",
    red: "text-red-600 bg-red-100"
  };

  // Calculate percentage change if previousValue is provided
  let percentChange = null;
  let isPositive = null;
  if (previousValue !== null && previousValue !== undefined && previousValue !== 0) {
    const numValue = parseFloat(String(value).replace(/[^0-9.-]/g, '')) || 0; // Robustly parse value
    const numPrevious = parseFloat(String(previousValue).replace(/[^0-9.-]/g, '')) || 0; // Robustly parse previousValue
    if (numPrevious !== 0) {// Avoid division by zero
      percentChange = ((numValue - numPrevious) / numPrevious * 100).toFixed(1);
      isPositive = numValue >= numPrevious;
    } else if (numValue > 0) {
      percentChange = '100.0'; // If previous was 0 and current is >0, it's 100% growth
      isPositive = true;
    } else if (numValue < 0) {
      percentChange = '-100.0'; // If previous was 0 and current is <0, it's -100%
      isPositive = false;
    } else {
      percentChange = null; // Both are zero, no change
    }
  }

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>{title}</CardTitle>
        <div className={`p-2 rounded-full ${colorClasses[color]}`}>
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{value}</div>
        {subtitle && <p className="text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>{subtitle}</p>}
        {percentChange !== null &&
        <div className={`flex items-center mt-2 text-xs ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
            {isPositive ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
            {Math.abs(percentChange)}% vs previous period
          </div>
        }
        {previousValue !== null && previousValue !== undefined && percentChange === null &&
        <p className="text-xs mt-1" style={{ color: 'var(--text-slate-400)' }}>Previous: {previousValue}</p>
        }
      </CardContent>
    </Card>);

};

// Helper function to get date ranges based on selection
const getDateRanges = (rangeType, year = new Date().getFullYear()) => {
  const now = new Date();
  let start, end, prevStart, prevEnd;

  switch (rangeType) {
    case 'today':
      start = new Date(now.setHours(0, 0, 0, 0));
      end = new Date(now.setHours(23, 59, 59, 999));
      prevStart = subDays(start, 1);
      prevEnd = subDays(end, 1);
      break;

    case 'week':
      start = startOfWeek(now, { weekStartsOn: 1 }); // Monday
      end = endOfWeek(now, { weekStartsOn: 1 }); // Sunday
      prevStart = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
      prevEnd = endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
      break;

    case 'lastWeek':
      start = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
      end = endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
      prevStart = startOfWeek(subWeeks(now, 2), { weekStartsOn: 1 });
      prevEnd = endOfWeek(subWeeks(now, 2), { weekStartsOn: 1 });
      break;

    case 'month':
      start = startOfMonth(now);
      end = endOfMonth(now);
      prevStart = startOfMonth(subMonths(now, 1));
      prevEnd = endOfMonth(subMonths(now, 1));
      break;

    case 'lastMonth':
      start = startOfMonth(subMonths(now, 1));
      end = endOfMonth(subMonths(now, 1));
      prevStart = startOfMonth(subMonths(now, 2));
      prevEnd = endOfMonth(subMonths(now, 2));
      break;

    case 'q1':
      start = startOfQuarter(new Date(year, 0, 1));
      end = endOfQuarter(new Date(year, 0, 1));
      prevStart = startOfQuarter(new Date(year - 1, 0, 1));
      prevEnd = endOfQuarter(new Date(year - 1, 0, 1));
      break;

    case 'q2':
      start = startOfQuarter(new Date(year, 3, 1));
      end = endOfQuarter(new Date(year, 3, 1));
      prevStart = startOfQuarter(new Date(year - 1, 3, 1));
      prevEnd = endOfQuarter(new Date(year - 1, 3, 1));
      break;

    case 'q3':
      start = startOfQuarter(new Date(year, 6, 1));
      end = endOfQuarter(new Date(year, 6, 1));
      prevStart = startOfQuarter(new Date(year - 1, 6, 1));
      prevEnd = endOfQuarter(new Date(year - 1, 6, 1));
      break;

    case 'q4':
      start = startOfQuarter(new Date(year, 9, 1));
      end = endOfQuarter(new Date(year, 9, 1));
      prevStart = startOfQuarter(new Date(year - 1, 9, 1));
      prevEnd = endOfQuarter(new Date(year - 1, 9, 1));
      break;

    case 'year':
      start = startOfYear(new Date(year, 0, 1));
      end = endOfYear(new Date(year, 0, 1));
      prevStart = startOfYear(new Date(year - 1, 0, 1));
      prevEnd = endOfYear(new Date(year - 1, 0, 1));
      break;

    default: // Defaulting to 'week' calculation
      start = startOfWeek(now, { weekStartsOn: 1 });
      end = endOfWeek(now, { weekStartsOn: 1 });
      prevStart = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
      prevEnd = endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
  }

  return { start, end, prevStart, prevEnd };
};

export default function DeliveryMetrics() {
  const [dateRange, setDateRange] = useState('week');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [startDate, setStartDate] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [endDate, setEndDate] = useState(endOfWeek(new Date(), { weekStartsOn: 1 }));
  const [prevStartDate, setPrevStartDate] = useState(null);
  const [prevEndDate, setPrevEndDate] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [patients, setPatients] = useState([]);
  const [stores, setStores] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [selectedDriver, setSelectedDriver] = useState('all');
  const [selectedStore, setSelectedStore] = useState('all');
  const [currentUser, setCurrentUser] = useState(null);
  const [currentAppUser, setCurrentAppUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  
  const availableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  useEffect(() => {
    const loadUser = async () => {
      const user = await getEffectiveUser();
      setCurrentUser(user);
    };
    loadUser();
  }, []);

  useEffect(() => {
    const ranges = getDateRanges(dateRange, selectedYear);
    setStartDate(ranges.start);
    setEndDate(ranges.end);
    setPrevStartDate(ranges.prevStart);
    setPrevEndDate(ranges.prevEnd);
  }, [dateRange, selectedYear]);

  useEffect(() => {
    if (currentUser) {
      loadData(selectedYear);
    }
  }, [currentUser, selectedYear]); // Reload when user or year changes

  // Listen for broadcast sync events to refresh data
  useEffect(() => {
    const handleBroadcastRefresh = () => {
      console.log('📢 [DeliveryMetrics] Received broadcast refresh event, reloading data...');
      loadData();
    };

    window.addEventListener('realtimeSyncRefresh', handleBroadcastRefresh);
    window.addEventListener('refreshDeliveryStats', handleBroadcastRefresh);

    return () => {
      window.removeEventListener('realtimeSyncRefresh', handleBroadcastRefresh);
      window.removeEventListener('refreshDeliveryStats', handleBroadcastRefresh);
    };
  }, [currentUser]);

  const loadData = async (forceYear = null) => {
    if (!currentUser) return;

    setIsLoading(true);
    try {
      const yearToFetch = forceYear || selectedYear;
      console.log('🔄 [DeliveryMetrics] Fetching data for year:', yearToFetch);
      
      // Use dataManager to fetch deliveries - leverages caching and offline DB
      const yearStart = `${yearToFetch}-01-01`;
      const yearEnd = `${yearToFetch}-12-31`;
      
      // Use getDeliveriesForDateRange which handles caching and rate limiting
      const deliveriesData = await getDeliveriesForDateRange(yearStart, yearEnd);
      
      console.log(`✅ [DeliveryMetrics] Fetched ${deliveriesData.length} deliveries for ${yearToFetch}`);

      // Use getData for other entities - also uses caching
      const [patientsData, storesData, appUsersData] = await Promise.all([
        getData('Patient'),
        getData('Store'),
        getData('AppUser')
      ]);

      setPatients(patientsData || []);
      setStores(storesData || []);

      // Check if user is admin via platform role OR app_roles
      const currentAppUser = (appUsersData || []).find((au) => au.user_id === currentUser.id);
      const isAdmin = currentUser?.role === 'admin' || currentAppUser?.app_roles?.includes('admin');
      console.log('👤 [DeliveryMetrics] Current user:', currentUser?.full_name, 'isAdmin:', isAdmin, 'platform role:', currentUser?.role, 'app_roles:', currentAppUser?.app_roles);
      
      let allDrivers = [];

      if (isAdmin) {
        // Admin can see all drivers - use getData which uses caching
        try {
          const usersData = await getData('User');
          console.log('👥 [DeliveryMetrics] Fetched users:', usersData?.length);
          const allAuthUsers = (usersData || []).filter((u) => u.role === 'admin' || u.role === 'user');
          allDrivers = allAuthUsers.map((authUser) => {
            const appUser = (appUsersData || []).find((au) => au.user_id === authUser.id);
            if (appUser) {
              return {
                ...authUser,
                ...appUser,
                user_name: appUser.user_name || authUser.full_name,
                app_role: appUser.app_roles?.[0] || 'driver',
                display_name: appUser.user_name || authUser.full_name
              };
            }
            return authUser;
          }).filter((u) => {
            const appRole = u.app_role || u.app_roles?.[0];
            return appRole === 'driver' || appRole === 'admin';
          });
          console.log('👥 [DeliveryMetrics] Filtered drivers:', allDrivers.length, allDrivers.map(d => d.user_name || d.full_name));
        } catch (userListError) {
          console.error('❌ [DeliveryMetrics] Error fetching users:', userListError);
          // Fallback: Build drivers from AppUser data
          allDrivers = (appUsersData || [])
            .filter(au => au.app_roles?.includes('driver') || au.app_roles?.includes('admin'))
            .map(au => ({
              id: au.user_id,
              user_id: au.user_id,
              user_name: au.user_name,
              display_name: au.user_name,
              app_role: au.app_roles?.[0] || 'driver',
              app_roles: au.app_roles
            }));
          console.log('👥 [DeliveryMetrics] Fallback drivers from AppUser:', allDrivers.length);
        }
      } else {
        // Non-admin: only show themselves
        if (currentAppUser) {
          allDrivers = [{
            ...currentUser,
            ...currentAppUser,
            user_name: currentAppUser.user_name || currentUser.full_name,
            app_role: currentAppUser.app_roles?.[0] || 'driver',
            display_name: currentAppUser.user_name || currentUser.full_name
          }];
        } else {
          allDrivers = [currentUser];
        }
      }

      console.log('👥 [DeliveryMetrics] Final drivers list:', allDrivers.length, allDrivers.map(d => ({ id: d.id, user_id: d.user_id, name: d.user_name || d.full_name })));
      
      // Ensure all drivers have a valid id
      const driversWithIds = allDrivers.filter(d => d.id || d.user_id).map(d => ({
        ...d,
        id: d.id || d.user_id
      }));
      console.log('👥 [DeliveryMetrics] Drivers with valid IDs:', driversWithIds.length);
      
      setDrivers(sortUsers(driversWithIds));
      setDeliveries(deliveriesData || []);

      console.log(`✅ [DeliveryMetrics] Stored ${deliveriesData?.length || 0} total deliveries in state`);
    } catch (error) {
      console.error("Error loading metrics data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const metrics = useMemo(() => {
    console.log('🔍 [DeliveryMetrics] Starting metrics calculation...');
    console.log('📊 Total deliveries available (all time):', deliveries.length);
    console.log('📅 Current period date range:', format(startDate, 'yyyy-MM-dd'), 'to', format(endDate, 'yyyy-MM-dd'));
    console.log('👤 Selected driver:', selectedDriver);
    console.log('👥 Available drivers:', drivers.length);
    
    // DEBUG: Show ALL unique dates in the entire delivery dataset
    const allDatesInDataset = [...new Set(deliveries.filter(d => d.delivery_date).map(d => d.delivery_date))].sort();
    console.log('📅 ALL dates in dataset:', allDatesInDataset.length, 'unique dates');
    console.log('📅 Date range in dataset:', allDatesInDataset[0], 'to', allDatesInDataset[allDatesInDataset.length - 1]);
    
    // Show December 2025 dates specifically
    const dec2025Dates = allDatesInDataset.filter(d => d.startsWith('2025-12'));
    console.log('📅 December 2025 dates available:', dec2025Dates);

    // CRITICAL: Filter to only include deliveries (has patient_id) OR after_hours_pickup
    // Excludes regular pickups from all stats
    let relevantDeliveries = deliveries.filter((d) => {
      if (!d.delivery_date) return false;
      // Only include deliveries with patient OR after_hours_pickup
      if (!d.patient_id && !d.after_hours_pickup) return false;
      
      // CRITICAL: Parse dates as YYYY-MM-DD strings for comparison to avoid timezone issues
      const deliveryDate = d.delivery_date; // e.g., '2025-12-04'
      const startDateStr = format(startDate, 'yyyy-MM-dd');
      const endDateStr = format(endDate, 'yyyy-MM-dd');
      
      return deliveryDate >= startDateStr && deliveryDate <= endDateStr;
    });

    console.log('📊 Deliveries in current date range:', relevantDeliveries.length);
    
    // Debug: Show breakdown by date
    const dateBreakdown = {};
    relevantDeliveries.forEach(d => {
      const date = d.delivery_date;
      dateBreakdown[date] = (dateBreakdown[date] || 0) + 1;
    });
    console.log('📅 Deliveries by date:', dateBreakdown);
    
    // Debug: Show breakdown by driver
    const driverBreakdown = {};
    relevantDeliveries.forEach(d => {
      const key = `${d.driver_id} (${d.driver_name})`;
      driverBreakdown[key] = (driverBreakdown[key] || 0) + 1;
    });
    console.log('👤 Deliveries by driver:', driverBreakdown);

    let prevRelevantDeliveries = [];

    if (selectedDriver !== 'all') {
      const driver = drivers.find((d) => d.id === selectedDriver);
      if (driver) {
        const driverName = getDriverDisplayName(driver);
        console.log('🔍 DRIVER FILTER ACTIVE');
        console.log('  Selected driver ID:', selectedDriver);
        console.log('  Selected driver name:', driverName);
        console.log('  Driver IDs in current period:', [...new Set(relevantDeliveries.map(d => d.driver_id))]);
        console.log('  Driver names in current period:', [...new Set(relevantDeliveries.map(d => d.driver_name))]);
        
        const beforeCount = relevantDeliveries.length;
        // CRITICAL: Match by driver_id OR driver_name (deliveries may have either)
        relevantDeliveries = relevantDeliveries.filter((d) => {
          const matchById = d.driver_id === selectedDriver;
          const matchByName = d.driver_name && driverName && 
            d.driver_name.toLowerCase() === driverName.toLowerCase();
          return matchById || matchByName;
        });
        console.log('  📊 Deliveries before filter:', beforeCount);
        console.log('  📊 Deliveries after filter:', relevantDeliveries.length);
        
        if (relevantDeliveries.length === 0) {
          console.error('⚠️ NO DELIVERIES FOUND for driver:', selectedDriver, driverName);
        }
      } else {
        console.error('⚠️ Driver not found in drivers list for ID:', selectedDriver);
      }
    }

    console.log('📊 Relevant deliveries for current period (after driver filter):', relevantDeliveries.length);

    if (prevStartDate && prevEndDate) {
      prevRelevantDeliveries = deliveries.filter((d) => {
        if (!d.delivery_date) return false;
        // Only include deliveries with patient OR after_hours_pickup
        if (!d.patient_id && !d.after_hours_pickup) return false;
        
        const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
        const start = new Date(prevStartDate.getFullYear(), prevStartDate.getMonth(), prevStartDate.getDate());
        const end = new Date(prevEndDate.getFullYear(), prevEndDate.getMonth(), prevEndDate.getDate(), 23, 59, 59);
        return deliveryDate >= start && deliveryDate <= end;
      });

      if (selectedDriver !== 'all') {
        const driver = drivers.find((drv) => drv.id === selectedDriver);
        const driverName = driver ? getDriverDisplayName(driver) : null;
        prevRelevantDeliveries = prevRelevantDeliveries.filter((d) => {
          const matchById = d.driver_id === selectedDriver;
          const matchByName = d.driver_name && driverName && 
            d.driver_name.toLowerCase() === driverName.toLowerCase();
          return matchById || matchByName;
        });
      }
      console.log('📊 Relevant deliveries for previous period:', prevRelevantDeliveries.length);
    }

    const patientDeliveries = relevantDeliveries.filter((d) => {
      const hasPatient = d.patient_id && d.patient_id !== "";
      const wasAttempted = d.status === 'completed' || d.status === 'failed';
      const hasTimestamp = d.actual_delivery_time;
      return hasPatient && wasAttempted && hasTimestamp;
    });

    console.log('📊 Patient deliveries for route metrics:', patientDeliveries.length);
    if (patientDeliveries.length > 0) {
      console.log('📊 Sample delivery:', patientDeliveries[0]);
    }

    const prevPatientDeliveries = prevRelevantDeliveries.filter((d) => {
      const hasPatient = d.patient_id && d.patient_id !== "";
      const wasAttempted = d.status === 'completed' || d.status === 'failed';
      const hasTimestamp = d.actual_delivery_time;
      return hasPatient && wasAttempted && hasTimestamp;
    });

    // After-hours pickups count
    const afterHoursPickups = relevantDeliveries.filter((d) => d.after_hours_pickup && !d.patient_id).length;
    
    // Completed and failed only count patient deliveries (not after-hours pickups)
    const completedDeliveries = relevantDeliveries.filter((d) => d.status === 'completed' && d.patient_id).length;
    const failedDeliveries = relevantDeliveries.filter((d) => d.status === 'failed' && d.patient_id).length;
    
    // Total = Completed + Failed + After Hours Pickups
    const totalDeliveries = completedDeliveries + failedDeliveries + afterHoursPickups;
    const returnedDeliveries = relevantDeliveries.filter((d) => {
      const patient = patients.find((p) => p.id === d.patient_id);
      const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      return notesReturn || addressReturn;
    }).length;

    const completionRate = completedDeliveries + failedDeliveries > 0 ?
    (completedDeliveries / (completedDeliveries + failedDeliveries) * 100).toFixed(1) :
    0;

    console.log('📊 Stats - Total:', totalDeliveries, 'Completed:', completedDeliveries, 'Failed:', failedDeliveries, 'Returned:', returnedDeliveries);

    // Previous period after-hours pickups
    const prevAfterHoursPickups = prevRelevantDeliveries.filter((d) => d.after_hours_pickup && !d.patient_id).length;
    
    // Previous period completed and failed only count patient deliveries
    const prevCompletedDeliveries = prevRelevantDeliveries.filter((d) => d.status === 'completed' && d.patient_id).length;
    const prevFailedDeliveries = prevRelevantDeliveries.filter((d) => d.status === 'failed' && d.patient_id).length;
    
    // Previous Total = Completed + Failed + After Hours Pickups
    const prevTotalDeliveries = prevCompletedDeliveries + prevFailedDeliveries + prevAfterHoursPickups;
    const prevReturnedDeliveries = prevRelevantDeliveries.filter((d) => {
      const patient = patients.find((p) => p.id === d.patient_id);
      const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      return notesReturn || addressReturn;
    }).length;

    const prevCompletionRate = prevCompletedDeliveries + prevFailedDeliveries > 0 ?
    (prevCompletedDeliveries / (prevCompletedDeliveries + prevFailedDeliveries) * 100).toFixed(1) :
    0;

    // Calculate route metrics for current period
    const routeGroups = new Map();
    patientDeliveries.forEach((delivery) => {
      const key = `${delivery.driver_name}-${delivery.delivery_date}`;
      if (!routeGroups.has(key)) {
        routeGroups.set(key, []);
      }
      routeGroups.get(key).push(delivery);
    });

    console.log('📊 Route groups:', routeGroups.size);

    let totalDistance = 0;
    let totalTimeBetweenStops = 0;
    let stopCount = 0;
    let onTimeDeliveries = 0;
    let totalDeliveriesWithTimeWindow = 0;

    routeGroups.forEach((routeDeliveries) => {
      const sortedRoute = [...routeDeliveries].sort((a, b) =>
      new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time)
      );

      for (let i = 0; i < sortedRoute.length - 1; i++) {
        const currentDelivery = sortedRoute[i];
        const nextDelivery = sortedRoute[i + 1];

        const currentPatient = patients.find((p) => p.id === currentDelivery.patient_id);
        const nextPatient = patients.find((p) => p.id === nextDelivery.patient_id);

        if (currentPatient?.latitude && currentPatient?.longitude &&
        nextPatient?.latitude && nextPatient?.longitude) {
          const distance = calculateDistance(
            currentPatient.latitude,
            currentPatient.longitude,
            nextPatient.latitude,
            nextPatient.longitude
          );
          totalDistance += distance;

          const currentTime = new Date(currentDelivery.actual_delivery_time);
          const nextTime = new Date(nextDelivery.actual_delivery_time);
          const timeDiff = (nextTime - currentTime) / (1000 * 60);
          totalTimeBetweenStops += timeDiff;
          stopCount++;
        }

        // Only check on-time for completed deliveries
        if (currentDelivery.status === 'completed' && currentDelivery.delivery_time_start && currentDelivery.delivery_time_end) {
          totalDeliveriesWithTimeWindow++;
          const actualTime = new Date(currentDelivery.actual_delivery_time);
          const [startHour, startMin] = currentDelivery.delivery_time_start.split(':').map(Number);
          const [endHour, endMin] = currentDelivery.delivery_time_end.split(':').map(Number);

          const deliveryDate = new Date(currentDelivery.delivery_date);
          const windowStart = new Date(deliveryDate);
          windowStart.setHours(startHour, startMin, 0, 0);
          const windowEnd = new Date(deliveryDate);
          windowEnd.setHours(endHour, endMin, 0, 0);

          if (actualTime >= windowStart && actualTime <= windowEnd) {
            onTimeDeliveries++;
          }
        }
      }
    });

    console.log('📊 Route metrics - Distance:', totalDistance.toFixed(2), 'Time (min):', totalTimeBetweenStops.toFixed(0), 'Stops:', stopCount);

    // Calculate previous period route metrics
    const prevRouteGroups = new Map();
    prevPatientDeliveries.forEach((delivery) => {
      const key = `${delivery.driver_name}-${delivery.delivery_date}`;
      if (!prevRouteGroups.has(key)) {
        prevRouteGroups.set(key, []);
      }
      prevRouteGroups.get(key).push(delivery);
    });

    let prevTotalDistance = 0;
    let prevTotalTimeBetweenStops = 0;
    let prevStopCount = 0;
    let prevOnTimeDeliveries = 0;
    let prevTotalDeliveriesWithTimeWindow = 0;

    prevRouteGroups.forEach((routeDeliveries) => {
      const sortedRoute = [...routeDeliveries].sort((a, b) =>
      new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time)
      );

      for (let i = 0; i < sortedRoute.length - 1; i++) {
        const currentDelivery = sortedRoute[i];
        const nextDelivery = sortedRoute[i + 1];

        const currentPatient = patients.find((p) => p.id === currentDelivery.patient_id);
        const nextPatient = patients.find((p) => p.id === nextDelivery.patient_id);

        if (currentPatient?.latitude && currentPatient?.longitude &&
        nextPatient?.latitude && nextPatient?.longitude) {
          const distance = calculateDistance(
            currentPatient.latitude,
            currentPatient.longitude,
            nextPatient.latitude,
            nextPatient.longitude
          );
          prevTotalDistance += distance;

          const currentTime = new Date(currentDelivery.actual_delivery_time);
          const nextTime = new Date(nextDelivery.actual_delivery_time);
          const timeDiff = (nextTime - currentTime) / (1000 * 60);
          prevTotalTimeBetweenStops += timeDiff;
          prevStopCount++;
        }

        // Only check on-time for completed deliveries
        if (currentDelivery.status === 'completed' && currentDelivery.delivery_time_start && currentDelivery.delivery_time_end) {
          prevTotalDeliveriesWithTimeWindow++;
          const actualTime = new Date(currentDelivery.actual_delivery_time);
          const [startHour, startMin] = currentDelivery.delivery_time_start.split(':').map(Number);
          const [endHour, endMin] = currentDelivery.delivery_time_end.split(':').map(Number);

          const deliveryDate = new Date(currentDelivery.delivery_date);
          const windowStart = new Date(deliveryDate);
          windowStart.setHours(startHour, startMin, 0, 0);
          const windowEnd = new Date(deliveryDate);
          windowEnd.setHours(endHour, endMin, 0, 0);

          if (actualTime >= windowStart && actualTime <= windowEnd) {
            prevOnTimeDeliveries++;
          }
        }
      }
    });

    const avgDistance = stopCount > 0 ? (totalDistance / stopCount).toFixed(2) : 0;
    const avgTimeBetweenStops = stopCount > 0 ? Math.round(totalTimeBetweenStops / stopCount) : 0;
    const onTimeRate = totalDeliveriesWithTimeWindow > 0 ?
    (onTimeDeliveries / totalDeliveriesWithTimeWindow * 100).toFixed(1) :
    0;

    const prevAvgDistance = prevStopCount > 0 ? (prevTotalDistance / prevStopCount).toFixed(2) : 0;
    const prevAvgTimeBetweenStops = prevStopCount > 0 ? Math.round(prevTotalTimeBetweenStops / prevStopCount) : 0;
    const prevOnTimeRate = prevTotalDeliveriesWithTimeWindow > 0 ?
    (prevOnTimeDeliveries / prevTotalDeliveriesWithTimeWindow * 100).toFixed(1) :
    0;

    const uniqueDays = new Set(relevantDeliveries.map((d) => d.delivery_date)).size;
    const avgDeliveriesPerDay = uniqueDays > 0 ? (totalDeliveries / uniqueDays).toFixed(1) : 0;

    const prevUniqueDays = new Set(prevRelevantDeliveries.map((d) => d.delivery_date)).size;
    const prevAvgDeliveriesPerDay = prevUniqueDays > 0 ? (prevTotalDeliveries / prevUniqueDays).toFixed(1) : 0;

    // Status breakdown
    const statusCounts = {
      completed: relevantDeliveries.filter((d) => d.status === 'completed').length,
      inTransit: relevantDeliveries.filter((d) => d.status === 'in_transit').length,
      pending: relevantDeliveries.filter((d) => d.status === 'pending' || d.status === 'Ready For Pickup').length,
      failed: failedDeliveries,
      returned: returnedDeliveries
    };

    const prevStatusCounts = {
      completed: prevRelevantDeliveries.filter((d) => d.status === 'completed').length,
      inTransit: prevRelevantDeliveries.filter((d) => d.status === 'in_transit').length,
      pending: prevRelevantDeliveries.filter((d) => d.status === 'pending' || d.status === 'Ready For Pickup').length,
      failed: prevFailedDeliveries,
      returned: prevReturnedDeliveries
    };

    // Daily breakdown for line charts
    let currentPeriodDailyData;
    let previousPeriodDailyData;

    // Determine if the current date range is weekly or daily-focused for fixed-day charts
    const isWeeklyRange = ['today', 'week', 'lastWeek'].includes(dateRange);

    if (isWeeklyRange) {
      // For weekly ranges (and today, which is a single day, can fit in this too for XAxis consistency)
      // Create a fixed 7-day structure (Mon-Sun) - ALWAYS show all 7 days
      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const weeklyDataMap = new Map(dayNames.map((day) => [day, { day, completed: 0, failed: 0, returned: 0, total: 0, prevCompleted: 0, prevFailed: 0, prevReturned: 0, prevTotal: 0 }]));

      const processDeliveriesForWeeklyMap = (deliveriesToProcess, isPrevious = false) => {
        deliveriesToProcess.forEach((delivery) => {
          if (!delivery.delivery_date) return;
          const deliveryDate = new Date(delivery.delivery_date + 'T00:00:00');
          const dayIndex = (deliveryDate.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
          const dayName = dayNames[dayIndex];
          const dayData = weeklyDataMap.get(dayName);

          if (isPrevious) {
            dayData.prevTotal++;
            const patient = patients.find((p) => p.id === delivery.patient_id);
            const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
            const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
            const isReturned = notesReturn || addressReturn;
            
            if (isReturned) {
              dayData.prevReturned++;
            } else if (delivery.status === 'completed') {
              dayData.prevCompleted++;
            }
            if (delivery.status === 'failed') dayData.prevFailed++;
          } else {
            dayData.total++;
            const patient = patients.find((p) => p.id === delivery.patient_id);
            const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
            const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
            const isReturned = notesReturn || addressReturn;
            
            if (isReturned) {
              dayData.returned++;
            } else if (delivery.status === 'completed') {
              dayData.completed++;
            }
            if (delivery.status === 'failed') dayData.failed++;
          }
        });
      };

      processDeliveriesForWeeklyMap(relevantDeliveries, false);
      if (prevStartDate && prevEndDate) {
        processDeliveriesForWeeklyMap(prevRelevantDeliveries, true);
      }
      currentPeriodDailyData = Array.from(weeklyDataMap.values()); // This will be the merged data for weekly views
      previousPeriodDailyData = []; // Not needed as it's merged into currentPeriodDailyData
    } else {
      // For monthly/quarterly/yearly ranges, use date-based breakdown
      // CRITICAL: Generate entries for ALL dates in the range, even if no data
      const dailyStats = {};
      
      // Initialize all dates in current period range with zero values
      const currentDate = new Date(startDate);
      while (currentDate <= endDate) {
        const dateStr = format(currentDate, 'yyyy-MM-dd');
        dailyStats[dateStr] = { date: dateStr, completed: 0, failed: 0, returned: 0, total: 0 };
        currentDate.setDate(currentDate.getDate() + 1);
      }
      
      // Fill in actual delivery data
      relevantDeliveries.forEach((delivery) => {
        const date = delivery.delivery_date;
        if (dailyStats[date]) {
          dailyStats[date].total++;
          const patient = patients.find((p) => p.id === delivery.patient_id);
          const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
          const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
          const isReturned = notesReturn || addressReturn;
          
          if (isReturned) {
            dailyStats[date].returned++;
          } else if (delivery.status === 'completed') {
            dailyStats[date].completed++;
          }
          if (delivery.status === 'failed') dailyStats[date].failed++;
        }
      });

      const prevDailyStats = {};
      if (prevStartDate && prevEndDate) {
        // Initialize all dates in previous period range with zero values
        const prevDate = new Date(prevStartDate);
        while (prevDate <= prevEndDate) {
          const dateStr = format(prevDate, 'yyyy-MM-dd');
          prevDailyStats[dateStr] = { date: dateStr, completed: 0, failed: 0, returned: 0, total: 0 };
          prevDate.setDate(prevDate.getDate() + 1);
        }
        
        // Fill in actual delivery data
        prevRelevantDeliveries.forEach((delivery) => {
          const date = delivery.delivery_date;
          if (prevDailyStats[date]) {
            prevDailyStats[date].total++;
            const patient = patients.find((p) => p.id === delivery.patient_id);
            const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
            const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
            const isReturned = notesReturn || addressReturn;
            
            if (isReturned) {
              prevDailyStats[date].returned++;
            } else if (delivery.status === 'completed') {
              prevDailyStats[date].completed++;
            }
            if (delivery.status === 'failed') prevDailyStats[date].failed++;
          }
        });
      }

      currentPeriodDailyData = Object.values(dailyStats).sort((a, b) =>
      new Date(a.date) - new Date(b.date)
      ).map((d) => ({
        ...d,
        date: format(parseISO(d.date), 'MMM d')
      }));

      previousPeriodDailyData = Object.values(prevDailyStats).sort((a, b) =>
      new Date(a.date) - new Date(b.date)
      ).map((d) => ({
        ...d,
        date: format(parseISO(d.date), 'MMM d')
      }));
    }

    // Driver stats
    const driverStats = {};
    relevantDeliveries.forEach((delivery) => {
      const driverName = delivery.driver_name || 'Unassigned';
      const driverFirstName = driverName.split(' ')[0];
      if (!driverStats[driverFirstName]) {
        driverStats[driverFirstName] = { name: driverFirstName, completed: 0, failed: 0, returned: 0, total: 0 };
      }
      driverStats[driverFirstName].total++;
      if (delivery.status === 'completed') driverStats[driverFirstName].completed++;
      if (delivery.status === 'failed') driverStats[driverFirstName].failed++;

      const patient = patients.find((p) => p.id === delivery.patient_id);
      const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      if (notesReturn || addressReturn) driverStats[driverFirstName].returned++;
    });

    const prevDriverStats = {};
    prevRelevantDeliveries.forEach((delivery) => {
      const driverName = delivery.driver_name || 'Unassigned';
      const driverFirstName = driverName.split(' ')[0];
      if (!prevDriverStats[driverFirstName]) {
        prevDriverStats[driverFirstName] = { name: driverFirstName, completed: 0, failed: 0, returned: 0, total: 0 };
      }
      prevDriverStats[driverFirstName].total++;
      if (delivery.status === 'completed') prevDriverStats[driverFirstName].completed++;
      if (delivery.status === 'failed') prevDriverStats[driverFirstName].failed++;

      const patient = patients.find((p) => p.id === delivery.patient_id);
      const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      if (notesReturn || addressReturn) prevDriverStats[driverFirstName].returned++;
    });

    const driverData = Object.values(driverStats).sort((a, b) => b.total - a.total);
    const prevDriverData = Object.values(prevDriverStats).sort((a, b) => b.total - a.total);

    const mergedDriverData = driverData.map((current) => {
      const previous = prevDriverData.find((p) => p.name === current.name);
      return {
        ...current,
        prevCompleted: previous?.completed || 0,
        prevFailed: previous?.failed || 0,
        prevReturned: previous?.returned || 0,
        prevTotal: previous?.total || 0
      };
    });

    const result = {
      totalDeliveries,
      completedDeliveries,
      failedDeliveries,
      returnedDeliveries,
      completionRate,
      avgDistance,
      avgTimeBetweenStops,
      totalDistance: totalDistance.toFixed(2),
      avgDeliveriesPerDay,
      onTimeRate,
      statusCounts,
      dailyData: currentPeriodDailyData, // This will be the merged weekly data OR date-based current data
      prevDailyData: previousPeriodDailyData, // This will be empty for weekly, or date-based previous data for others
      driverData: mergedDriverData,
      // Previous period values for comparison
      prevTotalDeliveries,
      prevCompletedDeliveries,
      prevFailedDeliveries,
      prevReturnedDeliveries,
      prevCompletionRate,
      prevAvgDistance,
      prevAvgTimeBetweenStops,
      prevOnTimeRate,
      prevAvgDeliveriesPerDay,
      prevTotalDistance: prevTotalDistance.toFixed(2)
    };

    console.log('✅ [DeliveryMetrics] Final metrics:', result);
    return result;
  }, [deliveries, patients, selectedDriver, drivers, prevStartDate, prevEndDate, startDate, endDate, dateRange, selectedYear]);

  const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444']; // Added a color for 'returned' if needed in pie chart

  // Determine if we should show comparison overlays
  const showComparison = ['week', 'lastWeek', 'month', 'lastMonth', 'q1', 'q2', 'q3', 'q4', 'year'].includes(dateRange);
  const isWeeklyRangeForChart = ['today', 'week', 'lastWeek'].includes(dateRange);


  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p style={{ color: 'var(--text-slate-600)' }}>Loading metrics...</p>
        </div>
      </div>);

  }

  return (
    <div className="min-h-screen p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <SmartRefreshIndicator inline={true} />
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Route Metrics</h1>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p style={{ color: 'var(--text-slate-600)' }}>
                {(() => {
                  const startYear = startDate.getFullYear();
                  const endYear = endDate.getFullYear();
                  const spansCrossYear = startYear !== endYear;
                  if (spansCrossYear) {
                    return `${format(startDate, 'MMM d, yyyy')} - ${format(endDate, 'MMM d, yyyy')}`;
                  }
                  return `${format(startDate, 'MMM d')} - ${format(endDate, 'MMM d')}, ${endYear}`;
                })()}
              </p>
              {showComparison && prevStartDate && prevEndDate &&
                <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                  (vs {format(prevStartDate, 'MMM d')} - {format(prevEndDate, 'MMM d')})
                </span>
              }
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Select value={selectedYear.toString()} onValueChange={(val) => setSelectedYear(parseInt(val))}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map(year => (
                  <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="week">This Week</SelectItem>
                <SelectItem value="lastWeek">Last Week</SelectItem>
                <SelectItem value="month">This Month</SelectItem>
                <SelectItem value="lastMonth">Last Month</SelectItem>
                <SelectItem value="q1">Q1</SelectItem>
                <SelectItem value="q2">Q2</SelectItem>
                <SelectItem value="q3">Q3</SelectItem>
                <SelectItem value="q4">Q4</SelectItem>
                <SelectItem value="year">Full Year</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedDriver} onValueChange={setSelectedDriver}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All Drivers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Drivers ({drivers.length})</SelectItem>
                {drivers.map((driver) => {
                  const driverId = driver.id || driver.user_id;
                  const driverName = getDriverDisplayName(driver) || driver.full_name || driver.user_name || 'Unknown';
                  return (
                    <SelectItem key={driverId} value={driverId}>
                      {driverName}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            <Button onClick={loadData} variant="outline" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
              Refresh Data
            </Button>
          </div>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            title="Total Deliveries"
            value={metrics.totalDeliveries}
            subtitle={`${metrics.avgDeliveriesPerDay} per day avg`}
            icon={Package}
            color="blue"
            previousValue={showComparison ? metrics.prevTotalDeliveries : null} />

          <MetricCard
            title="Completion Rate"
            value={`${metrics.completionRate}%`}
            subtitle={`${metrics.completedDeliveries} completed`}
            icon={CheckCircle}
            color="green"
            previousValue={showComparison ? `${metrics.prevCompletionRate}%` : null} />

          <MetricCard
            title="Avg Time Between Stops"
            value={`${metrics.avgTimeBetweenStops} min`}
            subtitle={`${metrics.avgDistance} km per stop`}
            icon={Clock}
            color="purple"
            previousValue={showComparison ? `${metrics.prevAvgTimeBetweenStops}` : null} />

          <MetricCard
            title="On-Time Delivery"
            value={`${metrics.onTimeRate}%`}
            subtitle="Of completed deliveries"
            icon={Target}
            color="orange"
            previousValue={showComparison ? `${metrics.prevOnTimeRate}` : null} />

        </div>

        {/* Charts */}
        <Tabs defaultValue="daily" className="space-y-4">
          <TabsList style={{ background: 'var(--bg-slate-100)' }}>
            <TabsTrigger value="daily">Daily Trends</TabsTrigger>
            <TabsTrigger value="drivers">By Driver</TabsTrigger>
            <TabsTrigger value="status">Status Breakdown</TabsTrigger>
          </TabsList>

          <TabsContent value="daily" className="space-y-4">
            <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader>
                <CardTitle style={{ color: 'var(--text-slate-900)' }}>Daily Delivery Performance {isWeeklyRangeForChart && showComparison ? "(Current vs. Previous Week)" : ""}</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={metrics.dailyData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey={isWeeklyRangeForChart ? "day" : "date"} />
                    <YAxis />
                    <Tooltip 
                      formatter={(value, name, props) => {
                        // Don't modify the displayed value, just show it as-is
                        return [value, name];
                      }}
                      labelFormatter={(label) => label}
                    />
                    <Legend 
                      content={({ payload }) => {
                        if (!payload) return null;
                        const currentItems = payload.filter(item => !item.dataKey.startsWith('prev'));
                        const prevItems = payload.filter(item => item.dataKey.startsWith('prev'));
                        
                        return (
                          <div className="flex flex-col sm:flex-row justify-center gap-2 sm:gap-6 mt-2 text-xs">
                            <div className="flex flex-col items-center gap-1">
                              <span className="font-semibold text-slate-600">Current:</span>
                              <div className="flex flex-wrap justify-center gap-x-3 gap-y-1">
                                {currentItems.map((item, index) => (
                                  <span key={index} className="flex items-center gap-1">
                                    <span className="w-3 h-0.5 rounded" style={{ backgroundColor: item.color }}></span>
                                    <span style={{ color: 'var(--text-slate-600)' }}>{item.value}</span>
                                  </span>
                                ))}
                              </div>
                            </div>
                            {prevItems.length > 0 && (
                              <div className="flex flex-col items-center gap-1">
                                <span className="font-semibold text-slate-400">Previous:</span>
                                <div className="flex flex-wrap justify-center gap-x-3 gap-y-1">
                                  {prevItems.map((item, index) => (
                                    <span key={index} className="flex items-center gap-1">
                                      <span className="w-3 h-0.5 rounded opacity-60" style={{ backgroundColor: item.color, backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 2px, var(--bg-white) 2px, var(--bg-white) 4px)' }}></span>
                                      <span style={{ color: 'var(--text-slate-400)' }}>{item.value.replace('Prev ', '')}</span>
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      }}
                    />
                    <Line type="monotone" dataKey="completed" stroke="#10b981" name="Completed" strokeWidth={2} />
                    <Line type="monotone" dataKey="failed" stroke="#ef4444" name="Failed" strokeWidth={2} />
                    <Line type="monotone" dataKey="returned" stroke="#f59e0b" name="Returned" strokeWidth={2} />
                    <Line type="monotone" dataKey="total" stroke="#3b82f6" name="Total" strokeWidth={2} />
                    {showComparison && isWeeklyRangeForChart &&
                    <>
                        <Line type="monotone" dataKey="prevCompleted" stroke="#10b981" name="Prev Completed" strokeWidth={2} strokeDasharray="5 5" opacity={0.6} />
                        <Line type="monotone" dataKey="prevFailed" stroke="#ef4444" name="Prev Failed" strokeWidth={2} strokeDasharray="5 5" opacity={0.6} />
                        <Line type="monotone" dataKey="prevReturned" stroke="#f59e0b" name="Prev Returned" strokeWidth={2} strokeDasharray="5 5" opacity={0.6} />
                        <Line type="monotone" dataKey="prevTotal" stroke="#3b82f6" name="Prev Total" strokeWidth={2} strokeDasharray="5 5" opacity={0.6} />
                      </>
                    }
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Render separate chart for previous period if not a weekly range and comparison is enabled */}
            {showComparison && !isWeeklyRangeForChart && metrics.prevDailyData.length > 0 &&
            <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <CardHeader>
                  <CardTitle style={{ color: 'var(--text-slate-900)' }}>
                    Daily Delivery Performance - Previous Period
                    {prevStartDate && prevEndDate && (
                      <span className="text-sm font-normal ml-2" style={{ color: 'var(--text-slate-500)' }}>
                        ({format(prevStartDate, 'MMM d, yyyy')} - {format(prevEndDate, 'MMM d, yyyy')})
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={metrics.prevDailyData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="completed" stroke="#10b981" name="Completed" strokeWidth={2} strokeDasharray="5 5" />
                      <Line type="monotone" dataKey="failed" stroke="#ef4444" name="Failed" strokeWidth={2} strokeDasharray="5 5" />
                      <Line type="monotone" dataKey="returned" stroke="#f59e0b" name="Returned" strokeWidth={2} strokeDasharray="5 5" />
                      <Line type="monotone" dataKey="total" stroke="#3b82f6" name="Total" strokeWidth={2} strokeDasharray="5 5" />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            }
          </TabsContent>

          <TabsContent value="drivers" className="space-y-4">
            <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader>
                <CardTitle style={{ color: 'var(--text-slate-900)' }}>Performance by Driver</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={metrics.driverData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="completed" fill="#10b981" name="Completed" />
                    <Bar dataKey="failed" fill="#ef4444" name="Failed" />
                    <Bar dataKey="returned" fill="#f59e0b" name="Returned" />
                    {showComparison &&
                    <>
                        <Bar dataKey="prevCompleted" fill="#10b981" opacity={0.3} name="Prev Completed" />
                        <Bar dataKey="prevFailed" fill="#ef4444" opacity={0.3} name="Prev Failed" />
                        <Bar dataKey="prevReturned" fill="#f59e0b" opacity={0.3} name="Prev Returned" />
                      </>
                    }
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="status" className="space-y-4">
            <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader>
                <CardTitle style={{ color: 'var(--text-slate-900)' }}>Delivery Status Distribution</CardTitle>
              </CardHeader>
              <CardContent className="flex justify-center">
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={[
                      { name: 'Completed', value: metrics.statusCounts.completed },
                      { name: 'In Transit', value: metrics.statusCounts.inTransit },
                      { name: 'Pending', value: metrics.statusCounts.pending },
                      { name: 'Failed', value: metrics.statusCounts.failed },
                      { name: 'Returned', value: metrics.statusCounts.returned }]
                      }
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value">

                      <Cell key={`cell-0`} fill={COLORS[0]} />
                      <Cell key={`cell-1`} fill={COLORS[1]} />
                      <Cell key={`cell-2`} fill="#f59e0b" /> {/* Specific color for pending/returned */}
                      <Cell key={`cell-3`} fill={COLORS[3]} />
                      <Cell key={`cell-4`} fill="#eab308" /> {/* Another distinct color for returned */}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Additional Stats */}
        <div className="grid grid-cols-3 gap-4">
          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>Total Distance</CardTitle>
              <MapPin className="h-4 w-4" style={{ color: 'var(--text-slate-500)' }} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{metrics.totalDistance} km</div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>Across all routes</p>
              {showComparison &&
              <p className="text-xs mt-1" style={{ color: 'var(--text-slate-400)' }}>Previous: {metrics.prevTotalDistance} km</p>
              }
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>Failed Returned</CardTitle>
              <XCircle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{metrics.failedDeliveries}/{metrics.returnedDeliveries}</div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>Total failed and returned</p>
              {showComparison &&
              <p className="text-xs mt-1" style={{ color: 'var(--text-slate-400)' }}>Previous: {metrics.prevFailedDeliveries}/{metrics.prevReturnedDeliveries}</p>
              }
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>Avg Distance</CardTitle>
              <Truck className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{metrics.avgDistance} km</div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>Between deliveries</p>
              {showComparison &&
              <p className="text-xs mt-1" style={{ color: 'var(--text-slate-400)' }}>Previous: {metrics.prevAvgDistance} km</p>
              }
            </CardContent>
          </Card>
        </div>
      </div>
    </div>);

}