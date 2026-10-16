// Oct 15 2026 — payroll paged-fetch merge util.
// Root cause of the payroll outage (Anna/owner/Riyaz all got 500s): the page
// fetched the FULL YEAR payload (all deliveries + patients + refs, ~10MB+)
// which exceeds the platform's backend-function response limit. The page now
// fetches only the current pay cycle's months ('paged' mode) and merges them
// into the previously rendered / offline-cached year. A cold device stitches
// the full year from per-month paged fetches (each response is small).
//
// Server contract (getAdminMetricsAndPayrollData, paged mode):
//  - deliveries/patients: ONLY the requested months' rows
//  - stores/appUsers/cities/cityName/appFeeRate: year-wide refs
//  - payrollRecords: year-wide (pay_period_start within the year) — always
//    fresh from the entity in every paged response
//
// Merge rules:
//  - deliveries: paged months replace the prior year's rows for those months;
//    other months keep the prior rows untouched (no gaps, no duplicates)
//  - patients/appUsers/stores/cities: merge by id (paged rows win)
//  - payrollRecords: merge by id (paged rows win — fresh edits/overrides)
export const mergePagedPayrollData = (priorData, pageData, months) => {
  if (!pageData) return priorData || null;
  if (!priorData) return { ...pageData };
  const monthSet = new Set((months || []).map(Number));
  const inPagedMonth = (d) => monthSet.has(Number(String(d?.delivery_date || '').slice(5, 7)));
  const mergeById = (a, b) => {
    const map = new Map();
    (a || []).forEach((r) => { if (r?.id) map.set(r.id, r); });
    (b || []).forEach((r) => { if (r?.id) map.set(r.id, r); });
    return Array.from(map.values());
  };
  return {
    ...priorData,
    deliveries: [
      ...(priorData.deliveries || []).filter((d) => !inPagedMonth(d)),
      ...(pageData.deliveries || [])
    ],
    patients: mergeById(priorData.patients, pageData.patients),
    appUsers: mergeById(priorData.appUsers, pageData.appUsers),
    stores: mergeById(priorData.stores, pageData.stores),
    cities: mergeById(priorData.cities, pageData.cities),
    cityName: pageData.cityName || priorData.cityName,
    appFeeRate: pageData.appFeeRate ?? priorData.appFeeRate,
    payrollRecords: mergeById(priorData.payrollRecords, pageData.payrollRecords)
  };
};

// Months needed to complete a year that only has `haveMonths` fetched.
// Current year caps at the current month (future months have no data);
// past years need all 12.
export const missingPayrollMonthsFor = (year, haveMonths, now = new Date()) => {
  const yearNum = Number(year);
  const lastMonth = yearNum === now.getFullYear() ? now.getMonth() + 1 : 12;
  const have = new Set((haveMonths || []).map(Number));
  const missing = [];
  for (let m = 1; m <= lastMonth; m += 1) {
    if (!have.has(m)) missing.push(m);
  }
  return missing;
};
