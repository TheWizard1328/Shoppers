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

export const BUILD_NUMBER = 99;

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
  // Owner-only changes (version counter, update log, owner tooling). This key
  // was missing, so those entries silently fell into the "Everyone" bucket.
  owner: 'App Owner',
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
  'owner',
];

// ── Role views (owner request Oct 31 2026) ──────────────────────────────────
// The owner needs to see, at a glance, which changes belong to Drivers,
// Dispatchers, Administrators and himself. These are the filter tabs in the
// update log; an entry with audience 'all' applies to every role, and a
// combined audience ('drivers+dispatchers') applies to each of its parts.
export const ROLE_VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'drivers', label: 'Drivers' },
  { key: 'dispatchers', label: 'Dispatch' },
  { key: 'admins', label: 'Admins' },
  { key: 'owner', label: 'Owner' },
];

export const audienceAppliesToRole = (audience, role) => {
  const aud = String(audience || 'all');
  if (!role || role === 'all') return true;
  if (aud === 'all' || aud === role) return true;
  return aud.split('+').includes(role);
};

/** Entries (newest first) that affect the given role view. */
export const entriesForRole = (entries = [], role = 'all') => entries
  .filter((entry) => audienceAppliesToRole(entry.audience, role))
  .slice()
  .sort((a, b) => Number(b.build) - Number(a.build));

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
  { build: 36, area: 'Payroll', audience: 'admins', summary: 'The payroll spinner now rebuilds the whole selected period from the stop records (deliveries, extra km, oversized, after hours, no charge, failed and returns).' },
  { build: 37, area: 'Payroll', audience: 'admins', summary: 'The payroll spinner now rebuilds the period from the stops and patients saved on this device, so km you just corrected shows up immediately.' },
  { build: 38, area: 'Payroll', audience: 'admins', summary: 'Km Overrides that only repeat the patient km are cleared automatically on refresh, and nothing auto-fills them any more.' },
  { build: 39, area: 'Deliveries', audience: 'all', summary: 'Patient search in the add-to-route form now falls back to every patient when the store-scoped list has no match, instead of showing an empty list.' },
  { build: 40, area: 'Deliveries', audience: 'all', summary: 'Patient search now asks the server for the store (then all active patients) when nothing matches locally, so a store you are not cached for still finds its patients.' },
  { build: 40, area: 'Square', audience: 'all', summary: 'Charged to Card now counts only the current uncollected COD (yesterday, today and future stops) instead of stacking every day since the last true-up.' },
  { build: 40, area: 'App', audience: 'all', summary: 'The published version id is now keyed to the build and web version numbers, so publishing always changes the version every device reports.' },
  { build: 41, area: 'Patients', audience: 'all', summary: 'Device now keeps every store\'s patients resident (refreshed daily) and a store/city change never deletes patient records any more, so occasional weekend stores stay searchable.' },
  { build: 42, area: 'Patients', audience: 'all', summary: 'The patient address search now shows one row per address (duplicates grouped, with a +N badge) and lists Google addresses below it, restricted to 50 km around the assigned store.' },
  { build: 43, area: 'App', audience: 'owner', summary: 'Builds-ahead counter now compares against the live deployment\'s own build number instead of a baseline that only existed once someone opened the live site, so it shows the real number of unpublished builds.' },
  { build: 44, area: 'App', audience: 'owner', summary: 'Removed the duplicate (Prev) tag next to the version at the top of the sidebar; it still shows in the user badge at the bottom.' },
  { build: 45, area: 'App', audience: 'owner', summary: 'Tap the version line at the top of the sidebar to open the update log any time, including on preview, so you can confirm a publish landed before non-owners see it.' },
  { build: 46, area: 'Update Log', audience: 'owner', summary: 'The update log now has role tabs - Everyone, Drivers, Dispatchers, Admins and App owner - each showing only the changes that affect that role, with a role tag on every entry.' },
  { build: 47, area: 'Update Log', audience: 'owner', summary: 'Every update-log entry now has clickable Owner / Drivers / Dispatchers / Admins / Everyone badges so you can correct who a change is for; the correction is saved app-wide and survives the next build.' },
  { build: 48, area: 'Update Log', audience: 'owner', summary: 'The role badges and tabs are now flat, shorter text labels instead of filled pill buttons; the selected one is green and underlined.' },
  { build: 49, area: 'Card Balances', audience: 'admins', summary: 'The card balance estimate is back down to the real number: uncollected CODs from before yesterday are hidden from the Charged to Card list again, but they still hold their deduction off the card until they are collected or trued up.' },
  { build: 50, area: 'Route Optimization', audience: 'admins', summary: 'Regenerated polylines no longer flash and revert: the manual optimize and regenerate runs now wait for the server save to finish before syncing, so the new lines stay on screen.' },
  { build: 51, area: 'Card Balances', audience: 'admins', summary: 'CODs charged to card now shows only the charges listed on the page (yesterday onward), so the figure matches the rows and stopped reading as a huge negative. The card balance still subtracts every charge since the last True-Up.' },
  { build: 52, area: 'Card Balances', audience: 'admins', summary: 'CODs charged to card is now the exact total of the rows wearing a Card Spend pill on that store card. Not Tapped rows are left out, and the card balance math is unchanged.' },
  { build: 53, area: 'Card Balances', audience: 'admins', summary: 'A COD marked Not Tapped that is then charged to the card no longer stays exempt: the later charge overrides the mark, so the balance stops reading one COD high.' },
  { build: 54, area: 'Theme', audience: 'owner', summary: 'Dark-mode colours now ship in the stylesheet instead of an injected style tag, fixing the white sidebar and cards that only appeared in the Base44 editor. Live, preview, PWA and APK are unchanged.' },
  { build: 55, area: 'Theme', audience: 'all', summary: 'Dark styling now follows the app theme only, never the computers own dark setting, so a light app on a dark PC no longer shows stray dark bars, badges and cards.' },
  { build: 56, area: 'Sidebar', audience: 'owner', summary: 'The version number is plain text again and the update log lives on its own Change Logs link under it.' },
  { build: 57, area: 'Theme', audience: 'all', summary: 'A refresh can no longer come up part dark on a dark computer: the app starts from the theme you last saved instead of guessing from the system first. The Change Logs link also sits tighter under the version number.' },
  { build: 58, area: 'Patients', audience: 'dispatchers+admins', summary: 'Edited patient distances now save and stay: opening the edit form no longer wipes the stored distance and replaces it with a fresh lookup, and the stop panel only re-heals a distance that is still the straight-line value.' },
  { build: 99, area: 'COD Briefing', audience: 'owner', summary: 'The briefing balances now reuse the Square Balances page math, so the estimate stops reading hundreds of dollars too high. Store lines read Store: $ 53.90 Loan $ 2732.17.' },
  { build: 98, area: 'Projections', audience: 'dispatchers', summary: 'Deleting a projected patient from the staged or pending list puts them straight back in the projections. Map balloons now label the amount COD:.' },
  { build: 97, area: 'Map', audience: 'all', summary: 'Map balloons show COD amounts: right aligned beside the store name on a single stop, between the patient name and the time on a cluster, and clusters also show the location address beside the store name.' },
  { build: 96, area: 'Projections', audience: 'dispatchers', summary: 'A projection more than 2 days overdue now returns only in its cycle window (cycle weekday plus 2 days), weekly, until it is delivered.' },
  { build: 95, area: 'Route writing', audience: 'dispatchers', summary: 'A transferred stop now arrives on the other device as one update instead of a run of three to five.' },
  { build: 94, area: 'Route writing', audience: 'dispatchers', summary: 'A stop that is already in transit is no longer forced behind its store pickup, so a transferred stop keeps the first slot its 9am start gives it.' },
  { build: 93, area: 'Route writing', audience: 'dispatchers', summary: 'A transferred stop clears the old Next Delivery flag on its new route first, then the optimizer re-numbers the route and hands the flag to the new first stop.' },
  { build: 92, area: 'Route writing', audience: 'dispatchers', summary: 'A transferred stop is sequenced on its new route from local data the moment it lands, so it no longer sits last with a blank leg until a refresh.' },
  { build: 91, area: 'Route writing', audience: 'dispatchers', summary: 'A stop moved to another day or driver now re-optimizes that route for real: it comes back sequenced with its own leg and TR#, instead of sitting last with the old polyline.' },
  { build: 90, area: 'Square balances', audience: 'dispatchers', summary: 'Collected CODs can be tapped back to Not Tapped again, those rows stay listed under Collected Today, and Payment discrepancies starts collapsed.' },
  { build: 89, area: 'Route writing', audience: 'dispatchers', summary: 'Bulk editing stops to another date or driver now places each moved stop the same way a single transfer does: store pickup link, start time, cleared end time and the transfer note.' },
  { build: 88, area: 'Driver reassignment', audience: 'drivers', summary: 'A stop moved to another driver or date disappears for the original driver straight away, instead of lingering until the next refresh.' },
  { build: 87, area: 'Route writing', audience: 'dispatchers', summary: 'Moving a stop to another date or driver now clears its polyline, the predecessor it was drawn from, the PolylineUpdated flag and the leg distance stamps, along with the deviation points.' },
  { build: 86, area: 'Patient portal', audience: 'patients', summary: 'Map framing tightened: with the sidebar showing, the top padding now matches the bottom, and with the card showing the top padding drops another 20.' },
  { build: 85, area: 'Patient portal', audience: 'patients', summary: 'Sidebar panel sits flush at the top again and no longer runs under the device navigation bar, and it now layers above the tracking badge and the Exit Patient View button.' },
  { build: 84, area: 'Patient portal', audience: 'patients', summary: 'The patient map now shows the same centre crosshair as the main map, and the sidebar stops at the device navigation bar instead of slipping behind it.' },
  { build: 83, area: 'Patient portal', audience: 'patients', summary: 'When the sidebar is showing (desktop, or the drawer open on a phone) the map top padding no longer counts the floating today card, so the markers use the full height.' },
  { build: 82, area: 'Patient portal', audience: 'patients', summary: 'Map side padding cut from 50 to 20, so the driver and patient markers use more of the map width.' },
  { build: 81, area: 'Patient portal', audience: 'patients', summary: 'Map framing nudged: 40 less padding at the bottom and 40 more at the top, so the driver and patient sit a little lower in view.' },
  { build: 80, area: 'Patient portal', audience: 'patients', summary: 'Map is full height again with today\'s card floating over it. The auto-fit now keeps the markers clear of the card at the top and the tracking badge at the bottom, and the whole route line is green.' },
  { build: 79, area: 'Patient portal', audience: 'patients', summary: 'The map now reserves top padding for today\'s floating card, so the card sits above the map instead of on top of it. Expanding it leaves the map in place.' },
  { build: 78, area: 'Patient portal', audience: 'patients', summary: 'Expanding today\'s floating card now grows the card and its container instead of squeezing the details into a fixed-height box.' },
  { build: 77, area: 'Patient portal', audience: 'patients', summary: 'The driver tracking badge now sits at the bottom centre of the map instead of the top, so it no longer crowds the floating today card.' },
  { build: 76, area: 'Patient portal', audience: 'patients', summary: 'On a phone, today\'s delivery now floats in the top left of the map with the same expandable details as the sidebar, and disappears once that delivery date has passed.' },
  { build: 75, area: 'Patient portal', audience: 'patients', summary: 'Patients now choose who they message: the pharmacy team (one thread every dispatcher at that store shares) or a specific driver, with that driver on duty, on break or off duty shown on both the thread card and the chat.' },
  { build: 75, area: 'Messaging', audience: 'drivers', summary: 'Drivers get patient threads in Messages: only their own conversations, replying pushes to the patient phone.' },
  { build: 74, area: 'Patient portal', audience: 'patients', summary: 'Patient messages and read receipts now go through the patientPush function with service-role writes, so sending works reliably from the public portal page and the store is alerted in the same call.' },
  { build: 73, area: 'Patient portal', audience: 'patients', summary: 'Patients can now message their pharmacy from the portal and turn on notifications, so a reply or delivery alert reaches their phone without the APK.' },
  { build: 73, area: 'Messaging', audience: 'dispatchers', summary: 'New Patients tab in Messages: message any patient of your store, with unread badges and a push sent to their devices.' },
  { build: 72, area: 'Map', audience: 'everyone', summary: 'Cycling start and end pins no longer pick up a cluster count badge or cluster fan lines. They keep their own paired look and fan-out.' },
  { build: 71, area: 'Barcode scanner', audience: 'dispatchers', summary: 'The scanner window now shows only the part it actually reads, with no dark strips. Camera reads must be seen twice, short fragments are ignored, and a cut-off read can no longer sit beside the real barcode.' },
  { build: 70, area: 'Barcode scanner', audience: 'dispatchers', summary: 'The scanner window is full width again instead of a narrow strip. Same height, and the band it reads still lines up with the box on screen.' },
  { build: 69, area: 'App', audience: 'everyone', summary: 'Every phone now notices a new publish. The page itself checks the live build before the app even starts and pulls the newer one, so the update balloon shows up on the live site again.' },
  { build: 68, area: 'Barcode scanner', audience: 'dispatchers', summary: 'The scanner now only reads the middle band it shows you, so aiming at one label no longer grabs every barcode in the picture. The window is smaller, the list only shows this scan, and the buttons stay on screen.' },
  { build: 67, area: 'App', audience: 'everyone', summary: 'Devices now pick up a new build when you come back to the app. Before this, a phone could sit on old code for hours because it only updated after 10 minutes away or idle, so fixes like the time correction never reached it.' },
  { build: 66, area: 'Routes', audience: 'drivers', summary: 'Start now carries your detour points onto the new stop, so the line for your current leg still bends through the road you actually drove instead of snapping back to the straight plan.' },
  { build: 65, area: 'Dashboard', audience: 'dispatchers', summary: 'Patient-viewing alerts are now store-scoped. The map halo, the eye on the stop card and the ring on the map cycle button only appear for your own stores patients, instead of every dispatcher seeing another stores patient.' },
  { build: 64, area: 'Stops', audience: 'drivers', summary: 'Start now brings you back on duty. Tapping Start while on break or off duty flips you on, draws the leg to that stop and pins it as your next stop instead of leaving the route unmoved.' },
  { build: 63, area: 'Routes', audience: 'all', summary: 'Route optimization now reads the correct Alberta clock. It was an hour behind, so a stop with a 3:30 window looked due and jumped ahead of earlier stops. Windows, time-aware routing and ETA all use the same corrected clock.' },
  { build: 62, area: 'Times', audience: 'all', summary: 'Fixed completion times landing an hour early. Alberta stayed on UTC-6 after Nov 1, so the phone-written arrival times stayed right while the app-computed completion time drifted an hour behind. All Alberta time math now uses the permanent -6 rule from Nov 1 2026, with history before that still reading correctly.' },
  { build: 61, area: 'Routes', audience: 'all', summary: 'Stops at the same address or GPS point are now sorted by unit number, so a building is walked 210, 222, 312, 336 instead of in whatever order the router returned. Applies to the server optimizer too.' },
  { build: 60, area: 'Stops', audience: 'all', summary: 'A finished stop can no longer wear the next-delivery marker: the app now strips that flag from any completed, failed or cancelled stop before it is stored, and clears any that are already wrong when the route loads.' },
  { build: 59, area: 'Payroll', audience: 'all', summary: 'Confirming or finalizing payroll now locks the paid km for every stop over 10 km at the patient distance, so editing a patient address later can never change a payroll that was already confirmed.' },
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
