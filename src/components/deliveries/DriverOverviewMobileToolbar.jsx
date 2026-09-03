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
          <SelectTrigger className="flex-1 text-body bg-surface" style={{ borderColor: 'var(--border-slate-300)' }}>
            <SelectValue placeholder="Select City" />
          </SelectTrigger>
          <SelectContent className="bg-surface border-surface">
            <SelectItem value="all" className="text-body">All Cities</SelectItem>
            {cities.map((city) => (
              <SelectItem key={city.id} value={city.id} className="text-body">{city.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select value={selectedOverviewYear} onValueChange={onOverviewYearChange}>
        <SelectTrigger className="flex-1 text-body bg-surface" style={{ borderColor: 'var(--border-slate-300)' }}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-surface border-surface">
          <SelectItem value="all" className="text-body">All Years</SelectItem>
          {availableOverviewYears.map((year) => (
            <SelectItem key={year} value={year.toString()} className="text-body">{year}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}