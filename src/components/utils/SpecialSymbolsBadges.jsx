import React from "react";
import { Badge } from "@/components/ui/badge";
import { Phone, Bell, BellOff, Mailbox, StickyNote } from "lucide-react";

/**
 * SpecialSymbolsBadges - Centralized component for rendering special delivery symbols
 * 
 * This component handles two types of badges:
 * 1. Special Flags Badge (yellow): COD ($), First Delivery (N), Oversized (O), Fridge (F), Signature (S)
 * 2. Delivery Preferences Badge (gray): Call on Arrival, Ring Bell, Don't Ring Bell, Mailbox OK, Driver Notes
 * 
 * @param {Object} props
 * @param {Object} props.delivery - The delivery object
 * @param {Object} props.patient - The patient object (optional, for fallback values)
 * @param {boolean} props.isPickup - Whether this is a pickup (hides patient-specific flags)
 * @param {string} props.size - Size variant: 'sm' (default), 'md', 'lg'
 * @param {boolean} props.showSpecialFlags - Show COD, First Delivery, Oversized, Fridge, Signature badge (default: true)
 * @param {boolean} props.showPreferences - Show delivery preference icons (default: true)
 * @param {string} props.className - Additional CSS classes for the container
 */
export default function SpecialSymbolsBadges({
  delivery,
  patient,
  isPickup = false,
  size = 'sm',
  showSpecialFlags = true,
  showPreferences = true,
  className = ''
}) {
  if (!delivery) return null;

  // Size configurations
  const sizeConfig = {
    sm: {
      badge: 'text-[10px] px-1.5 py-0 h-4',
      icon: 'w-2.5 h-2.5',
      container: 'gap-0.5'
    },
    md: {
      badge: 'text-xs px-2 py-0.5 h-5',
      icon: 'w-3 h-3',
      container: 'gap-1'
    },
    lg: {
      badge: 'text-sm px-2.5 py-1 h-6',
      icon: 'w-4 h-4',
      container: 'gap-1.5'
    }
  };

  const config = sizeConfig[size] || sizeConfig.sm;

  // Special flags
  const hasCOD = (delivery.cod_total_amount_required || 0) > 0;
  const isFirstDelivery = !isPickup && (
    delivery.first_delivery === true ||
    (patient && !patient.last_delivery_date) ||
    delivery.delivery_notes?.toLowerCase().includes('first delivery') ||
    delivery.delivery_instructions?.toLowerCase().includes('first delivery')
  );
  const hasOversized = delivery.oversized === true;
  const hasFridge = delivery.fridge_item === true;
  const hasSignature = delivery.signature_needed === true;

  // Delivery preferences (not applicable for pickups)
  const hasCallOnArrival = !isPickup && (delivery.call_upon_arrival || patient?.call_upon_arrival);
  const hasRingBell = !isPickup && (delivery.ring_bell || patient?.ring_bell) && !(delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasDontRingBell = !isPickup && (delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasMailboxOk = !isPickup && (delivery.mailbox_ok || patient?.mailbox_ok);
  const hasDriverNotes = !isPickup && !!delivery.delivery_notes;

  // Check if any badges should be shown
  const hasSpecialFlags = hasCOD || isFirstDelivery || hasOversized || hasFridge || hasSignature;
  const hasPreferences = hasCallOnArrival || hasRingBell || hasDontRingBell || hasMailboxOk || hasDriverNotes;

  if (!hasSpecialFlags && !hasPreferences) return null;

  return (
    <div className={`flex items-center ${config.container} ${className}`}>
      {/* Special Flags Badge (Yellow) */}
      {showSpecialFlags && hasSpecialFlags && (
        <Badge className={`bg-yellow-400 text-black ${config.badge} font-bold`}>
          {hasCOD && '$'}
          {isFirstDelivery && (hasCOD ? ' N' : 'N')}
          {hasOversized && (hasCOD || isFirstDelivery ? ' O' : 'O')}
          {hasFridge && (hasCOD || isFirstDelivery || hasOversized ? ' F' : 'F')}
          {hasSignature && (hasCOD || isFirstDelivery || hasOversized || hasFridge ? ' S' : 'S')}
        </Badge>
      )}

      {/* Delivery Preferences Badge (Gray with icons) */}
      {showPreferences && hasPreferences && (
        <div className={`flex items-center ${config.container} bg-slate-200 px-1 py-0 h-4 rounded`}>
          {hasCallOnArrival && <Phone className={`${config.icon} text-amber-600`} />}
          {hasRingBell && <Bell className={`${config.icon} text-emerald-600`} />}
          {hasDontRingBell && <BellOff className={`${config.icon} text-red-600`} />}
          {hasMailboxOk && <Mailbox className={`${config.icon} text-blue-600`} />}
          {hasDriverNotes && <StickyNote className={`${config.icon} text-purple-600`} />}
        </div>
      )}
    </div>
  );
}

/**
 * Helper function to check if a delivery has any special symbols
 * Useful for conditional rendering of containers
 */
export function hasSpecialSymbols(delivery, patient, isPickup = false) {
  if (!delivery) return false;

  const hasCOD = (delivery.cod_total_amount_required || 0) > 0;
  const isFirstDelivery = !isPickup && (
    delivery.first_delivery === true ||
    (patient && !patient.last_delivery_date) ||
    delivery.delivery_notes?.toLowerCase().includes('first delivery') ||
    delivery.delivery_instructions?.toLowerCase().includes('first delivery')
  );
  const hasOversized = delivery.oversized === true;
  const hasFridge = delivery.fridge_item === true;
  const hasSignature = delivery.signature_needed === true;

  const hasCallOnArrival = !isPickup && (delivery.call_upon_arrival || patient?.call_upon_arrival);
  const hasRingBell = !isPickup && (delivery.ring_bell || patient?.ring_bell);
  const hasDontRingBell = !isPickup && (delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasMailboxOk = !isPickup && (delivery.mailbox_ok || patient?.mailbox_ok);
  const hasDriverNotes = !isPickup && !!delivery.delivery_notes;

  return hasCOD || isFirstDelivery || hasOversized || hasFridge || hasSignature ||
         hasCallOnArrival || hasRingBell || hasDontRingBell || hasMailboxOk || hasDriverNotes;
}

/**
 * Get special flags text only (for compact display)
 * Returns string like "$NOF S" or null if no flags
 */
export function getSpecialFlagsText(delivery, patient, isPickup = false) {
  if (!delivery) return null;

  const parts = [];
  
  const hasCOD = (delivery.cod_total_amount_required || 0) > 0;
  const isFirstDelivery = !isPickup && (
    delivery.first_delivery === true ||
    (patient && !patient.last_delivery_date) ||
    delivery.delivery_notes?.toLowerCase().includes('first delivery') ||
    delivery.delivery_instructions?.toLowerCase().includes('first delivery')
  );
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