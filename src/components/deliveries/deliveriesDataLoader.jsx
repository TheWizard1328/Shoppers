// Paginated delivery-fetch helpers shared by the Route Management page.
//
// CRITICAL: A plain `base44.entities.Delivery.filter({...})` call with no limit/skip only
// returns the FIRST page (~100 results). That truncated the Route Management date list to
// the most recent days and dropped older historical deliveries — including stops belonging
// to now-inactive drivers — so their overview cards never rendered. These helpers paginate
// (1000/page) to fetch the complete set in the requested range.

import { base44 } from '@/api/base44Client';

const PAGE = 1000;
const PAGE_DELAY_MS = 250;   // light delay between paginated calls to avoid rate limits
const QUARTER_DELAY_MS = 400; // light delay between quarter windows

// Fetch ALL deliveries whose delivery_date falls within [startDateStr, endDateStr].
// Returns a flat array (newest first). Caller is responsible for deleted-delivery filtering.
export async function fetchDeliveriesInRange(startDateStr, endDateStr) {
  const all = [];
  let skip = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await base44.entities.Delivery.filter(
      { delivery_date: { $gte: startDateStr, $lte: endDateStr } },
      '-delivery_date',
      PAGE,
      skip
    );
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE) break;
    skip += PAGE;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }
  return all;
}

// Background-sync the last 2 years of deliveries (current + previous year), paginated per
// quarter. Returns the freshly fetched list (caller persists to offline DB + updates UI).
export async function runHistoricalDeliveriesSync() {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - 1;
  const allYearData = [];

  for (let year = currentYear; year >= startYear; year--) {
    const quarters = [
      { start: `${year}-01-01`, end: `${year}-03-31`, label: 'Q1' },
      { start: `${year}-04-01`, end: `${year}-06-30`, label: 'Q2' },
      { start: `${year}-07-01`, end: `${year}-09-30`, label: 'Q3' },
      { start: `${year}-10-01`, end: `${year}-12-31`, label: 'Q4' }
    ];

    for (const quarter of quarters) {
      try {
        let skip = 0;
        let hasMore = true;
        while (hasMore) {
          const page = await base44.entities.Delivery.filter(
            { delivery_date: { $gte: quarter.start, $lte: quarter.end } },
            '-delivery_date',
            PAGE,
            skip
          );
          if (!page || page.length === 0) { hasMore = false; break; }
          allYearData.push(...page);
          if (page.length < PAGE) { hasMore = false; break; }
          skip += PAGE;
          await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
        }
        await new Promise((r) => setTimeout(r, QUARTER_DELAY_MS));
      } catch (quarterError) {
        console.warn(`⚠️ [HistoricalSync] Failed ${year} ${quarter.label}:`, quarterError?.message);
      }
    }
  }

  return allYearData;
}