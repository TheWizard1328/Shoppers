import React, { useState, useEffect, useMemo } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DollarSign } from "lucide-react";
import { useAppData } from '../components/utils/AppDataContext';
import { sortUsers, sortStores } from '../components/utils/sorting';
import { userHasRole } from '../components/utils/userRoles';
import { useUser } from '../components/utils/UserContext';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import DriverPayrollGrid from '../components/payroll/DriverPayrollGrid';

export default function DriverPayroll() {
  const { currentUser } = useUser();
  const { deliveries, stores, cities, drivers } = useAppData();
  
  const currentDate = new Date();
  const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(currentDate.getMonth() + 1);
  const [selectedCityId, setSelectedCityId] = useState('all');
  const [selectedDriverId, setSelectedDriverId] = useState('all');

  // Get available years (current year and 2 years back)
  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  // Month options
  const months = [
    { value: 1, label: 'January' },
    { value: 2, label: 'February' },
    { value: 3, label: 'March' },
    { value: 4, label: 'April' },
    { value: 5, label: 'May' },
    { value: 6, label: 'June' },
    { value: 7, label: 'July' },
    { value: 8, label: 'August' },
    { value: 9, label: 'September' },
    { value: 10, label: 'October' },
    { value: 11, label: 'November' },
    { value: 12, label: 'December' }
  ];

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
          <div className="flex flex-wrap items-center gap-3">
            {/* City Filter */}
            <Select value={selectedCityId} onValueChange={setSelectedCityId}>
              <SelectTrigger className="w-[140px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
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
              <SelectTrigger className="w-[100px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
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

            {/* Month Filter */}
            <Select value={String(selectedMonth)} onValueChange={(v) => setSelectedMonth(Number(v))}>
              <SelectTrigger className="w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                {months.map(month => (
                  <SelectItem key={month.value} value={String(month.value)} style={{ color: 'var(--text-slate-900)' }}>
                    {month.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Driver Filter */}
            <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
              <SelectTrigger className="w-[160px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
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
          selectedYear={selectedYear}
          selectedMonth={selectedMonth}
          selectedDriverId={selectedDriverId}
        />
      </div>
    </div>
  );
}