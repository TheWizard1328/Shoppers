import React, { useMemo } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2 } from 'lucide-react';
import { globalFilters } from '@/components/utils/globalFilters';
import { useAppData } from '@/components/utils/AppDataContext';

export default function MainCitySelector() {
  const { cities = [] } = useAppData();
  const selectedCityId = globalFilters.getSelectedCityId();

  const sortedCities = useMemo(() => {
    return [...cities].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
  }, [cities]);

  if (!cities || cities.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
      <Building2 className="w-4 h-4" style={{ color: 'var(--text-slate-500)' }} />
      <Select 
        value={selectedCityId} 
        onValueChange={(cityId) => globalFilters.setSelectedCityId(cityId)}
      >
        <SelectTrigger className="w-[150px] h-8 text-sm" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
          <SelectValue placeholder="Select City" />
        </SelectTrigger>
        <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          {sortedCities.map(city => (
            <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>
              {city.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}