/**
 * Global focus-trap manager (owner request Oct 8 2026): whenever a dialog or
 * form overlay is open, the Tab key must cycle through THAT overlay's
 * elements only — never the underlying page.
 *
 * How it works: one capture-phase keydown listener on window. On Tab it finds
 * the topmost visible full-screen overlay (hand-rolled overlays use the
 * "fixed inset-0" pattern), and if focus is outside it, or reaches either end
 * of its focusable sequence, it wraps/prevents so the focus never escapes.
 *
 * Radix/shadcn dialogs (AlertDialog/Dialog/Sheet) already trap focus via their
 * own FocusScope — those overlays are DETECTED (their content sibling carries
 * role="dialog"/"alertdialog") and skipped so the two traps never fight.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const rects = el.getClientRects();
  if (!rects || rects.length === 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
}

function focusablesIn(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
}

/**
 * Find the topmost visible overlay scope that should own the Tab cycle.
 * Returns the overlay element, or null when no qualifying overlay is open.
 */
function topOverlayScope() {
  const roots = Array.from(document.querySelectorAll('.fixed.inset-0'));
  let best = null;
  let bestZ = -Infinity;
  for (const root of roots) {
    if (!isVisible(root)) continue;
    const cs = window.getComputedStyle(root);
    if (cs.pointerEvents === 'none') continue; // inert drag/scroll surfaces
    // Radix-managed overlay (shadcn Dialog/Sheet): its content sibling carries
    // role="dialog"/"alertdialog" in the shared portal parent — Radix already
    // traps focus there, skip it entirely.
    const parent = root.parentElement;
    if (parent && parent.querySelector(':scope > [role="dialog"], :scope > [role="alertdialog"]')) continue;
    if (focusablesIn(root).length === 0) continue; // backdrop/decoration only
    const z = Number(cs.zIndex) || 0;
    if (z >= bestZ) { bestZ = z; best = root; } // later DOM wins ties (drawn on top)
  }
  return best;
}

export function installGlobalFocusTrap() {
  const onKey = (e) => {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    const scope = topOverlayScope();
    if (!scope) return;
    const els = focusablesIn(scope);
    if (!els.length) return;
    const active = document.activeElement;
    const first = els[0];
    const last = els[els.length - 1];
    const inScope = active && scope.contains(active);
    const inCycle = inScope && els.includes(active);
    if (!inCycle) {
      // Focus outside the open overlay (or on a non-cycle element):
      // bring Tab into the overlay's first element.
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey) {
      if (active === first) { e.preventDefault(); last.focus(); }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
