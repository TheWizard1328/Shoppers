import { useRef, useCallback, useLayoutEffect } from 'react';

/**
 * Custom touch sensor for @hello-pangea/dnd, scoped to QuickRouteAdjustments only.
 *
 * WHY THIS EXISTS:
 * The library's built-in touch sensor arms a drag via a fixed 120ms long-press
 * timer (`timeForLongPress`) and — critically — cancels the PENDING drag entirely
 * if ANY touchmove fires before that timer completes (see use-touch-sensor.ts:
 * "Drag has not yet started and we are waiting for a long press" -> cancel()).
 * There is zero pixel tolerance during that window. A natural human touch-and-slide
 * gesture almost always produces a touchmove within 120ms, so the first attempt is
 * silently cancelled with no visual feedback — the user has to try again, and
 * whether the 2nd/3rd attempt succeeds is pure timing luck. This is the exact
 * "have to tap and slide twice" bug reported on touchscreen devices.
 *
 * The library's MOUSE sensor does not have this problem because it arms on a
 * PIXEL threshold (5px movement = drag), not a timer — movement during the
 * pending phase is what STARTS the drag, not what cancels it.
 *
 * This sensor mirrors the mouse sensor's pixel-threshold model for touch instead
 * of the timer model, eliminating the race entirely. Scoped as a per-component
 * `sensors` override (not a global patch/fork of node_modules) so it only affects
 * this dialog's list and survives npm installs/updates.
 */

const SLOPPY_TOUCH_THRESHOLD = 8; // px of movement before PENDING -> DRAGGING
const FORCE_PRESS_THRESHOLD = 0.15;

const idle = { type: 'IDLE' };

function isThresholdExceeded(original, current) {
  return (
    Math.abs(current.x - original.x) >= SLOPPY_TOUCH_THRESHOLD ||
    Math.abs(current.y - original.y) >= SLOPPY_TOUCH_THRESHOLD
  );
}

export default function useSloppyTouchSensor(api) {
  const phaseRef = useRef(idle);
  const unbindRef = useRef(() => {});
  const listenForCaptureRef = useRef(() => {});

  const getPhase = useCallback(() => phaseRef.current, []);
  const setPhase = useCallback((phase) => { phaseRef.current = phase; }, []);

  const unbindAll = useCallback(() => {
    unbindRef.current();
    unbindRef.current = () => {};
  }, []);

  const stop = useCallback(() => {
    if (phaseRef.current.type === 'IDLE') return;
    setPhase(idle);
    unbindAll();
    listenForCaptureRef.current();
  }, [setPhase, unbindAll]);

  const cancel = useCallback(() => {
    const phase = phaseRef.current;
    stop();
    if (phase.type === 'DRAGGING') {
      phase.actions.cancel({ shouldBlockNextClick: true });
    } else if (phase.type === 'PENDING') {
      phase.actions.abort();
    }
  }, [stop]);

  const completed = useCallback(() => {
    setPhase(idle);
    unbindAll();
    listenForCaptureRef.current();
  }, [setPhase, unbindAll]);

  const bindCapturingEvents = useCallback(() => {
    const options = { capture: false, passive: false };
    const windowOptions = { capture: true, passive: false };

    const onTouchMove = (event) => {
      const phase = getPhase();
      if (phase.type === 'IDLE') return;

      const touch = event.touches[0];
      if (!touch) return;
      const point = { x: touch.clientX, y: touch.clientY };

      if (phase.type === 'DRAGGING') {
        event.preventDefault();
        phase.actions.move(point);
        return;
      }

      // PENDING: arm the drag once movement exceeds the pixel threshold —
      // NO cancellation on movement, unlike the stock touch sensor's timer gate.
      if (!isThresholdExceeded(phase.point, point)) return;

      event.preventDefault();
      const actions = phase.actions.fluidLift(point);
      setPhase({ type: 'DRAGGING', actions });
    };

    const onTouchEnd = (event) => {
      const phase = getPhase();
      if (phase.type === 'IDLE') return;
      if (phase.type === 'PENDING') {
        // Released before threshold exceeded — treat as a tap, not a drag.
        // Don't preventDefault so normal tap/click behavior still works.
        phase.actions.abort();
        setPhase(idle);
        unbindAll();
        listenForCaptureRef.current();
        return;
      }
      event.preventDefault();
      phase.actions.drop({ shouldBlockNextClick: true });
      completed();
    };

    const onTouchCancel = () => {
      if (getPhase().type === 'IDLE') return;
      cancel();
    };

    const onTouchForceChange = (event) => {
      const phase = getPhase();
      if (phase.type !== 'PENDING') return;
      const touch = event.touches[0];
      if (!touch || typeof touch.force !== 'number') return;
      if (touch.force < FORCE_PRESS_THRESHOLD) return;
      if (phase.actions.shouldRespectForcePress()) cancel();
    };

    const onOrientationOrResize = () => cancel();
    const onContextMenu = (event) => event.preventDefault();
    const onKeyDown = (event) => {
      if (getPhase().type === 'IDLE') return;
      if (event.key === 'Escape') event.preventDefault();
      cancel();
    };
    const onVisibilityChange = () => cancel();

    window.addEventListener('touchmove', onTouchMove, options);
    window.addEventListener('touchend', onTouchEnd, options);
    window.addEventListener('touchcancel', onTouchCancel, options);
    window.addEventListener('touchforcechange', onTouchForceChange, options);
    window.addEventListener('orientationchange', onOrientationOrResize, windowOptions);
    window.addEventListener('resize', onOrientationOrResize, windowOptions);
    window.addEventListener('contextmenu', onContextMenu, windowOptions);
    window.addEventListener('keydown', onKeyDown, windowOptions);
    document.addEventListener('visibilitychange', onVisibilityChange, windowOptions);

    unbindRef.current = () => {
      window.removeEventListener('touchmove', onTouchMove, options);
      window.removeEventListener('touchend', onTouchEnd, options);
      window.removeEventListener('touchcancel', onTouchCancel, options);
      window.removeEventListener('touchforcechange', onTouchForceChange, options);
      window.removeEventListener('orientationchange', onOrientationOrResize, windowOptions);
      window.removeEventListener('resize', onOrientationOrResize, windowOptions);
      window.removeEventListener('contextmenu', onContextMenu, windowOptions);
      window.removeEventListener('keydown', onKeyDown, windowOptions);
      document.removeEventListener('visibilitychange', onVisibilityChange, windowOptions);
    };
  }, [getPhase, setPhase, cancel, completed, unbindAll]);

  const onTouchStartRef = useRef(null);
  onTouchStartRef.current = (event) => {
    if (event.defaultPrevented) return;

    const draggableId = api.findClosestDraggableId(event);
    if (!draggableId) return;

    const actions = api.tryGetLock(draggableId, stop, { sourceEvent: event });
    if (!actions) return;

    const touch = event.touches[0];
    const point = { x: touch.clientX, y: touch.clientY };

    unbindAll();
    setPhase({ type: 'PENDING', point, actions });
    bindCapturingEvents();
  };

  const listenForCapture = useCallback(() => {
    const handler = (event) => onTouchStartRef.current(event);
    const options = { capture: true, passive: false };
    window.addEventListener('touchstart', handler, options);
    unbindRef.current = () => window.removeEventListener('touchstart', handler, options);
  }, []);
  listenForCaptureRef.current = listenForCapture;

  useLayoutEffect(() => {
    listenForCapture();
    return () => unbindAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
