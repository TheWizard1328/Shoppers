import React from "react";
import { Badge } from "@/components/ui/badge";
import { Phone, Bell, BellOff, Mailbox, StickyNote } from "lucide-react";

/**
 * Centralized utility for rendering special delivery symbol badges
 * Used across DeliveryForm, StopCard, and other components
 * 
 * @param {Object} options - Configuration options
 * @param {Object} options.delivery - Delivery object with flags
 * @param {Object} options.patient - Patient object with preferences (optional)
 * @param {boolean} options.isPickup - Whether this is a pickup (no preference icons)
 * @param {string} options.size - Badge size: 'sm' | 'md' | 'lg' (default: 'md')
 * @param {boolean} options.showPreferences - Whether to show preference icons (default: true)
 * @param {boolean} options.showSpecialFlags - Whether to show special flags badge (default: true)
 * @param {string} options.failedStatus - If delivery.status === 'failed', show strikethrough on COD
 */

// Size configurations
const SIZES = {
  sm: {
    badgeClass: "text-[9px] px-1 py-0 h-4",
    iconClass: "w-2.5 h-2.5",
    containerClass: "gap-0.5 px-1 py-0 h-4"
  },
  md: {
    badgeClass: "text-[10px] px-1.5 py-0 h-4",
    iconClass: "w-3 h-3",
    containerClass: "gap-0.5 px-1 py-0 h-4"
  },
  lg: {
    badgeClass: "text-sm px-2 py-0.5",
    iconClass: "w-4 h-4",
    containerClass: "gap-1 px-1.5 py-0.5"
  }
};

/**
 * Get special flags content (COD, First Delivery, Oversized, Fridge, Signature)
 */
export function getSpecialFlagsContent(delivery, patient, isFailedStatus = false) {
  const hasCOD = (delivery?.cod_total_amount_required || 0) > 0;
  const isFirstDelivery = delivery?.first_delivery === true || 
    patient?.notes?.toLowerCase().includes('first delivery') ||
    delivery?.delivery_instructions?.toLowerCase().includes('first delivery') ||
    delivery?.delivery_notes?.toLowerCase().includes('first delivery') ||
    (patient && !patient.last_delivery_date);
  const hasOversized = delivery?.oversized === true;
  const hasFridge = delivery?.fridge_item === true;
  const hasSignature = delivery?.signature_needed === true;
  const hasDriverNotes = !!(delivery?.delivery_notes);

  const hasAnyFlag = hasCOD || isFirstDelivery || hasOversized || hasFridge || hasSignature || hasDriverNotes;

  return {
    hasCOD,
    isFirstDelivery,
    hasOversized,
    hasFridge,
    hasSignature,
    hasDriverNotes,
    hasAnyFlag,
    isFailedStatus
  };
}

/**
 * Get preference flags (Call, Ring Bell, Don't Ring Bell, Mailbox OK)
 */
export function getPreferenceFlagsContent(delivery, patient, isPickup = false) {
  if (isPickup) {
    return {
      hasCallOnArrival: false,
      hasRingBell: false,
      hasDontRingBell: false,
      hasMailboxOk: false,
      hasAnyPreference: false
    };
  }

  const hasCallOnArrival = delivery?.call_upon_arrival || patient?.call_upon_arrival;
  const hasRingBell = (delivery?.ring_bell || patient?.ring_bell) && 
    !(delivery?.dont_ring_bell || patient?.dont_ring_bell);
  const hasDontRingBell = delivery?.dont_ring_bell || patient?.dont_ring_bell;
  const hasMailboxOk = delivery?.mailbox_ok || patient?.mailbox_ok;
  const hasDriverNotes = !!(delivery?.delivery_notes);

  const hasAnyPreference = hasCallOnArrival || hasRingBell || hasDontRingBell || hasMailboxOk || hasDriverNotes;

  return {
    hasCallOnArrival,
    hasRingBell,
    hasDontRingBell,
    hasMailboxOk,
    hasDriverNotes,
    hasAnyPreference
  };
}

/**
 * Render special flags badge ($ N O F S)
 */
export function SpecialFlagsBadge({ 
  delivery, 
  patient, 
  size = 'md',
  className = ''
}) {
  const flags = getSpecialFlagsContent(delivery, patient, delivery?.status === 'failed');
  const sizeConfig = SIZES[size] || SIZES.md;

  if (!flags.hasAnyFlag) return null;

  return (
    <Badge 
      className={`bg-yellow-400 text-black font-bold ${sizeConfig.badgeClass} ${className}`}
    >
      {flags.hasCOD && (
        <span className="relative inline-flex items-center justify-center">
          $
          {flags.isFailedStatus && (
            <svg
              className="absolute"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ef4444"
              strokeWidth="2.5"
              style={{
                pointerEvents: 'none',
                width: '260%',
                height: '260%',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)'
              }}
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="4" y1="4" x2="20" y2="20" />
            </svg>
          )}
        </span>
      )}
      {flags.isFirstDelivery && (flags.hasCOD ? ' N' : 'N')}
      {flags.hasOversized && (flags.hasCOD || flags.isFirstDelivery ? ' O' : 'O')}
      {flags.hasFridge && (flags.hasCOD || flags.isFirstDelivery || flags.hasOversized ? ' F' : 'F')}
      {flags.hasSignature && (flags.hasCOD || flags.isFirstDelivery || flags.hasOversized || flags.hasFridge ? ' S' : 'S')}
    </Badge>
  );
}

/**
 * Render preference icons (Phone, Bell, BellOff, Mailbox, StickyNote)
 */
export function PreferenceIconsBadge({ 
  delivery, 
  patient, 
  isPickup = false,
  size = 'md',
  className = ''
}) {
  const prefs = getPreferenceFlagsContent(delivery, patient, isPickup);
  const sizeConfig = SIZES[size] || SIZES.md;

  if (!prefs.hasAnyPreference) return null;

  return (
    <div className={`flex items-center bg-slate-200 rounded ${sizeConfig.containerClass} ${className}`}>
      {prefs.hasCallOnArrival && <Phone className={`${sizeConfig.iconClass} text-amber-600`} />}
      {prefs.hasRingBell && <Bell className={`${sizeConfig.iconClass} text-emerald-600`} />}
      {prefs.hasDontRingBell && <BellOff className={`${sizeConfig.iconClass} text-red-600`} />}
      {prefs.hasMailboxOk && <Mailbox className={`${sizeConfig.iconClass} text-blue-600`} />}
      {prefs.hasDriverNotes && <StickyNote className={`${sizeConfig.iconClass} text-purple-600`} />}
    </div>
  );
}

/**
 * Combined badge component - renders both special flags and preference icons
 * Great for compact displays like staged lists
 */
export function CombinedSpecialBadges({
  delivery,
  patient,
  isPickup = false,
  size = 'md',
  showSpecialFlags = true,
  showPreferences = true,
  className = ''
}) {
  const flags = getSpecialFlagsContent(delivery, patient, delivery?.status === 'failed');
  const prefs = getPreferenceFlagsContent(delivery, patient, isPickup);

  if (!flags.hasAnyFlag && !prefs.hasAnyPreference) return null;

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {showSpecialFlags && flags.hasAnyFlag && (
        <SpecialFlagsBadge delivery={delivery} patient={patient} size={size} />
      )}
      {showPreferences && prefs.hasAnyPreference && (
        <PreferenceIconsBadge delivery={delivery} patient={patient} isPickup={isPickup} size={size} />
      )}
    </div>
  );
}

/**
 * Check if delivery/patient has any special badges to display
 * Useful for conditional rendering of badge containers
 */
export function hasAnySpecialBadges(delivery, patient, isPickup = false) {
  const flags = getSpecialFlagsContent(delivery, patient);
  const prefs = getPreferenceFlagsContent(delivery, patient, isPickup);
  return flags.hasAnyFlag || prefs.hasAnyPreference;
}

export default {
  SpecialFlagsBadge,
  PreferenceIconsBadge,
  CombinedSpecialBadges,
  getSpecialFlagsContent,
  getPreferenceFlagsContent,
  hasAnySpecialBadges
};