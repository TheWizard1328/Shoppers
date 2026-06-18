import React from "react";
import { Badge } from "@/components/ui/badge";
import { Phone, Bell, BellOff, Mailbox, StickyNote, PenLine, Thermometer } from "lucide-react";
import HelpTooltip, { HELP_CONTENT } from "../common/HelpTooltip";

const TEMP_MIN = 2;
const TEMP_MAX = 8;

export function getCodSymbolColor(delivery) {
  const paymentTypes = Array.from(
    new Set((delivery?.cod_payments || []).map((payment) => String(payment?.type || '').toLowerCase()).filter(Boolean))
  );

  // Green only if collected via Debit or Credit
  if (paymentTypes.some((type) => type === 'debit' || type === 'credit')) return '#16a34a';

  // Red if delivery is complete but not collected by Debit/Credit
  if (delivery?.status === 'completed') return '#dc2626';

  return 'inherit';
}

export function getCodSymbolColorClass(delivery) {
  const color = getCodSymbolColor(delivery);
  if (color === '#16a34a') return 'text-green-600';
  if (color === '#dc2626') return 'text-red-600';
  return '';
}

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
 * @param {boolean} props.showHelp - Whether to show the help tooltip icon
 */
export default function SpecialSymbolsBadges({
  delivery,
  patient,
  isPickup = false,
  isInterStore = false,
  size = 'sm',
  className = '',
  showHelp = false,
  fridgeTemp = null,  // live or last recorded temp °C (number), passed from parent
}) {
  if (!delivery) return null;

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
  const isFirstDelivery = !isPickup && !isInterStore && (
    delivery.first_delivery === true ||
    (patient && !patient.last_delivery_date) ||
    delivery.delivery_notes?.toLowerCase().includes('first delivery') ||
    delivery.delivery_instructions?.toLowerCase().includes('first delivery')
  );
  const hasOversized = delivery.oversized === true;
  const hasSignature = !isPickup && !isInterStore && delivery.signature_needed === true;
  const hasFridgeItem = delivery.fridge_item === true;
  // Delivery preferences (patient-delivery only)
  const hasCallOnArrival = !isPickup && !isInterStore && (delivery.call_upon_arrival || patient?.call_upon_arrival);
  const hasRingBell = !isPickup && !isInterStore && (delivery.ring_bell || patient?.ring_bell) && !(delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasDontRingBell = !isPickup && !isInterStore && (delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasMailboxOk = !isPickup && !isInterStore && (delivery.mailbox_ok || patient?.mailbox_ok);
  const hasDriverNotes = !!delivery.delivery_notes;

  // Check if anything should be shown
  const hasAnyContent = hasCOD || isFirstDelivery || hasOversized || hasSignature || hasFridgeItem ||
  hasCallOnArrival || hasRingBell || hasDontRingBell || hasMailboxOk || hasDriverNotes;

  if (!hasAnyContent) return null;

  // Use different base styles for card size vs others
  const isCardSize = size === 'card';
  const badgeBaseClass = isCardSize
    ? `bg-amber-400 !text-slate-900 mt-1 ${config.badge} font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-amber-500/80 inline-flex items-center ${config.gap} shadow-sm border border-amber-500/30`
    : `bg-amber-400 !text-slate-900 mt-1 px-1.5 py-0 text-[10px] font-bold rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-primary/80 h-4 inline-flex items-center gap-0.5 shadow-sm border border-amber-500/30`;

  return (
    <div className="inline-flex items-center gap-1">
      <Badge className={badgeBaseClass}>

        {/* Special flags: $ N O F S AH */}
        {hasCOD && <span className={isCardSize ? config.text : ''} style={{ color: getCodSymbolColor(delivery) === 'inherit' ? '#0f172a' : getCodSymbolColor(delivery) }}>$</span>}
        {isFirstDelivery && <span className={`${isCardSize ? config.text : ''}`} style={{ color: '#1e40af' }}>N</span>}
        {hasOversized && <span className={`${isCardSize ? config.text : ''}`} style={{ color: '#9a3412' }}>O</span>}
        {hasFridgeItem && (() => {
          if (fridgeTemp != null) {
            const isOut = fridgeTemp < TEMP_MIN || fridgeTemp > TEMP_MAX;
            const isWarn = !isOut && (fridgeTemp < TEMP_MIN + 1 || fridgeTemp > TEMP_MAX - 1);
            const tempColor = isOut ? '#dc2626' : isWarn ? '#b45309' : '#0e7490';
            return (
              <span className="inline-flex items-center gap-px" style={{ color: tempColor }}>
                <Thermometer className={config.icon} style={{ color: tempColor }} />
                <span className={isCardSize ? config.text : ''}>{fridgeTemp.toFixed(1)}°</span>
              </span>
            );
          }
          return <span style={{ color: '#0e7490' }}><Thermometer className={`${config.icon} inline`} style={{ color: '#0e7490' }} /></span>;
        })()}
        {hasSignature && <PenLine className={config.icon} style={{ color: '#15803d' }} />}
        
        {/* Preference icons - intuitive colors, always forced (no dark mode) */}
        {hasCallOnArrival && <Phone className={config.icon} style={{ color: '#ea580c' }} />}
        {hasRingBell && <Bell className={config.icon} style={{ color: '#16a34a' }} />}
        {hasDontRingBell && <BellOff className={config.icon} style={{ color: '#dc2626' }} />}
        {hasMailboxOk && <Mailbox className={config.icon} style={{ color: '#2563eb' }} />}
        {hasDriverNotes && <StickyNote className={config.icon} style={{ color: '#7c3aed' }} />}
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
export function hasSpecialSymbols(delivery, patient, isPickup = false, isInterStore = false) {
  if (!delivery) return false;

  const hasCOD = (delivery.cod_total_amount_required || 0) > 0;
  const isFirstDelivery = !isPickup && !isInterStore && (delivery.first_delivery === true ||
    (patient && !patient.last_delivery_date) ||
    delivery.delivery_notes?.toLowerCase().includes('first delivery') ||
    delivery.delivery_instructions?.toLowerCase().includes('first delivery'));
  const hasOversized = delivery.oversized === true;
  const hasSignature = !isPickup && !isInterStore && delivery.signature_needed === true;
  const hasFridgeItem = delivery.fridge_item === true;
  const hasCallOnArrival = !isPickup && !isInterStore && (delivery.call_upon_arrival || patient?.call_upon_arrival);
  const hasRingBell = !isPickup && !isInterStore && (delivery.ring_bell || patient?.ring_bell) && !(delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasDontRingBell = !isPickup && !isInterStore && (delivery.dont_ring_bell || patient?.dont_ring_bell);
  const hasMailboxOk = !isPickup && !isInterStore && (delivery.mailbox_ok || patient?.mailbox_ok);
  const hasDriverNotes = !!delivery.delivery_notes;

  return hasCOD || isFirstDelivery || hasOversized || hasSignature || hasFridgeItem ||
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
  const hasSignature = delivery.signature_needed === true;

  if (hasCOD) parts.push('$');
  if (isFirstDelivery) parts.push('N');
  if (hasOversized) parts.push('O');
  if (hasSignature) parts.push('S');

  return parts.length > 0 ? parts.join(' ') : null;
}