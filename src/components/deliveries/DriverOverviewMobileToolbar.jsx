import React, { useEffect, useRef, useState } from "react";
import { Search, Plus, FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { userHasRole } from "../utils/userRoles";

export default function DriverOverviewMobileToolbar({
  currentUser,
  cities,
  searchTerm,
  onSearchChange,
  selectedCityId,
  onCityChange,
  selectedOverviewYear,
  onOverviewYearChange,
  availableOverviewYears,
  canAddDelivery,
  onAddDelivery,
  canImport,
  onImportRoute
}) {
  const toolbarRef = useRef(null);
  const [layout, setLayout] = useState('search-first');
  const hasCityFilter = userHasRole(currentUser, 'admin') && cities && cities.length > 0;

  useEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;

    const updateLayout = () => {
      const width = element.offsetWidth || 0;
      const filterCount = 1 + (hasCityFilter ? 1 : 0);
      const actionCount = (canAddDelivery ? 1 : 0) + (canImport ? 1 : 0);
      const singleRowMinWidth = 220 + filterCount * 140 + actionCount * 140 + (filterCount + actionCount + 2) * 12;
      const searchAndActionMinWidth = 220 + actionCount * 140 + (actionCount + 2) * 12;

      if (width >= singleRowMinWidth) setLayout('single-row');
      else if (actionCount > 0 && width >= searchAndActionMinWidth) setLayout('search-action-first');
      else setLayout('search-first');
    };

    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasCityFilter, canAddDelivery, canImport]);

  const searchField = (
    <div className="relative min-w-0 flex-1">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
      <Input
        placeholder="Search drivers..."
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        className="pl-10 w-full"
        style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
      />
    </div>
  );

  const filters = (
    <>
      {hasCityFilter && (
        <Select value={selectedCityId} onValueChange={onCityChange}>
          <SelectTrigger className="w-[140px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
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
        <SelectTrigger className="w-[140px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Years</SelectItem>
          {availableOverviewYears.map((year) => (
            <SelectItem key={year} value={year.toString()} style={{ color: 'var(--text-slate-900)' }}>{year}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );

  const actions = (
    <>
      {canAddDelivery && (
        <Button onClick={onAddDelivery} className="gap-2 w-[140px]">
          <Plus className="w-4 h-4" /> Add Delivery
        </Button>
      )}
      {canImport && (
        <Button onClick={onImportRoute} variant="outline" className="gap-2 w-[140px]">
          <FileUp className="w-4 h-4" /> Import Route
        </Button>
      )}
    </>
  );

  if (layout === 'single-row') {
    return (
      <div ref={toolbarRef} className="flex flex-wrap items-end gap-3">
        {searchField}
        <div className="flex flex-wrap items-center gap-3">{filters}</div>
        <div className="ml-auto flex flex-wrap items-center gap-3">{actions}</div>
      </div>
    );
  }

  if (layout === 'search-action-first') {
    return (
      <div ref={toolbarRef} className="space-y-3">
        <div className="flex items-end gap-3">
          {searchField}
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
        </div>
        <div className="flex flex-wrap items-center gap-3">{filters}</div>
      </div>
    );
  }

  return (
    <div ref={toolbarRef} className="space-y-3">
      {searchField}
      <div className="flex flex-wrap items-center gap-3">
        {filters}
        <div className="ml-auto flex flex-wrap items-center gap-3">{actions}</div>
      </div>
    </div>
  );
}