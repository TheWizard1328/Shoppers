import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * backfillCompanyIds
 * Server-side company_id backfill for records that have a blank company_id
 * (missing field, null, or empty string).
 *
 * Owner request Nov 8 2026: with only one company in the system (RGistics),
 * every blank should be stamped with that company's real Company record id.
 *
 * Body:
 *   { company_id?: string,          // force a target company id
 *     entities?: string[],          // subset to process (default: requested four)
 *     dry_run?: boolean,            // report only, no writes
 *     include_all?: boolean }       // also Patient + InterStoreLocation
 *
 * Returns per-entity { blank_before, updated, remaining } plus the company used.
 * Safe to call repeatedly: it only ever touches blank company_id rows.
 */

const DEFAULT_ENTITIES = ['Store', 'Delivery', 'Payroll', 'AppUser'];
const EXTRA_ENTITIES = ['Patient', 'InterStoreLocation'];
const VALID = new Set([...DEFAULT_ENTITIES, ...EXTRA_ENTITIES]);
const BATCH = 500;
const MAX_BATCHES_PER_ENTITY = 6; // ≤3000 writes per entity per call

const blankFilters = () => ([
  { company_id: { $exists: false } },
  { company_id: null },
  { company_id: '' },
]);

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }

    const dryRun = body?.dry_run === true;
    const wanted = Array.isArray(body?.entities) && body.entities.length
      ? body.entities.filter((e) => VALID.has(e))
      : (body?.include_all ? [...DEFAULT_ENTITIES, ...EXTRA_ENTITIES] : DEFAULT_ENTITIES);
    const entities = wanted.length ? wanted : DEFAULT_ENTITIES;

    // ── Resolve the target company ───────────────────────────────────────────
    const companies = await base44.asServiceRole.entities.Company.list('-created_date', 50).catch(() => []);
    let companyId = body?.company_id || '';
    let companyName = '';
    if (!companyId) {
      if (companies.length === 1) {
        companyId = companies[0].id;
        companyName = companies[0].name;
      } else if (companies.length > 1) {
        // Most-used company_id among stores wins (matches the historical backfill).
        const stores = await base44.asServiceRole.entities.Store.list('-created_date', 500).catch(() => []);
        const tally = new Map();
        for (const s of stores) if (s?.company_id) tally.set(s.company_id, (tally.get(s.company_id) || 0) + 1);
        if (tally.size) {
          companyId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
        } else {
          companyId = companies[0].id;
        }
        companyName = companies.find((c) => c.id === companyId)?.name || '';
      }
    }
    if (!companyId) {
      return Response.json({ error: 'No Company record found to backfill from' }, { status: 400 });
    }
    if (!companyName) companyName = companies.find((c) => c.id === companyId)?.name || companyId;

    const results = {};
    let working = false;

    for (const name of entities) {
      const api = base44.asServiceRole.entities[name];
      const out = { blank_before: 0, updated: 0, remaining: 0 };

      // Count blanks first so the caller can show progress.
      for (const f of blankFilters()) {
        const rows = await api.filter(f, 'created_date', 1000).catch(() => []);
        out.blank_before += Array.isArray(rows) ? rows.length : 0;
      }

      if (dryRun) {
        out.remaining = out.blank_before;
        results[name] = out;
        if (out.blank_before > 0) working = true;
        continue;
      }

      let updated = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_ENTITY; batch += 1) {
        const seen = new Set();
        const records = [];
        for (const f of blankFilters()) {
          const rows = await api.filter(f, 'created_date', BATCH).catch(() => []);
          for (const r of rows || []) {
            if (!r?.id || seen.has(r.id)) continue;
            seen.add(r.id);
            records.push(r);
            if (records.length >= BATCH) break;
          }
          if (records.length >= BATCH) break;
        }
        if (!records.length) break;

        const payload = records.slice(0, BATCH).map((r) => ({ id: r.id, company_id: companyId }));
        try {
          if (typeof api.bulkUpdate === 'function') await api.bulkUpdate(payload);
          else await Promise.all(payload.map((p) => api.update(p.id, { company_id: companyId })));
          updated += payload.length;
        } catch (e) {
          out.error = e?.message || String(e);
          break;
        }
      }
      out.updated = updated;

      // Remaining blanks after this run.
      for (const f of blankFilters()) {
        const rows = await api.filter(f, 'created_date', 1).catch(() => []);
        out.remaining += Array.isArray(rows) ? rows.length : 0;
      }
      if (out.remaining > 0) working = true;
      results[name] = out;
    }

    return Response.json({
      company_id: companyId,
      company_name: companyName,
      dry_run: dryRun,
      entities,
      results,
      done: !working,
      updated_this_run: Object.values(results).reduce((s, r) => s + (r.updated || 0), 0),
    });
  } catch (error) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
});
