import React from "react";
import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * HelpTooltip - A reusable component for contextual help
 * @param {string} content - The help text to display
 * @param {string} title - Optional title for the tooltip
 * @param {string} size - Size of the icon: 'sm', 'md', 'lg'
 * @param {string} className - Additional classes for positioning
 */
export default function HelpTooltip({ 
  content, 
  title, 
  size = 'sm', 
  className = '',
  side = 'top'
}) {
  const sizeClasses = {
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
    lg: 'w-5 h-5'
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={`inline-flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors ${className}`}
            onClick={(e) => e.stopPropagation()}
          >
            <HelpCircle className={sizeClasses[size]} />
          </button>
        </TooltipTrigger>
        <TooltipContent 
          side={side} 
          className="max-w-[280px] p-3 z-[10000]"
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
        >
          {title && (
            <p className="font-semibold text-sm mb-1" style={{ color: 'var(--text-slate-900)' }}>
              {title}
            </p>
          )}
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-slate-600)' }}>
            {content}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Pre-defined help content for common elements
export const HELP_CONTENT = {
  specialSymbols: {
    title: "Special Symbols",
    content: "These badges indicate special handling requirements: 💵 COD payment needed, ❄️ Fridge item (keep cold), 📦 Oversized package, ✍️ Signature required, 🆕 First delivery to this patient, 📬 Mailbox OK, 📞 Call on arrival, 🔕 Don't ring bell, 🚪 Use back door."
  },
  pendingPickups: {
    title: "Pending Pickups",
    content: "Shows the number of deliveries waiting to be picked up from this store. Tap 'Accept All' to start all pending deliveries, or tap the + button next to individual items to accept them one at a time."
  },
  startButton: {
    title: "Start Button",
    content: "Tap to begin this delivery. This marks it as your next stop and optimizes your remaining route. Your location will be tracked to provide accurate ETAs."
  },
  completeButton: {
    title: "Complete Button",
    content: "Tap when you've successfully delivered to this patient. If signature or photos are required, you'll be prompted to capture them first."
  },
  retryButton: {
    title: "Retry Button",
    content: "Tap to attempt this delivery again. The stop will be re-added to your active route and optimized based on your current location."
  },
  returnButton: {
    title: "Return Button",
    content: "Creates a return delivery back to the store for this failed delivery's items. Use this when the patient cannot receive the delivery today."
  },
  stopOrder: {
    title: "Stop Order",
    content: "The number showing your delivery sequence. Routes are optimized for efficiency, but you can manually reorder stops if needed."
  },
  trackingNumber: {
    title: "Tracking Number",
    content: "A unique identifier for this delivery, combining the store abbreviation and a sequential number. Use this to reference deliveries with dispatch."
  },
  etaTime: {
    title: "ETA / Delivery Time",
    content: "Shows the estimated arrival time based on your current location and route. After completion, shows the actual delivery time."
  },
  timeWindow: {
    title: "Time Window",
    content: "The patient's preferred delivery window. Try to deliver within this range when possible. An arrow (→) indicates 'after' this time, (←) indicates 'before'."
  },
  driverNotes: {
    title: "Driver Notes",
    content: "Add notes about this delivery that will be saved for future reference. Useful for documenting delivery instructions, issues, or special circumstances."
  },
  codCollection: {
    title: "COD Collection",
    content: "Collect payment from the patient. You can split payments across multiple methods (Cash, Debit, Credit, Check). The total must match the required amount."
  },
  patientInfo: {
    title: "Patient Info",
    content: "Important information about this patient including delivery preferences, recurring schedule, and any special notes from dispatch."
  },
  acceptAll: {
    title: "Accept All / Assign All",
    content: "Drivers see 'Accept All' to take all pending deliveries. Dispatchers see 'Assign All' to assign deliveries to the selected driver. This starts all pending stops and optimizes the route."
  }
};