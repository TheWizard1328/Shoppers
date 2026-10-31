// ── Build counter + change log (owner request Oct 30 2026) ───────────────────
//
// OWNER REQUEST: "I would like there to be a way to see how many builds ahead I
// am from the last published live version. Maybe a (+3) next to the version
// number on the sidebar" + "keep a log of the changes made… grouped… to display
// version changes since last update."
//
// BUILD_NUMBER is a MONOTONIC counter that has nothing to do with WEB_VERSION.
// WEB_VERSION rotates back to 0 after every successful APK build, so it can
// never answer "how many pushes since the last publish". This counter only ever
// goes up, one per web-affecting push, which is why it stays correct across APK
// bumps and web resets:
//
//   buildsAhead = BUILD_NUMBER - baselineBuild
//
// baselineBuild is stamped when a PUBLISH is detected (owner device, live
// domain, i.e. the running bundle is no longer ahead of what is live). See
// changeLogState.jsx.
//
// CHANGE LOG ENTRIES — brief synopses only: what changed and in which area, and
// WHO it affects (audience). Owner-only tooling changes (issue balloon, remote
// logging, build counter itself, server-side optimizer toggle, payroll history
// host, diagnostics) are deliberately NOT logged — the owner said "we don't need
// to keep the logs that pertain to app owner only feature changes".
//
// Add one entry per shipped change, with the build number of the push that
// carried it. Keep it to one short sentence.

export const BUILD_NUMBER = 35;

// Audience keys found in entries.
//   all                  → everyone who uses the app
//   drivers              → drivers only
//   dispatchers          → dispatchers/dispatch store staff only
//   admins               → administrators / app owners only
//   drivers+dispatchers  → both sides of the delivery flow
//   dispatchers+admins   → store management + administration
export const AUDIENCE_LABELS = {
  all: 'Everyone',
  drivers: 'Drivers',
  dispatchers: 'Dispatchers',
  admins: 'Administrators',
  'drivers+dispatchers': 'Drivers & Dispatchers',
  'dispatchers+admins': 'Dispatchers & Administrators',
  'drivers+admins': 'Drivers & Administrators',
};

// Display order for the grouped dialog (broadest first).
export const AUDIENCE_ORDER = [
  'all',
  'drivers+dispatchers',
  'dispatchers+admins',
  'drivers+admins',
  'drivers',
  'dispatchers',
  'admins',
];

export const CHANGE_LOG = [
  // ── Oct 30 2026 ────────────────────────────────────────────────────────────
  { build: 3, area: 'Dashboard', audience: 'all', summary: 'Time On Duty now stops counting while a driver is on break and resumes on return.' },
  { build: 4, area: 'Dashboard', audience: 'all', summary: 'Duty status now re-reads from the server on every change so devices agree.' },
  { build: 5, area: 'Map', audience: 'all', summary: 'Overlapping stop, store and cycling markers fan out into a petal layout when zoomed in.' },
  { build: 6, area: 'Map', audience: 'all', summary: 'Marker fan-out triggers at zoom 15 on phones and zoom 16 on tablets and PCs.' },
  { build: 7, area: 'Stops', audience: 'drivers', summary: 'Update GPS is available on every unfinished pickup and inter-store stop.' },
  { build: 8, area: 'Route', audience: 'drivers', summary: 'Returning from a break restores the next delivery flag, no Start press needed.' },
  { build: 9, area: 'Time On Duty', audience: 'all', summary: 'Duty records broadcast to every device so phone and tablet show the same total.' },
  { build: 10, area: 'Time On Duty', audience: 'all', summary: 'Time On Duty rechecks every 15 seconds and only redraws when the minute changes.' },
  { build: 11, area: 'Payroll', audience: 'admins', summary: 'Edit Activity Segments saves offline first, then syncs and updates other devices.' },
  { build: 13, area: 'Route Optimization', audience: 'drivers+dispatchers', summary: 'The Fastest, Shortest or Best route preference now changes the stop order, not just the map lines.' },
  { build: 15, area: 'Route', audience: 'drivers', summary: 'A route can no longer lose its next delivery flag, including after switching to another driver and back; the next stop is restored automatically.' },
  { build: 18, area: 'Version', audience: 'all', summary: 'Version numbers now start with 2 on the new domain, including preview. The old domain keeps counting as 1.' },
  { build: 19, area: 'Map', audience: 'all', summary: 'Clustered pending markers now fan out in a line to their own pins instead of leaving the lines floating away from them.' },
  { build: 20, area: 'Map', audience: 'all', summary: 'Tapping a fanned-out pending marker opens the patient history panel again, just like a single pending marker.' },
  { build: 21, area: 'Driver Overview', audience: 'admins', summary: 'Inactive driver cards now sit in their own section under the active drivers, with a count and a collapse toggle.' },
  { build: 22, area: 'Driver Overview', audience: 'admins', summary: 'Every driver card shows a Start Date; inactive cards also show the date of their last delivery.' },
  { build: 23, area: 'Driver Overview', audience: 'admins', summary: 'Driver cards show how long they have been driving (years, months, weeks, days) under the Start Date, and your own start date is set to Feb 21, 2023.' },
  { build: 24, area: 'Route Management', audience: 'all', summary: 'The "km from store" badge in Stop Details now shows the real road distance instead of the straight-line distance.' },
  { build: 25, area: 'Payroll', audience: 'all', summary: 'Hitting Refresh on a pay period now updates its stored payroll totals even when the period is already confirmed or finalized.' },
  { build: 26, area: 'Payroll', audience: 'admins', summary: 'A driver card now shows "Paid over Net" (or "Underpaid") when the amount paid no longer matches the recalculated net, and the Extra KM by Store table counts a blank km override the same way the payroll card does.' },
  { build: 27, area: 'Payroll', audience: 'admins', summary: 'Payroll now reads each delivery\'s Km Override from the device, so the paid extra km always matches what the dashboard shows.' },
  { build: 28, area: 'Payroll', audience: 'admins', summary: 'The payroll Refresh button now re-checks every month of the pay cycle you are viewing, finalized or not.' },
  { build: 29, area: 'Payroll', audience: 'admins', summary: 'The refresh spinner on the by-store table now actually reloads the payroll data for the cycle you are viewing, and the table and driver cards always read the same numbers.' },
  { build: 30, area: 'Payroll', audience: 'admins', summary: 'Payroll refresh is now authoritative: it re-reads the selected cycle from the server and can no longer be overwritten by older cached data.' },
  { build: 31, area: 'Payroll', audience: 'admins', summary: 'The by-store refresh now only reloads payroll (no app-wide refresh storm), and paid km comes straight from the delivery records.' },
  { build: 32, area: 'Payroll', audience: 'admins', summary: 'On each driver card the Paid row now sits directly under Net, with the Paid over / Underpaid gap beneath it.' },
  { build: 33, area: 'Payroll', audience: 'admins', summary: 'The Paid over / Underpaid line only appears once an amount has been entered in the Paid field.' },
  { build: 34, area: 'Payroll', audience: 'admins', summary: 'Deliveries no longer copy the patient\'s km into their Km Override, so paid extra km always follows the patient record.' },
  { build: 35, area: 'Payroll', audience: 'admins', summary: 'Extra km is now the larger of a stop\'s Km Override and its patient km from store, fixing day and store totals that were paid too low.' },
];

/** How many pushes ahead of the last publish this build is. */
export const buildsAhead = (baselineBuild) => {
  const base = Number(baselineBuild);
  if (!Number.isFinite(base) || base <= 0) return BUILD_NUMBER;
  return Math.max(0, BUILD_NUMBER - base);
};

/** Entries shipped after the given publish baseline. */
export const entriesSince = (baselineBuild) => {
  const base = Number(baselineBuild);
  const from = Number.isFinite(base) ? base : 0;
  return CHANGE_LOG.filter((entry) => Number(entry.build) > from);
};

/**
 * Group entries by audience in AUDIENCE_ORDER, each group's items newest first.
 * Returns [{ audience, label, items }].
 */
export const groupEntriesByAudience = (entries = []) => {
  const buckets = new Map();
  entries.forEach((entry) => {
    const key = AUDIENCE_LABELS[entry.audience] ? entry.audience : 'all';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  });
  return AUDIENCE_ORDER
    .filter((audience) => buckets.has(audience))
    .map((audience) => ({
      audience,
      label: AUDIENCE_LABELS[audience],
      items: buckets.get(audience).slice().sort((a, b) => Number(b.build) - Number(a.build)),
    }));
};
