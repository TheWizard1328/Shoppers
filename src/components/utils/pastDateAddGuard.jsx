// PAST-DATE ADD GATE (owner spec Oct 28 2026)
//
// Deliveries must not slip into a past date by accident:
//   • ADMIN  — allowed, but ALWAYS behind a popup that names what is about to
//              happen: adding into a past COMPLETED route, into a past date
//              that has NO stops for the driver, or into a past route that is
//              still unfinished.
//   • DRIVER / DISPATCHER — the Add To Route button is DISABLED on any past
//              date (past dates are read-only for them).
//
// Pure helpers only — no React, no side effects, so both the button state and
// the confirm popup read from ONE rule set.

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

const startOfLocalDay = (value) => {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

export const isPastDateValue = (value) => {
  const day = startOfLocalDay(value);
  if (!day) return false;
  const today = startOfLocalDay(new Date());
  return day.getTime() < today.getTime();
};

export const isAdminUser = (user) => {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (role === 'admin' || role === 'app owner') return true;
  const roles = Array.isArray(user.app_roles) ? user.app_roles : [];
  return roles.some((r) => String(r || '').toLowerCase() === 'admin');
};

const formatDay = (value) => {
  const day = startOfLocalDay(value);
  if (!day) return 'that date';
  return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

/**
 * @returns {{
 *   isPast: boolean,
 *   routeState: 'current'|'empty'|'completed'|'incomplete',
 *   blocked: boolean,
 *   needsConfirm: boolean,
 *   title: string,
 *   message: string
 * }}
 */
export const getPastDateAddGuard = ({ selectedDate, deliveries, currentUser } = {}) => {
  const isPast = isPastDateValue(selectedDate);
  if (!isPast) {
    return { isPast: false, routeState: 'current', blocked: false, needsConfirm: false, title: '', message: '' };
  }

  const rows = (Array.isArray(deliveries) ? deliveries : []).filter(Boolean);
  const hasStops = rows.length > 0;
  const allTerminal = hasStops && rows.every((d) => TERMINAL_STATUSES.includes(String(d.status || '').toLowerCase()));
  const routeState = !hasStops ? 'empty' : allTerminal ? 'completed' : 'incomplete';
  const dayLabel = formatDay(selectedDate);

  if (!isAdminUser(currentUser)) {
    return {
      isPast: true,
      routeState,
      blocked: true,
      needsConfirm: false,
      title: 'Past date',
      message: `${dayLabel} is a past date. Only an admin can add a delivery to a past date.`,
    };
  }

  if (routeState === 'completed') {
    return {
      isPast: true,
      routeState,
      blocked: false,
      needsConfirm: true,
      title: 'Past completed route',
      message: `You are about to add a delivery to the PAST COMPLETED route for ${dayLabel}. The route will reopen and be re-optimized with the new stop. Continue?`,
    };
  }

  if (routeState === 'empty') {
    return {
      isPast: true,
      routeState,
      blocked: false,
      needsConfirm: true,
      title: 'Past date, no stops',
      message: `You are about to add a delivery to ${dayLabel}, a PAST date with no stops for this driver. This creates a new past route. Continue?`,
    };
  }

  return {
    isPast: true,
    routeState,
    blocked: false,
    needsConfirm: true,
    title: 'Past unfinished route',
    message: `You are about to add a delivery to ${dayLabel}, a PAST date whose route is not finished. The new stop joins that unfinished past route. Continue?`,
  };
};
