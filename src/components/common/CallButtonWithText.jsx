import React, { useCallback, useRef } from 'react';
import { Phone } from 'lucide-react';
import { useDevice } from '@/components/utils/DeviceContext';
import { isCurrentDevicePrimary } from '@/components/utils/deviceManager';

/**
 * CallButtonWithText — the green round call button on a stop card, extended with
 * the patient's texting ability.
 *
 * OWNER SPEC (Nov 20 2026):
 *  - When the patient's PRIMARY number has texting enabled (`patient.sms_primary`),
 *    a small "T" shows in the upper-left edge of the call button, exactly where
 *    the C/S route-engine letter sits on the Navigate button.
 *  - A short tap still calls. A press-and-HOLD for 1.5 seconds opens the texting
 *    app for that same primary number, identical to the text badge beside the
 *    primary phone number in the expanded section of the card (same `sms:` link
 *    and the same prefilled "Hello <first name>," body).
 *  - Only a primary mobile device offers texting at all — same rule the expanded
 *    section's badge follows. On the PC or a secondary device no T appears and a
 *    hold does nothing, so the button never promises something it cannot do.
 *
 * The hold must never let the tel: link fire, so the click that follows the long
 * press is swallowed once. Context menu / callout is suppressed while a text
 * capable button is held (a long press would otherwise open the link menu).
 */
const HOLD_MS = 1500;

export default function CallButtonWithText({
  phone,
  patient = null,
  patientName = '',
  onBeforeCall,
  ariaLabel = 'Call customer',
}) {
  const device = useDevice();
  const canTextOnDevice = !!device?.isMobile && isCurrentDevicePrimary();
  const showTextBadge = canTextOnDevice && patient?.sms_primary === true && !!phone;

  const timerRef = useRef(null);
  const heldRef = useRef(false);

  const firstName = String(patient?.full_name || patientName || '').trim().split(/\s+/)[0] || '';

  const openSms = useCallback(() => {
    const digits = String(phone || '').replace(/[^0-9+]/g, '');
    if (!digits) return;
    const body = encodeURIComponent(`Hello ${firstName},\n`);
    window.location.href = `sms:${digits}?body=${body}`;
  }, [phone, firstName]);

  const clearHold = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handlePointerDown = useCallback((e) => {
    if (!showTextBadge) return;
    e.stopPropagation();
    heldRef.current = false;
    clearHold();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      heldRef.current = true;
      openSms();
    }, HOLD_MS);
  }, [showTextBadge, clearHold, openSms]);

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    if (heldRef.current) {
      // The long press already opened the texting app — do not also dial.
      e.preventDefault();
      heldRef.current = false;
      return;
    }
    onBeforeCall?.();
  }, [onBeforeCall]);

  return (
    <a
      href={`tel:${String(phone || '').replace(/\D/g, '')}`}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={clearHold}
      onPointerLeave={clearHold}
      onPointerCancel={clearHold}
      onContextMenu={(e) => { if (showTextBadge) e.preventDefault(); }}
      aria-label={ariaLabel}
      className="relative inline-flex h-14 w-14 items-center justify-center rounded-full bg-[#34A853] text-white transition-colors hover:bg-[#2D9249]"
      style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none', touchAction: 'manipulation' }}
    >
      <Phone className="w-6 h-6" />
      {showTextBadge && (
        <span
          className="absolute top-2 left-2 font-bold text-[10px] leading-none pointer-events-none text-white/90"
          title="Hold 1.5s to text this patient"
        >
          T
        </span>
      )}
    </a>
  );
}
