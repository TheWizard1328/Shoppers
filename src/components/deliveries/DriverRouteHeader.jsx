import React from "react";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar as CalendarIcon } from "lucide-react";
import { userHasRole } from "../utils/userRoles";
import { getDriverDisplayName } from "../utils/driverUtils";
import { formatPhoneNumber } from "../utils/phoneFormatter";
import { sortUsers } from "../utils/sorting";
import ExportRouteButton from "./ExportRouteButton";
import { StatBox } from "./RouteManagementHelpers";

/**
 * DriverRouteHeader - shown when a specific driver is selected in Route Management.
 * Redacts the phone number for dispatchers viewing inactive drivers.
 */
export default function DriverRouteHeader({
  activeDriver,
  currentUser,
  isDriverOnline,
  driverFilter,
  effectiveDrivers,
  handleDriverChange,
  selectedDate,
  driverFilteredDeliveries,
  driverOverviewStats,
  statCardBaseWidth,
  handleStatMeasure,
  isMobile,
  setIsMobileMenuOpen,
}) {
  if (!activeDriver) return null;

  const isDispatcherViewingInactive =
    userHasRole(currentUser, 'dispatcher') &&
    !userHasRole(currentUser, 'admin') &&
    activeDriver.status === 'inactive';

  return (
    <Card
      className="flex-shrink-0 shadow-sm relative min-w-0 overflow-hidden"
      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
    >
      <button
        onClick={() => setIsMobileMenuOpen((v) => !v)}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-30 font-semibold py-3 px-1.5 rounded-r-lg shadow-lg transition-transform hover:scale-105 flex items-center justify-center lg:hidden"
        style={{
          background: 'var(--bg-white)',
          color: 'var(--text-slate-700)',
          borderTop: '1px solid var(--border-slate-200)',
          borderRight: '1px solid var(--border-slate-200)',
          borderBottom: '1px solid var(--border-slate-200)',
        }}
      >
        <CalendarIcon className="w-5 h-5" />
      </button>

      {isDriverOnline && (
        <div className="absolute top-3 left-3 w-3 h-3 bg-emerald-500 rounded-full ring-2 ring-white" />
      )}

      <CardContent className="px-3 py-1">
        <div className="flex flex-col lg:flex-row items-start lg:items-center gap-3 lg:gap-4 w-full">
          <div className="flex items-center gap-4 w-full lg:flex-1">
            <div
              className="flex-shrink-0 w-16 h-16 rounded-full flex items-center justify-center"
              style={{ background: 'var(--bg-slate-100)' }}
            >
              <span className="text-3xl font-bold" style={{ color: 'var(--text-slate-600)' }}>
                {getDriverDisplayName(activeDriver).charAt(0)}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                {getDriverDisplayName(activeDriver)}
              </h2>
              {isDispatcherViewingInactive ? (
                <p className="font-medium" style={{ color: 'var(--text-slate-400)' }}>
                  ••• ••• ••••
                </p>
              ) : (
                <p className="font-medium" style={{ color: 'var(--text-slate-600)' }}>
                  {formatPhoneNumber(activeDriver.phone)}
                </p>
              )}
              <div className="flex items-center gap-2">
                <p className="text-sm capitalize" style={{ color: 'var(--text-slate-500)' }}>
                  {activeDriver.app_roles?.[0]}
                </p>
                <span style={{ color: 'var(--text-slate-400)' }}>•</span>
                <p className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>
                  {selectedDate ? format(selectedDate, 'MMM d, yyyy') : ''}
                </p>
              </div>
            </div>

            {isMobile && effectiveDrivers?.length > 1 && (
              <div className="flex-shrink-0">
                <Select value={driverFilter} onValueChange={handleDriverChange}>
                  <SelectTrigger
                    className="w-[120px] h-9 text-xs"
                    style={{
                      background: 'var(--bg-white)',
                      borderColor: 'var(--border-slate-300)',
                      color: 'var(--text-slate-900)',
                    }}
                  >
                    <SelectValue placeholder="Driver" />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                    <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers</SelectItem>
                    {sortUsers((effectiveDrivers || []).filter((d) => userHasRole(d, 'driver'))).map((driver) => {
                      const dup = (effectiveDrivers || []).filter(
                        (x) => getDriverDisplayName(x) === getDriverDisplayName(driver)
                      );
                      const name =
                        dup.length > 1
                          ? `${getDriverDisplayName(driver)} (${driver.id.slice(-4)})`
                          : getDriverDisplayName(driver);
                      return (
                        <SelectItem
                          key={driver.id || driver.appUserId || getDriverDisplayName(driver)}
                          value={driver.id}
                          style={{ color: 'var(--text-slate-900)' }}
                        >
                          {name}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <div className="mt-2">
                  <ExportRouteButton
                    currentUser={currentUser}
                    driverFilter={driverFilter}
                    selectedDate={selectedDate}
                    driverFilteredDeliveries={driverFilteredDeliveries}
                  />
                </div>
              </div>
            )}
          </div>

          {driverOverviewStats && (
            <div className="flex gap-3 flex-shrink-0 items-center w-full lg:w-auto">
              <StatBox
                value={driverOverviewStats.totalStops}
                label="Total Stops"
                valueClass="text-slate-800"
                onMeasure={handleStatMeasure}
                fixedWidth={statCardBaseWidth || undefined}
              />
              <StatBox
                value={driverOverviewStats.completed}
                label="Completed"
                valueClass="text-emerald-600"
                onMeasure={handleStatMeasure}
                fixedWidth={statCardBaseWidth || undefined}
              />
              <StatBox
                value={`${driverOverviewStats.failed}/${driverOverviewStats.returned}`}
                label="Failed/Returned"
                valueClass="text-red-600"
                onMeasure={handleStatMeasure}
                fixedWidth={statCardBaseWidth || undefined}
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}