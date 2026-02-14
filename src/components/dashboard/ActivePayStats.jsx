import { useState, useEffect, useRef } from 'react';
import { Package, Truck, CheckCircle, XCircle, DollarSign, Route, TrendingUp, Clock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const StatBadge = ({ icon: Icon, value, color, label, tooltip, driverCount, small }) => {
  const colorClasses = {
    blue: "bg-blue-100 text-blue-600",
    purple: "bg-purple-100 text-purple-600",
    emerald: "bg-emerald-100 text-emerald-600",
    green: "bg-green-100 text-green-600",
    red: "bg-red-100 text-red-600",
    slate: "bg-slate-100 text-slate-600",
    amber: "bg-amber-100 text-amber-600"
  };

  const badge =
  <div className="px-2 flex items-center gap-1 cursor-help">
      <div className={`p-1.5 rounded-lg ${colorClasses[color]}`}>
        <Icon className="w-3 h-3" />
      </div>
      <div className="relative">
        {driverCount !== undefined && driverCount > 0 &&
      <span className="absolute -top-1 -right-1 text-[8px] font-bold" style={{ color: 'var(--text-slate-500)' }}>
            {driverCount}
          </span>
      }
        <span className={small ? "text-sm font-medium" : "text-lg font-bold"} style={{ color: 'var(--text-slate-900)' }}>{value}</span>
      </div>
    </div>;


  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {badge}
        </TooltipTrigger>
        <TooltipContent className="z-[9999] border" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-300)' }}>
          <p>{tooltip || ''}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>);

};

export default function ActivePayStats({
  deliveryStats, // Stats from getDeliveryStats function
  localStats, // Stats calculated locally in Dashboard (for pickup counts)
  isDispatcher,
  isDriver,
  performanceStats, // { totalPay, totalKm, totalExtraKm, totalTimeOnDuty }
  liveDistance = 0, // Live travel_dist from current next delivery
  liveTimeOnDuty = null, // Live time on duty (null = use backend value)
  isLoadingPayrollStats = false
}) {
  // CRITICAL: Maintain previous values to prevent clearing during updates
  const [cachedLocalStats, setCachedLocalStats] = useState(null);
  
  // CRITICAL: Update cached values when new data arrives (never clear)
  useEffect(() => {
    if (localStats && (localStats.total > 0 || localStats.completed > 0 || localStats.inTransit > 0)) {
      setCachedLocalStats(localStats);
    }
  }, [localStats]);
  
  // Use cached values if current values are empty/recalculating
  const stats = cachedLocalStats || localStats || {
    total: 0,
    inTransit: 0,
    completed: 0,
    failed: 0,
    returned: 0,
    totalPickups: 0,
    activePickupsEnRoute: 0,
    completedPickups: 0,
    totalDrivers: 0,
    inTransitDrivers: 0,
    completedDrivers: 0
  };
  
  // Use actual performanceStats (no estimates)
  const displayPay = performanceStats?.totalPay || 0;
  const displayKm = liveDistance > 0 ? liveDistance : (performanceStats?.totalKm || 0);
  const displayExtraKm = performanceStats?.totalExtraKm || 0;
  const displayTime = liveTimeOnDuty ?? performanceStats?.totalTimeOnDuty ?? '00:00';
  const extraKmLimit = performanceStats?.extraKmLimit || 0;
  
  // Build tooltips
  const tooltipValues = {
    total: isDispatcher 
      ? `Total Deliveries: ${stats.total} (${stats.totalDrivers} drivers)` 
      : isDriver && stats.totalPickups > 0
        ? `Total Deliveries: ${stats.total}, Total Pickups: ${stats.totalPickups}`
        : `Total Stops: ${stats.total}`,
    activeStops: isDispatcher 
      ? `In Transit Deliveries: ${stats.inTransit} (${stats.inTransitDrivers} on-duty drivers)` 
      : isDriver && stats.activePickupsEnRoute > 0
        ? `In Transit Deliveries: ${stats.inTransit}, En Route Pickups: ${stats.activePickupsEnRoute}`
        : `Active Stops: ${stats.inTransit}`,
    completed: isDispatcher 
      ? `Completed Deliveries: ${stats.completed} (${stats.completedDrivers} drivers)` 
      : isDriver && stats.completedPickups > 0
        ? `Completed Deliveries: ${stats.completed}, Completed Pickups: ${stats.completedPickups}`
        : `Completed Stops: ${stats.completed}`,
    failed: `Failed: ${stats.failed}, Returned: ${stats.returned}`,
    pay: isLoadingPayrollStats ? 'Loading...' : `Total Pay: $${displayPay.toFixed(2)}`,
    distance: isLoadingPayrollStats ? 'Loading...' : (liveDistance > 0 ? `Total Distance (Live): ${displayKm.toFixed(2)} km` : `Total Distance: ${displayKm.toFixed(2)} km`),
    extraKm: isLoadingPayrollStats ? 'Loading...' : `Extra Km (beyond ${extraKmLimit} km limit): ${displayExtraKm.toFixed(2)} km`,
    time: isLoadingPayrollStats ? 'Loading...' : `Time on Duty: ${displayTime} (first stop to now, minus breaks)`
  };
  
  return (
    <div className="py-0.5">
      {/* Row 1: Delivery Stats - 4 columns */}
      <div className="grid grid-cols-4 gap-1 mb-2">
        <StatBadge
          icon={Package}
          value={stats.total}
          driverCount={isDispatcher ? stats.totalDrivers : isDriver && stats.totalPickups > 0 ? stats.totalPickups : undefined}
          color="blue"
          label="Total"
          tooltip={tooltipValues.total} />

        <StatBadge
          icon={Truck}
          value={stats.inTransit}
          driverCount={isDispatcher ? stats.inTransitDrivers : isDriver && stats.activePickupsEnRoute > 0 ? stats.activePickupsEnRoute : undefined}
          color="purple"
          label="Active"
          tooltip={tooltipValues.activeStops} />

        <StatBadge
          icon={CheckCircle}
          value={stats.completed}
          driverCount={isDispatcher && stats.completed > 0 ? stats.completedDrivers : isDriver && stats.completedPickups > 0 ? stats.completedPickups : undefined}
          color="green"
          label="Completed"
          tooltip={tooltipValues.completed} />

        <StatBadge
          icon={XCircle}
          value={`${stats.failed}/${stats.returned}`}
          color="red"
          label="Failed/Returned"
          tooltip={tooltipValues.failed} />
      </div>

      {/* Row 2: Performance Stats - 4 columns - Show for drivers only, NOT dispatchers */}
      {!isDispatcher && (
        <div className="grid grid-cols-4 gap-1">
          <StatBadge
            icon={DollarSign}
            value={isLoadingPayrollStats ? '...' : `${displayPay.toFixed(2)}`}
            color="green"
            label="Pay"
            tooltip={tooltipValues.pay}
            small />

          <StatBadge
            icon={Route}
            value={isLoadingPayrollStats ? '...' : `${displayKm.toFixed(2)}k`}
            color="blue"
            label="Km"
            tooltip={tooltipValues.distance}
            small />

          <StatBadge
            icon={TrendingUp}
            value={isLoadingPayrollStats ? '...' : `${displayExtraKm.toFixed(2)}k`}
            color="amber"
            label="Extra"
            tooltip={tooltipValues.extraKm}
            small />

          <StatBadge
            icon={Clock}
            value={isLoadingPayrollStats ? '...' : displayTime}
            color="purple"
            label="Duty"
            tooltip={tooltipValues.time}
            small />
        </div>
      )}
    </div>);

}