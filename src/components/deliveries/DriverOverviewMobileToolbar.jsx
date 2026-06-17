import React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { userHasRole } from "../utils/userRoles";

export default function DriverOverviewMobileToolbar({
  currentUser,
  cities,
  selectedCityId,
  onCityChange,
  selectedOverviewYear,
  onOverviewYearChange,
  availableOverviewYears,
}) {
  const hasCityFilter = userHasRole(currentUser, 'admin') && cities && cities.length > 0;

  return (
    <div className="flex items-center gap-3 w-full">
      {hasCityFilter && (
        <Select value={selectedCityId} onValueChange={onCityChange}>
          <SelectTrigger className="flex-1" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
            <SelectValue placeholder="Select City" />
          </SelectTrigger>
          <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Cities</SelectItem>
            {cities.map((city) => (
              <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>{city.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select value={selectedOverviewYear} onValueChange={onOverviewYearChange}>
        <SelectTrigger className="flex-1" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Years</SelectItem>
          {availableOverviewYears.map((year) => (
            <SelectItem key={year} value={year.toString()} style={{ color: 'var(--text-slate-900)' }}>{year}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}