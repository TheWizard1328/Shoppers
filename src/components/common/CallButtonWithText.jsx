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
 * The hold must never let the call fire, so the click that follows the long
 * press is swallowed once.
 *
 * OWNER BUG (Nov 20 2026): "tapping and holding the call buttons both of them
 * isn't doing the texting of the patient". This used to be an <a href="tel:">.
 * A long press on a LINK makes Android show the native "open / copy link" menu,
 * which cancels the pointer stream (pointercancel) BEFORE the 1.5s timer fires,
 * so the hold was cleared and nothing happened. It is now a plain <button> with
 * no href: nothing native can hijack the press, the timer survives, and both
 * actions are driven in JS exactly the way the working text badge does it
 * (window.location.href = 'tel:' / 'sms:'). A scroll gesture still cancels the
 * hold via movement detection instead of pointercancel.
 */
const HOLD_MS = 1500;

export default function CallButtonWithText({
  phone,
  patient = null,
  patientName = '',
  onBeforeCall,
  ariaLabel = 'Call customer',
  title,
  // 'card' = the 56px stop-card button, 'compact' = the 40px immersive-mode FAB.
  size = 'card',
  className = '',
  style,
}) {
  const device = useDevice();
  const canTextOnDevice = !!device?.isMobile && isCurrentDevicePrimary();
  const showTextBadge = canTextOnDevice && patient?.sms_primary === true && !!phone;

  const timerRef = useRef(null);
  const heldRef = useRef(false);
  const originRef = useRef(null);

  const firstName = String(patient?.full_name || patientName || '').trim().split(/\s+/)[0] || '';

  const openSms = useCallback(() => {
    const digits = String(phone || '').replace(/[^0-9+]/g, '');
    if (!digits) return;
    const body = encodeURIComponent(`Hello ${firstName},\n`);
    window.location.href = `sms:${digits}?body=${body}`;
  }, [phone, firstName]);

  const openTel = useCallback(() => {
    const digits = String(phone || '').replace(/[^0-9+]/g, '');
    if (!digits) return;
    window.location.href = `tel:${digits}`;
  }, [phone]);

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
    originRef.current = { x: e.clientX ?? 0, y: e.clientY ?? 0 };
    clearHold();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      heldRef.current = true;
      openSms();
    }, HOLD_MS);
  }, [showTextBadge, clearHold, openSms]);

  // A scroll starting on the button must cancel the hold. Movement does that;
  // pointercancel is deliberately NOT the signal (on a link it fired from the
  // native long-press menu and killed the hold before it could fire).
  const handlePointerMove = useCallback((e) => {
    if (!timerRef.current || !originRef.current) return;
    const dx = (e.clientX ?? 0) - originRef.current.x;
    const dy = (e.clientY ?? 0) - originRef.current.y;
    if (Math.hypot(dx, dy) > 12) clearHold();
  }, [clearHold]);

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault?.();
    if (heldRef.current) {
      // The long press already opened the texting app — do not also dial.
      heldRef.current = false;
      return;
    }
    onBeforeCall?.();
    openTel();
  }, [onBeforeCall, openTel]);

  const isCompact = size === 'compact';

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearHold}
      onPointerLeave={clearHold}
      onPointerCancel={clearHold}
      onContextMenu={(e) => { if (showTextBadge) e.preventDefault(); }}
      aria-label={ariaLabel}
      title={title || ariaLabel}
      className={`relative inline-flex items-center justify-center rounded-full bg-[#34A853] text-white transition-colors hover:bg-[#2D9249] ${isCompact ? 'h-10 w-10' : 'h-14 w-14'} ${className}`}
      style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none', touchAction: 'manipulation', ...style }}
    >
      <Phone className={isCompact ? 'w-5 h-5' : 'w-6 h-6'} />
      {showTextBadge && (
        <span
          className={`absolute font-bold text-[10px] leading-none pointer-events-none text-white/90 ${isCompact ? 'top-1.5 left-1.5' : 'top-2 left-2'}`}
          title="Hold 1.5s to text this patient"
        >
          T
        </span>
      )}
    </button>
  );
}
