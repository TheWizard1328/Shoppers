import React from "react";
import { Badge } from "@/components/ui/badge";
import { Phone, Bell, BellOff, Mailbox, StickyNote } from "lucide-react";

/**
 * SpecialSymbolsBadges - Centralized single badge for all special delivery symbols
 * 
 * Displays characters ($ N O F S) and icons (Phone, Bell, BellOff, Mailbox, StickyNote) in ONE badge
 * Only shown for patient deliveries (not pickups)
 * 
 * @param {Object} props
 * @param {Object} props.delivery - The delivery object
 * @param {Object} props.patient - The patient object (optional)
 * @param {boolean} props.isPickup - Whether this is a pickup (if true, badge is hidden)
 * @param {string} props.size - Size variant: 'sm' (default), 'md', 'lg'
 * @param {string} props.className - Additional CSS classes
 */
export default function SpecialSymbolsBadges({
  delivery,
  patient,
  isPickup = false,
  size = 'sm',
  className = ''
}) {
  // Don't show badge for pickups
  if (!delivery || isPickup) return null;

  // Size configurations
  const sizeConfig = {
    sm: {
      badge: 'text-[10px] px-1 py-0 h-5',
      icon: 'w-2.5 h-2.5',
      gap: 'gap-0.5'
    },
    md: {
      badge: 'text-sm px-1 py-0.5 h-5',
      icon: 'w-4 h-4',
      gap: 'gap-0.5'
    },
    lg: {
      badge: 'text-md px-1 py-0.5 h-5',
      icon: 'w-5 h-5',
      gap: 'gap-0.5'
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

  return (
    <Badge className="bg-yellow-400 text-[10px] px-1 py-0 font-bold rounded-[10px] border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent shadow hover:bg-primary/80 h-5 inline-flex items-center gap-0.5">
      {/* Special flags: $ N O F S */}
      {hasCOD && '$'}
      {isFirstDelivery && (hasCOD ? ' N' : 'N')}
      {hasOversized && (hasCOD || isFirstDelivery ? ' O' : 'O')}
      {hasFridge && (hasCOD || isFirstDelivery || hasOversized ? ' F' : 'F')}
      {hasSignature && (hasCOD || isFirstDelivery || hasOversized || hasFridge ? ' S' : 'S')}
      
      {/* Preference icons */}
      {hasCallOnArrival && <Phone className={`${config.icon} text-blue-600`} />}
      {hasRingBell && <Bell className={`${config.icon} text-emerald-600`} />}
      {hasDontRingBell && <BellOff className={`${config.icon} text-red-600`} />}
      {hasMailboxOk && <Mailbox className={`${config.icon} text-blue-600`} />}
      {hasDriverNotes && <StickyNote className={`${config.icon} text-purple-600`} />}
    </Badge>);

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