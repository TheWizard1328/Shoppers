// payrollArrearsCheck — who is still owed money on their most recent FINISHED
// pay cycle. Read-only: computes and returns the list, sends nothing.
//
// Owner spec (Nov 21 2026): the arrears reminder only ever looks at the most
// recent finished cycle per driver. Older cycles are never chased.
//
// CRITICAL FIELD RULE (owner, Nov 21 2026): the Payroll entity stores gross and
// net under SWAPPED names. `gross_pay` holds the TRUE NET owed to the driver
// (the figure the payroll UI shows as "Net"), and `net_pay` holds the gross.
// Arrears math MUST use gross_pay - paid_amount. Rows without tax/deductions
// have both fields equal, so the swap only shows up where tax_amount or
// total_deductions are non-zero (e.g. Robert Nov 1-15: gross_pay 1465.72,
// net_pay 1805.01, paid 1300 -> owed 165.72, NOT 505.01).
//
// A blank paid_amount (null/undefined/'') means payroll was never entered, not
// "paid in full": those drivers are reported separately and are ignored by the
// reminder until the cycle cutoff has passed.
//
// Params: { dry_run?: boolean, include_paid?: boolean }
// Returns: { checked_at, today, drivers: [...owed...], blank_paid: [...], total_owed }
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }

const requireAdminIfAuthenticated = async (b44) => {
  const ok = await b44.auth.isAuthenticated().catch(() => false);
  if (!ok) return null; // scheduled / service runs are unauthenticated
  const u = await b44.auth.me().catch(() => null);
  if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required');
  return u;
};

const EDMONTON = 'America/Edmonton';

/** Edmonton calendar day as YYYY-MM-DD — never use toISOString() here. */
const edmontonTodayKey = (d = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDMONTON, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayOnly = (v) => String(v || '').slice(0, 10);

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

async function listAll(entity, sort = '-created_date') {
  const out = [];
  const PAGE = 500;
  for (let skip = 0; skip < 5000; skip += PAGE) {
    const page = await entity.list(sort, PAGE, skip).catch(() => null);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    const b44 = createClientFromRequest(req);
    await requireAdminIfAuthenticated(b44);
    const body = await req.json().catch(() => ({}));
    const includePaid = body?.include_paid === true;

    const db = b44.asServiceRole.entities;
    const [payrolls, appUsers] = await Promise.all([
      listAll(db.Payroll, '-pay_period_end'),
      listAll(db.AppUser),
    ]);

    const nameById = new Map();
    for (const u of appUsers) {
      if (u?.user_id) nameById.set(String(u.user_id), u.user_name || u.email || '');
      if (u?.id) nameById.set(String(u.id), nameById.get(String(u.id)) || u.user_name || '');
    }

    const today = edmontonTodayKey();

    // Most recent FINISHED cycle per driver (pay_period_end already passed).
    const latest = new Map();
    for (const r of payrolls) {
      const driverId = r?.driver_id;
      const end = dayOnly(r?.pay_period_end);
      if (!driverId || !end || end >= today) continue; // unfinished cycles never count
      const cur = latest.get(driverId);
      if (!cur || end > dayOnly(cur.pay_period_end)) latest.set(driverId, r);
    }

    const owed = [];
    const blankPaid = [];
    let totalOwed = 0;

    for (const [driverId, r] of latest) {
      const net = round2(r.gross_pay);   // SWAPPED: gross_pay IS the true net
      const paidRaw = r.paid_amount;
      const name = r.driver_name || nameById.get(String(driverId)) || 'Unknown driver';

      if (isBlank(paidRaw)) {
        blankPaid.push({
          driver_id: driverId, driver_name: name,
          period_start: dayOnly(r.pay_period_start), period_end: dayOnly(r.pay_period_end),
          cycle: r.pay_period_type || null, net_owed: net, paid: null,
        });
        continue;
      }

      const paid = round2(paidRaw);
      const stillOwed = round2(net - paid);
      if (stillOwed > 0.005) {
        owed.push({
          driver_id: driverId, driver_name: name,
          period_start: dayOnly(r.pay_period_start), period_end: dayOnly(r.pay_period_end),
          cycle: r.pay_period_type || null,
          net_owed: net, paid, owed: stillOwed,
          payroll_id: r.id, status: r.status || null,
        });
        totalOwed = round2(totalOwed + stillOwed);
      } else if (includePaid) {
        owed.push({
          driver_id: driverId, driver_name: name,
          period_start: dayOnly(r.pay_period_start), period_end: dayOnly(r.pay_period_end),
          cycle: r.pay_period_type || null,
          net_owed: net, paid, owed: stillOwed,
          payroll_id: r.id, status: r.status || null,
        });
      }
    }

    owed.sort((a, b) => b.owed - a.owed);

    return Response.json({
      checked_at: new Date().toISOString(),
      today,
      dry_run: body?.dry_run !== false,
      drivers: owed,
      blank_paid: blankPaid,
      count: owed.length,
      total_owed: totalOwed,
    });
  } catch (err) {
    return Response.json({ error: err?.message || String(err) }, { status: err?.status || 500 });
  }
});
