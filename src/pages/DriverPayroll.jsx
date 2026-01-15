import React, { useState, useMemo, useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DollarSign, ChevronLeft, ChevronRight } from "lucide-react";
import { useAppData } from '../components/utils/AppDataContext';
import { sortUsers, sortStores } from '../components/utils/sorting';
import { useUser } from '../components/utils/UserContext';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { userHasRole } from '../components/utils/userRoles';
import { base44 } from '@/api/base44Client';
import DriverPayrollGrid from '../components/payroll/DriverPayrollGrid';
import PayrollSummaryCard from '../components/payroll/PayrollSummaryCard';

// Helper: Get first Monday of a given year
const getFirstMondayOfYear = (year) => {
  const jan1 = new Date(year, 0, 1);
  const dayOfWeek = jan1.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (dayOfWeek === 1 ? 0 : 8 - dayOfWeek);
  return new Date(year, 0, 1 + daysUntilMonday);
};

// Helper: Calculate all pay periods for a given year and pay period type
const calculateAllPeriods = (year, payPeriodType) => {
  const periods = [];
  
  switch (payPeriodType) {
    case 'weekly': {
      const firstMonday = getFirstMondayOfYear(year);
      // Add prior year period if Jan 1 is before first Monday
      const jan1 = new Date(year, 0, 1);
      if (jan1 < firstMonday) {
        periods.push({
          year,
          start: jan1,
          end: new Date(firstMonday.getTime() - 86400000), // day before first Monday
          label: `Prior Year Period`,
          isPriorYear: true
        });
      }
      // Generate weekly periods
      let weekStart = new Date(firstMonday);
      let weekNum = 1;
      const yearEnd = new Date(year, 11, 31);
      while (weekStart <= yearEnd) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        periods.push({
          year,
          start: new Date(weekStart),
          end: weekEnd > yearEnd ? yearEnd : weekEnd,
          label: `Week ${weekNum}`,
          weekNum
        });
        weekNum++;
        weekStart.setDate(weekStart.getDate() + 7);
      }
      break;
    }
    case 'biweekly': {
      const firstMonday = getFirstMondayOfYear(year);
      const jan1 = new Date(year, 0, 1);
      if (jan1 < firstMonday) {
        periods.push({
          year,
          start: jan1,
          end: new Date(firstMonday.getTime() - 86400000),
          label: `Prior Year Period`,
          isPriorYear: true
        });
      }
      let biweekStart = new Date(firstMonday);
      let periodNum = 1;
      const yearEnd = new Date(year, 11, 31);
      while (biweekStart <= yearEnd) {
        const biweekEnd = new Date(biweekStart);
        biweekEnd.setDate(biweekStart.getDate() + 13);
        periods.push({
          year,
          start: new Date(biweekStart),
          end: biweekEnd > yearEnd ? yearEnd : biweekEnd,
          label: `Period ${periodNum}`,
          periodNum
        });
        periodNum++;
        biweekStart.setDate(biweekStart.getDate() + 14);
      }
      break;
    }
    case 'semimonthly': {
      for (let month = 0; month < 12; month++) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        periods.push({
          year,
          start: new Date(year, month, 1),
          end: new Date(year, month, 15),
          label: `${new Date(year, month, 1).toLocaleString('default', { month: 'short' })} 1-15`,
          month: month + 1,
          half: 1
        });
        periods.push({
          year,
          start: new Date(year, month, 16),
          end: new Date(year, month, daysInMonth),
          label: `${new Date(year, month, 1).toLocaleString('default', { month: 'short' })} 16-${daysInMonth}`,
          month: month + 1,
          half: 2
        });
      }
      break;
    }
    case 'monthly':
    default: {
      for (let month = 0; month < 12; month++) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        periods.push({
          year,
          start: new Date(year, month, 1),
          end: new Date(year, month, daysInMonth),
          label: new Date(year, month, 1).toLocaleString('default', { month: 'long' }),
          month: month + 1
        });
      }
      break;
    }
  }
  return periods;
};

// Helper: Find current period index based on today's date
const findCurrentPeriodIndex = (periods, today) => {
  for (let i = 0; i < periods.length; i++) {
    if (today >= periods[i].start && today <= periods[i].end) {
      return i;
    }
  }
  // If not found, return closest past period
  for (let i = periods.length - 1; i >= 0; i--) {
    if (today > periods[i].end) return i;
  }
  return 0;
};

export default function DriverPayroll() {
  const { currentUser } = useUser();
  const { deliveries, stores, cities, drivers, appUsers, patients } = useAppData();
  
  const currentDate = new Date();
  const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear());
  const [selectedCityId, setSelectedCityId] = useState('all');
  const [selectedDriverId, setSelectedDriverId] = useState('all');
  const [payPeriod, setPayPeriod] = useState('monthly');
  const [selectedPeriodIndex, setSelectedPeriodIndex] = useState(0);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Determine if current user is a driver (not admin)
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin');

  // Initialize defaults based on user role
  useEffect(() => {
    if (!currentUser || hasInitialized) return;

    if (isDriver) {
      // Drivers default to viewing their own payroll
      setSelectedDriverId(currentUser.id);
      
      // Get driver's saved pay cycle type from AppUser
      const driverAppUser = appUsers?.find(au => au.user_id === currentUser.id);
      if (driverAppUser?.pay_cycle_type) {
        setPayPeriod(driverAppUser.pay_cycle_type);
      } else {
        setPayPeriod('monthly');
      }
    } else {
      // Admins default to Semi-Monthly view with All Drivers
      setSelectedDriverId('all');
      setPayPeriod('semimonthly');
    }
    setHasInitialized(true);
  }, [currentUser, appUsers, isDriver, hasInitialized]);

  // Auto-select pay cycle type when driver selection changes
  useEffect(() => {
    if (!hasInitialized) return;

    if (selectedDriverId === 'all') {
      // Default to semi-monthly when "All Drivers" is selected
      setPayPeriod('semimonthly');
    } else {
      // Load the selected driver's pay cycle type
      const driverAppUser = appUsers?.find(au => au.user_id === selectedDriverId);
      if (driverAppUser?.pay_cycle_type) {
        setPayPeriod(driverAppUser.pay_cycle_type);
      } else {
        setPayPeriod('monthly');
      }
    }
  }, [selectedDriverId, appUsers, hasInitialized]);

  // Save pay cycle type to driver's AppUser when changed (only if specific driver is selected)
  const handlePayPeriodChange = async (newPayPeriod) => {
    setPayPeriod(newPayPeriod);

    // Only save if a specific driver is selected
    if (selectedDriverId && selectedDriverId !== 'all') {
      const driverAppUser = appUsers?.find(au => au.user_id === selectedDriverId);
      if (driverAppUser) {
        try {
          await base44.entities.AppUser.update(driverAppUser.id, {
            pay_cycle_type: newPayPeriod
          });
        } catch (error) {
          console.error('Failed to save pay cycle type:', error);
        }
      }
    }
  };

  // Get available years (current year and 2 years back)
  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  // Calculate all periods for selected year and pay period type
  const allPeriods = useMemo(() => {
    return calculateAllPeriods(selectedYear, payPeriod);
  }, [selectedYear, payPeriod]);

  // Current selected period
  const currentPeriod = allPeriods[selectedPeriodIndex] || allPeriods[0];

  // Auto-select current period when pay period type or year changes
  useEffect(() => {
    const today = new Date();
    if (selectedYear === today.getFullYear()) {
      const idx = findCurrentPeriodIndex(allPeriods, today);
      setSelectedPeriodIndex(idx);
    } else {
      // If viewing past year, default to last period
      setSelectedPeriodIndex(allPeriods.length - 1);
    }
  }, [payPeriod, selectedYear, allPeriods.length]);

  // Navigation handlers
  const goToPrevPeriod = () => {
    if (selectedPeriodIndex > 0) {
      setSelectedPeriodIndex(selectedPeriodIndex - 1);
    }
  };

  const goToNextPeriod = () => {
    if (selectedPeriodIndex < allPeriods.length - 1) {
      setSelectedPeriodIndex(selectedPeriodIndex + 1);
    }
  };

  // Sort cities
  const sortedCities = useMemo(() => {
    if (!cities) return [];
    return [...cities].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
  }, [cities]);

  // Filter stores by selected city
  const filteredStores = useMemo(() => {
    if (!stores) return [];
    let filtered = stores;
    if (selectedCityId && selectedCityId !== 'all') {
      filtered = stores.filter(s => s.city_id === selectedCityId);
    }
    return sortStores(filtered);
  }, [stores, selectedCityId]);

  // Get active drivers sorted
  const sortedDrivers = useMemo(() => {
    if (!drivers) return [];
    return sortUsers(drivers.filter(d => d && d.status === 'active'));
  }, [drivers]);

  // Filter deliveries by city (through stores)
  const cityFilteredDeliveries = useMemo(() => {
    if (!deliveries) return [];
    if (selectedCityId === 'all') return deliveries;
    
    const cityStoreIds = new Set(filteredStores.map(s => s.id));
    return deliveries.filter(d => d && cityStoreIds.has(d.store_id));
  }, [deliveries, selectedCityId, filteredStores]);

  return (
    <div className="p-4 md:p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <DollarSign className="w-8 h-8 text-emerald-600" />
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Driver Payroll</h1>
          </div>
          
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            {/* City Filter */}
            <Select value={selectedCityId} onValueChange={setSelectedCityId} disabled={isDriver}>
              <SelectTrigger className="w-[110px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                <SelectValue placeholder="City" />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Cities</SelectItem>
                {sortedCities.map(city => (
                  <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>
                    {city.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Year Filter */}
            <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
              <SelectTrigger className="w-[110px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                {years.map(year => (
                  <SelectItem key={year} value={String(year)} style={{ color: 'var(--text-slate-900)' }}>
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Driver Filter */}
            <Select value={selectedDriverId} onValueChange={setSelectedDriverId} disabled={isDriver}>
              <SelectTrigger className="w-[110px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                <SelectValue placeholder="Driver" />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers</SelectItem>
                {sortedDrivers.map(driver => (
                  <SelectItem key={driver.id} value={driver.id} style={{ color: 'var(--text-slate-900)' }}>
                    {getDriverDisplayName(driver)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Grid */}
        <DriverPayrollGrid
          deliveries={cityFilteredDeliveries}
          stores={filteredStores}
          patients={patients}
          appUsers={appUsers}
          selectedYear={selectedYear}
          selectedDriverId={selectedDriverId}
          payPeriod={payPeriod}
          onPayPeriodChange={handlePayPeriodChange}
          currentPeriod={currentPeriod}
          allPeriods={allPeriods}
          selectedPeriodIndex={selectedPeriodIndex}
          onPrevPeriod={goToPrevPeriod}
          onNextPeriod={goToNextPeriod}
        />

        {/* Payroll Summary */}
        <PayrollSummaryCard
          deliveries={cityFilteredDeliveries}
          drivers={sortedDrivers}
          appUsers={appUsers}
          patients={patients}
          cities={cities}
          selectedYear={selectedYear}
          selectedDriverId={selectedDriverId}
          payPeriod={payPeriod}
          currentPeriod={currentPeriod}
        />
      </div>
    </div>
  );
}