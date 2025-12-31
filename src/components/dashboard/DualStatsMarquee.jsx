import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Package, Truck, CheckCircle, XCircle, DollarSign, Route, TrendingUp, Clock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const StatBadge = ({ icon: Icon, value, color, label, tooltip, driverCount }) => {
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
  <div className="px-2 flex items-center gap-2 cursor-help">
      <div className={`p-1.5 rounded-lg ${colorClasses[color]}`}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="relative">
        {driverCount !== undefined && driverCount > 0 &&
      <span className="absolute -top-1 -right-1 text-[8px] font-bold" style={{ color: 'var(--text-slate-500)' }}>
            {driverCount}
          </span>
      }
        <span className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{value}</span>
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
  stats,
  tooltipValues,
  isDispatcher,
  isDriver,
  performanceStats // { totalPay, totalKm, totalExtraKm, totalTimeOnDuty }
}) {
  const [activePanel, setActivePanel] = useState(0); // 0 = Delivery Stats, 1 = Performance Stats

  // Auto-cycle panels every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setActivePanel((prev) => prev === 0 ? 1 : 0);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative overflow-hidden" style={{ minHeight: '45px' }}>
      <AnimatePresence mode="wait">
        {activePanel === 0 ?
        <motion.div
          key="delivery-stats"
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ duration: 0.4, ease: 'easeInOut' }} className="flex items-center gap-3 flex-wrap">


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
            driverCount={isDispatcher ? stats.inTransitDrivers : isDriver && stats.inTransitPickups > 0 ? stats.inTransitPickups : undefined}
            color="purple"
            label="In Transit"
            tooltip={tooltipValues.inTransit} />

            <StatBadge
            icon={CheckCircle}
            value={stats.completed}
            driverCount={isDispatcher ? stats.completedDrivers : isDriver && stats.completedPickups > 0 ? stats.completedPickups : undefined}
            color="green"
            label="Completed"
            tooltip={tooltipValues.completed} />

            <StatBadge
            icon={XCircle}
            value={`${stats.failed}/${stats.returned}`}
            color="red"
            label="Failed/Returned"
            tooltip={tooltipValues.failed} />

          </motion.div> :

        <motion.div
          key="performance-stats"
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ duration: 0.4, ease: 'easeInOut' }}
          className="flex items-center gap-2 flex-wrap">

            <StatBadge
            icon={DollarSign}
            value={performanceStats?.totalPay !== undefined ? `${performanceStats.totalPay.toFixed(2)}` : '0.00'}
            color="green"
            label="Pay"
            tooltip={`Total Pay: $${performanceStats?.totalPay?.toFixed(2) || '0.00'}`} />

            <StatBadge
            icon={Route}
            value={performanceStats?.totalKm !== undefined ? `${performanceStats.totalKm.toFixed(2)}k` : '0.00k'}
            color="blue"
            label="Km"
            tooltip={`Total Distance: ${performanceStats?.totalKm?.toFixed(2) || '0.00'} km`} />

            <StatBadge
            icon={TrendingUp}
            value={performanceStats?.totalExtraKm !== undefined ? `${performanceStats.totalExtraKm.toFixed(2)}k` : '0.00k'}
            color="amber"
            label="Extra"
            tooltip={`Extra Km (beyond ${performanceStats?.extraKmLimit || 0} km limit): ${performanceStats?.totalExtraKm?.toFixed(2) || '0.00'} km`} />

            <StatBadge
            icon={Clock}
            value={performanceStats?.totalTimeOnDuty ? performanceStats.totalTimeOnDuty : '00:00'}
            color="purple"
            label="Duty"
            tooltip={`Total Time on Duty: ${performanceStats?.totalTimeOnDuty || '00:00'}`} />

          </motion.div>
        }
      </AnimatePresence>
    </div>);

}