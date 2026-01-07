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
  performanceStats // { totalPay, totalKm, totalExtraKm, totalTimeOnDuty }
}) {
  // Use stats directly from getDeliveryStats
  const stats = deliveryStats?.today || {
    completed: 0,
    activeStops: 0,
    failed: 0,
    returns: 0,
    activeDrivers: 0
  };
  
  // CRITICAL: Active stops = inTransit + enRoute (both patient deliveries and pickups)
  const activeStopsCount = (localStats?.inTransit || 0) + (localStats?.enRoute || 0);
  
  // CRITICAL: If localStats.total is 0, we're on an empty date - show all zeros
  const hasData = (localStats?.total || 0) > 0;
  const displayStats = hasData ? stats : { completed: 0, activeStops: 0, failed: 0, returns: 0, activeDrivers: 0 };
  
  // Build tooltips based on backend stats
  const tooltipValues = {
    total: isDispatcher 
      ? `Total: ${localStats?.total || 0} stops (${displayStats.activeDrivers} drivers)` 
      : isDriver && localStats?.totalPickups > 0
        ? `Total: ${localStats?.total || 0} stops (${localStats.totalPickups} pickups)`
        : `Total: ${localStats?.total || 0} stops`,
    activeStops: isDispatcher 
      ? `Active: ${activeStopsCount} stops (${displayStats.activeDrivers} drivers)` 
      : `Active: ${activeStopsCount} stops`,
    completed: isDispatcher 
      ? `Completed: ${displayStats.completed} stops (${displayStats.activeDrivers} drivers)` 
      : isDriver && localStats?.completedPickups > 0
        ? `Completed: ${displayStats.completed} stops (${localStats.completedPickups} pickups)`
        : `Completed: ${displayStats.completed} stops`,
    failed: `${displayStats.failed} Failed / ${displayStats.returns} Returned`
  };
  return (
    <div className="py-0.5">
      {/* Row 1: Delivery Stats - 4 columns */}
      <div className="grid grid-cols-4 gap-1 mb-2">
        <StatBadge
          icon={Package}
          value={localStats?.total || 0}
          driverCount={isDispatcher ? stats.activeDrivers : isDriver && localStats?.totalPickups > 0 ? localStats.totalPickups : undefined}
          color="blue"
          label="Total"
          tooltip={tooltipValues.total} />

        <StatBadge
          icon={Truck}
          value={activeStopsCount}
          driverCount={isDispatcher ? displayStats.activeDrivers : undefined}
          color="purple"
          label="Active"
          tooltip={tooltipValues.activeStops} />

        <StatBadge
          icon={CheckCircle}
          value={displayStats.completed}
          driverCount={isDispatcher ? displayStats.activeDrivers : isDriver && localStats?.completedPickups > 0 ? localStats.completedPickups : undefined}
          color="green"
          label="Completed"
          tooltip={tooltipValues.completed} />

        <StatBadge
          icon={XCircle}
          value={`${displayStats.failed}/${displayStats.returns}`}
          color="red"
          label="Failed/Returned"
          tooltip={tooltipValues.failed} />
      </div>

      {/* Row 2: Performance Stats - 4 columns - Show for both drivers and "All Drivers" mode */}
      {performanceStats && (
        <div className="grid grid-cols-4 gap-1">
          <StatBadge
            icon={DollarSign}
            value={performanceStats?.totalPay !== undefined ? `${performanceStats.totalPay.toFixed(2)}` : '$0.00'}
            color="green"
            label="Pay"
            tooltip={`Total Pay: $${performanceStats?.totalPay?.toFixed(2) || '0.00'}`}
            small />

          <StatBadge
            icon={Route}
            value={performanceStats?.totalKm !== undefined ? `${performanceStats.totalKm.toFixed(2)}k` : '0.00k'}
            color="blue"
            label="Km"
            tooltip={`Total Distance: ${performanceStats?.totalKm?.toFixed(2) || '0.00'} km`}
            small />

          <StatBadge
            icon={TrendingUp}
            value={performanceStats?.totalExtraKm !== undefined ? `${performanceStats.totalExtraKm.toFixed(2)}k` : '0.00k'}
            color="amber"
            label="Extra"
            tooltip={`Extra Km (beyond ${performanceStats?.extraKmLimit || 0} km limit): ${performanceStats?.totalExtraKm?.toFixed(2) || '0.00'} km`}
            small />

          <StatBadge
            icon={Clock}
            value={performanceStats?.totalTimeOnDuty ? performanceStats.totalTimeOnDuty : '00:00'}
            color="purple"
            label="Duty"
            tooltip={`Total Time on Duty: ${performanceStats?.totalTimeOnDuty || '00:00'}`}
            small />
        </div>
      )}
    </div>);

}