import React from "react";
import { Badge } from "@/components/ui/badge";
import { Phone, Bell, BellOff, Mailbox, StickyNote, Clock } from "lucide-react";
import HelpTooltip, { HELP_CONTENT } from "../common/HelpTooltip";

/**
 * SpecialSymbolsBadges - Centralized single badge for all special delivery symbols
 * 
 * Displays characters ($ N O F S) and icons (Phone, Bell, BellOff, Mailbox, StickyNote, Clock) in ONE badge
 * Only shown for patient deliveries (not pickups) OR after hours pickups
 * 
 * @param {Object} props
 * @param {Object} props.delivery - The delivery object
 * @param {Object} props.patient - The patient object (optional)
 * @param {boolean} props.isPickup - Whether this is a pickup (if true, badge only shows for after hours pickups)
 * @param {string} props.size - Size variant: 'sm' (default), 'md', 'lg'
 * @param {string} props.className - Additional CSS classes
 * @param {boolean} props.showHelp - Whether to show the help tooltip icon
 */
export default function SpecialSymbolsBadges({
  delivery,
  patient,
  isPickup = false,
  size = 'sm',
  className = '',
  showHelp = false
}) {
  if (!delivery) return null;

  // After hours pickups show a clock icon badge
  if (isPickup && delivery.after_hours_pickup) {
    const badgeBaseClass = `bg-indigo-400 text-slate-900 mt-1 px-1.5 py-0 text-[10px] font-bold rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-indigo-500/80 h-4 inline-flex items-center gap-0.5 shadow-sm border border-indigo-500/30`;
    
    return (
      <div className="inline-flex items-center gap-1">
        <Badge className={badgeBaseClass}>
          <Clock className="w-2.5 h-2.5 text-indigo-700" />
        </Badge>
      </div>
    );
  }

  // Don't show badge for regular pickups
  if (isPickup) return null;

  // Size configurations - consistent and accessible
  const sizeConfig = {
    sm: {
      badge: 'text-[10px] px-1.5 py-0 h-4',
      icon: 'w-2.5 h-2.5',
      gap: 'gap-0.5',
      text: 'text-[10px]'
    },
    md: {
      badge: 'text-xs px-2 py-0.5 min-h-[22px]',
      icon: 'w-3.5 h-3.5',
      gap: 'gap-1',
      text: 'text-xs'
    },
    lg: {
      badge: 'text-sm px-2.5 py-1 min-h-[26px]',
      icon: 'w-4 h-4',
      gap: 'gap-1',
      text: 'text-sm'
    },
    // Card size - matches StopCard badges (stop order, status, tracking number)
    card: {
      badge: 'text-sm px-2 py-0.5 min-h-[24px] rounded-full',
      icon: 'w-3.5 h-3.5',
      gap: 'gap-0.5',
      text: 'text-sm font-bold'
    }
  };

  const config = sizeConfig[size] || sizeConfig.sm;

  // Special flags
  const hasCOD = (delivery.cod_total_amount_required || 0) > 0;
  const isFirstDelivery = delivery.first_delivery === true ||
  patient && !patient.last_delivery_date ||
  delivery.delivery_notes?.toLowerCase().includes('first delivery') ||
  delivery.delivery_instructions?.toLowerCase().includes('first delivery');
  const hasOversized = delivery.oversized === true;
  const hasFridge = delivery.fridge_item === true;
  const hasSignature = delivery.signature_needed === true;

  // Delivery preferences
  const hasCallOnArrival = delivery.call_upon_arrival || patient?.call_upon_arrival;
  const hasRingBell = (delivery.ring_bell || patient?.ring_bell) && !(delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasDontRingBell = delivery.dont_ring_bell || patient?.dont_ring_bell;
  const hasMailboxOk = delivery.mailbox_ok || patient?.mailbox_ok;
  const hasDriverNotes = !!delivery.delivery_notes;

  // Check if anything should be shown
  const hasAnyContent = hasCOD || isFirstDelivery || hasOversized || hasFridge || hasSignature ||
  hasCallOnArrival || hasRingBell || hasDontRingBell || hasMailboxOk || hasDriverNotes;

  if (!hasAnyContent) return null;

  // Use different base styles for card size vs others
  const isCardSize = size === 'card';
  const badgeBaseClass = isCardSize
    ? `bg-amber-400 text-slate-900 mt-1 ${config.badge} font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-amber-500/80 inline-flex items-center ${config.gap} shadow-sm border border-amber-500/30`
    : `bg-amber-400 text-slate-900 mt-1 px-1.5 py-0 text-[10px] font-bold rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-primary/80 h-4 inline-flex items-center gap-0.5 shadow-sm border border-amber-500/30`;

  return (
    <div className="inline-flex items-center gap-1">
      <Badge className={badgeBaseClass}>

        {/* Special flags: $ N O F S */}
        {hasCOD && <span className={`text-black ${isCardSize ? config.text : ''}`}>$</span>}
        {isFirstDelivery && <span className={`text-blue-800 ${isCardSize ? config.text : ''}`}>N</span>}
        {hasOversized && <span className={`text-orange-800 ${isCardSize ? config.text : ''}`}>O</span>}
        {hasFridge && <span className={`text-cyan-800 ${isCardSize ? config.text : ''}`}>F</span>}
        {hasSignature && <span className={`text-purple-800 ${isCardSize ? config.text : ''}`}>S</span>}
        
        {/* Preference icons - intuitive colors */}
        {hasCallOnArrival && <Phone className={`${config.icon} text-orange-600`} />}
        {hasRingBell && <Bell className={`${config.icon} text-green-600`} />}
        {hasDontRingBell && <BellOff className={`${config.icon} text-red-600`} />}
        {hasMailboxOk && <Mailbox className={`${config.icon} text-blue-600`} />}
        {hasDriverNotes && <StickyNote className={`${config.icon} text-violet-600`} />}
      </Badge>
      {showHelp &&
      <HelpTooltip
        title={HELP_CONTENT.specialSymbols.title}
        content={HELP_CONTENT.specialSymbols.content}
        size="sm" />

      }
    </div>);

}

/**
 * Helper function to check if a delivery has any special symbols
 * Useful for conditional rendering of containers
 */
export function hasSpecialSymbols(delivery, patient, isPickup = false) {
  if (!delivery || isPickup) return false;

  const hasCOD = (delivery.cod_total_amount_required || 0) > 0;
  const isFirstDelivery = delivery.first_delivery === true ||
  patient && !patient.last_delivery_date ||
  delivery.delivery_notes?.toLowerCase().includes('first delivery') ||
  delivery.delivery_instructions?.toLowerCase().includes('first delivery');
  const hasOversized = delivery.oversized === true;
  const hasFridge = delivery.fridge_item === true;
  const hasSignature = delivery.signature_needed === true;

  const hasCallOnArrival = delivery.call_upon_arrival || patient?.call_upon_arrival;
  const hasRingBell = (delivery.ring_bell || patient?.ring_bell) && !(delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasDontRingBell = delivery.dont_ring_bell || patient?.dont_ring_bell;
  const hasMailboxOk = delivery.mailbox_ok || patient?.mailbox_ok;
  const hasDriverNotes = !!delivery.delivery_notes;

  return hasCOD || isFirstDelivery || hasOversized || hasFridge || hasSignature ||
  hasCallOnArrival || hasRingBell || hasDontRingBell || hasMailboxOk || hasDriverNotes;
}

/**
 * Get special flags text only (for compact display)
 * Returns string like "$NOF S" or null if no flags
 */
export function getSpecialFlagsText(delivery, patient, isPickup = false) {
  if (!delivery || isPickup) return null;

  const parts = [];

  const hasCOD = (delivery.cod_total_amount_required || 0) > 0;
  const isFirstDelivery = delivery.first_delivery === true ||
  patient && !patient.last_delivery_date ||
  delivery.delivery_notes?.toLowerCase().includes('first delivery') ||
  delivery.delivery_instructions?.toLowerCase().includes('first delivery');
  const hasOversized = delivery.oversized === true;
  const hasFridge = delivery.fridge_item === true;
  const hasSignature = delivery.signature_needed === true;

  if (hasCOD) parts.push('$');
  if (isFirstDelivery) parts.push('N');
  if (hasOversized) parts.push('O');
  if (hasFridge) parts.push('F');
  if (hasSignature) parts.push('S');

  return parts.length > 0 ? parts.join(' ') : null;
}