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

export default function DualStatsMarquee({
  deliveryStats, // Stats from getDeliveryStats function
  localStats, // Stats calculated locally in Dashboard (for pickup counts)
  isDispatcher,
  isDriver,
  performanceStats, // { totalPay, totalKm, totalExtraKm, totalTimeOnDuty }
  liveDistance = 0, // Live travel_dist from current next delivery
  liveTimeOnDuty = null // Live time on duty (null = use backend value)
}) {
  // CRITICAL: For DRIVERS - basic numbers are deliveries, superscripts are pickups
  // For DISPATCHERS - basic numbers are deliveries, superscripts are unique driver counts
  
  // CRITICAL: Don't show 0's during refresh - preserve previous values if localStats is undefined/empty
  // This prevents the marquee from flashing all zeros during data refreshes
  const hasValidLocalStats = localStats && (
    localStats.total > 0 || 
    localStats.completed > 0 || 
    localStats.inTransit > 0 ||
    localStats.failed > 0 ||
    localStats.returned > 0
  );
  
  // Basic values (patient deliveries only)
  const totalDeliveries = hasValidLocalStats ? (localStats?.total || 0) : (localStats?.total ?? null);
  const completedDeliveries = hasValidLocalStats ? (localStats?.completed || 0) : (localStats?.completed ?? null);
  const failedDeliveries = hasValidLocalStats ? (localStats?.failed || 0) : (localStats?.failed ?? null);
  const returnedDeliveries = hasValidLocalStats ? (localStats?.returned || 0) : (localStats?.returned ?? null);
  
  // Pickup values for drivers
  const totalPickups = hasValidLocalStats ? (localStats?.totalPickups || 0) : (localStats?.totalPickups ?? null);
  const activePickups = hasValidLocalStats ? (localStats?.activePickupsEnRoute || 0) : (localStats?.activePickupsEnRoute ?? null);
  const completedPickups = hasValidLocalStats ? (localStats?.completedPickups || 0) : (localStats?.completedPickups ?? null);
  
  // Active delivery counts (for active stops badge)
  const inTransitDeliveries = hasValidLocalStats ? (localStats?.inTransit || 0) : (localStats?.inTransit ?? null);
  
  // If all values are null (refresh in progress), don't render anything yet
  if (totalDeliveries === null && completedDeliveries === null && inTransitDeliveries === null) {
    return null;
  }
  
  // Driver counts for dispatchers (from backend stats)
  // CRITICAL: Safely access nested property with null checks
  const stats = (deliveryStats && deliveryStats.today) ? deliveryStats.today : {
    completed: 0,
    activeStops: 0,
    failed: 0,
    returns: 0,
    activeDrivers: 0,
    inTransitDrivers: 0
  };
  
  const totalDrivers = stats.activeDrivers || 0;
  const inTransitDrivers = stats.inTransitDrivers || 0;
  const completedDrivers = stats.activeDrivers || 0;
  
  // Build tooltips
  const tooltipValues = {
    total: isDispatcher 
      ? `Total Deliveries: ${totalDeliveries} (${totalDrivers} drivers)` 
      : isDriver && totalPickups > 0
        ? `Total Deliveries: ${totalDeliveries}, Total Pickups: ${totalPickups}`
        : `Total Stops: ${totalDeliveries}`,
    activeStops: isDispatcher 
      ? `In Transit Deliveries: ${inTransitDeliveries} (${inTransitDrivers} on-duty drivers)` 
      : isDriver && activePickups > 0
        ? `In Transit Deliveries: ${inTransitDeliveries}, En Route Pickups: ${activePickups}`
        : `Active Stops: ${inTransitDeliveries}`,
    completed: isDispatcher 
      ? `Completed Deliveries: ${completedDeliveries} (${completedDrivers} drivers)` 
      : isDriver && completedPickups > 0
        ? `Completed Deliveries: ${completedDeliveries}, Completed Pickups: ${completedPickups}`
        : `Completed Stops: ${completedDeliveries}`,
    failed: `Failed: ${failedDeliveries}, Returned: ${returnedDeliveries}`
  };
  return (
    <div className="py-0.5">
      {/* Row 1: Delivery Stats - 4 columns */}
      <div className="grid grid-cols-4 gap-1 mb-2">
        <StatBadge
          icon={Package}
          value={totalDeliveries ?? 0}
          driverCount={isDispatcher ? totalDrivers : isDriver && (totalPickups ?? 0) > 0 ? (totalPickups ?? 0) : undefined}
          color="blue"
          label="Total"
          tooltip={tooltipValues.total} />

        <StatBadge
          icon={Truck}
          value={inTransitDeliveries ?? 0}
          driverCount={isDispatcher ? inTransitDrivers : isDriver && (activePickups ?? 0) > 0 ? (activePickups ?? 0) : undefined}
          color="purple"
          label="Active"
          tooltip={tooltipValues.activeStops} />

        <StatBadge
          icon={CheckCircle}
          value={completedDeliveries ?? 0}
          driverCount={isDispatcher && (completedDeliveries ?? 0) > 0 ? completedDrivers : isDriver && (completedPickups ?? 0) > 0 ? (completedPickups ?? 0) : undefined}
          color="green"
          label="Completed"
          tooltip={tooltipValues.completed} />

        <StatBadge
          icon={XCircle}
          value={`${failedDeliveries ?? 0}/${returnedDeliveries ?? 0}`}
          color="red"
          label="Failed/Returned"
          tooltip={tooltipValues.failed} />
      </div>

      {/* Row 2: Performance Stats - 4 columns - Show for drivers only, NOT dispatchers */}
      {!isDispatcher && (
        <div className="grid grid-cols-4 gap-1">
          <StatBadge
            icon={DollarSign}
            value={`${performanceStats?.totalPay?.toFixed(2) || '0.00'}`}
            color="green"
            label="Pay"
            tooltip={`Total Pay: ${performanceStats?.totalPay?.toFixed(2) || '0.00'}`}
            small />

          <StatBadge
            icon={Route}
            value={`${liveDistance > 0 ? liveDistance.toFixed(2) : (performanceStats?.totalKm?.toFixed(2) || '0.00')}k`}
            color="blue"
            label="Km"
            tooltip={liveDistance > 0 ? `Total Distance (Live): ${liveDistance.toFixed(2)} km` : `Total Distance: ${performanceStats?.totalKm?.toFixed(2) || '0.00'} km`}
            small />

          <StatBadge
            icon={TrendingUp}
            value={`${performanceStats?.totalExtraKm?.toFixed(2) || '0.00'}k`}
            color="amber"
            label="Extra"
            tooltip={`Extra Km (beyond ${performanceStats?.extraKmLimit || 0} km limit): ${performanceStats?.totalExtraKm?.toFixed(2) || '0.00'} km`}
            small />

          <StatBadge
            icon={Clock}
            value={liveTimeOnDuty ?? performanceStats?.totalTimeOnDuty ?? '00:00'}
            color="purple"
            label="Duty"
            tooltip={`Time on Duty: ${liveTimeOnDuty ?? performanceStats?.totalTimeOnDuty ?? '00:00'} (first stop to now, minus breaks)`}
            small />
        </div>
      )}
    </div>);

}