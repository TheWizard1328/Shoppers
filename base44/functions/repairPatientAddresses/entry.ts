// REPAIR CORRUPTED PATIENT ADDRESSES (owner bug report Oct 28 2026)
//
// Root cause: src/components/ui/google-address-autocomplete.jsx's
// unabbreviateAddress() built its swap regexes WITHOUT a leading word
// boundary — `Rd\b` matched the tail of ordinary words, so
//   "Boulevard" -> "BoulevaRoad"   "Third" -> "ThiRoad"
//   "First"     -> "FirStreet"     "West"  -> "WeStreet"
//   "Crest"     -> "CreStreet"     "Hillcrest" -> "HillcreStreet"
//   "Aster"     -> "AsTer"         "3rd"   -> "3Road"   "1st" -> "1Street"
// The component is fixed (whole-word + no-trailing-period), so NEW saves are
// clean. This function repairs the addresses already stored on Patient rows.
//
// Repair is the exact inverse: a CAPITALISED expansion glued directly onto a
// preceding letter/digit is impossible in a correctly expanded address (a real
// " Road"/" Street" always has a space), so it is reverted to its lowercase
// abbreviation and the original word is restored ("BoulevaRoad" -> "Boulevard").
//
// POST { dryRun?: true }  -> report only (default)
// POST { apply: true }    -> write the repairs

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  status: number;
  constructor(s: number, m: string) { super(m); this.status = s; }
}

const requireOwnerOrAdmin = async (b44: any) => {
  const u = await b44.auth.me().catch(() => null);
  if (!u) throw new HttpError(401, 'Unauthorized');
  if (!['admin', 'App Owner'].includes(u?.role)) throw new HttpError(403, 'Forbidden: admin only');
  return u;
};

// Order matters: longer expansions first so "Terrace" is handled before any
// shorter suffix that could partially match.
const EXPANSION_REVERSALS: Array<[RegExp, string]> = [
  [/([A-Za-z0-9])Boulevard\b/g, '$1blvd'],
  [/([A-Za-z0-9])Terrace\b/g, '$1ter'],
  // remnant of the old 'Ter\b' rule: "Aster" came out as "AsTer"
  [/([a-z])Ter\b/g, '$1ter'],
  [/([A-Za-z0-9])Street\b/g, '$1st'],
  [/([A-Za-z0-9])Avenue\b/g, '$1ave'],
  [/([A-Za-z0-9])Drive\b/g, '$1dr'],
  [/([A-Za-z0-9])Court\b/g, '$1ct'],
  [/([A-Za-z0-9])Place\b/g, '$1pl'],
  [/([A-Za-z0-9])Lane\b/g, '$1ln'],
  [/([A-Za-z0-9])Road\b/g, '$1rd'],
];

const repairAddress = (input: any): string => {
  const raw = String(input || '');
  if (!raw) return raw;
  let out = raw;
  for (const [rx, repl] of EXPANSION_REVERSALS) out = out.replace(rx, repl);
  return out;
};

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const b44 = createClientFromRequest(req);
    await requireOwnerOrAdmin(b44);
    const payload = await req.json().catch(() => ({}));
    const apply = payload?.apply === true;

    // ── Load every patient (paged) ──────────────────────────────────────
    const all: any[] = [];
    for (let page = 0; page < 60; page++) {
      const rows = await b44.asServiceRole.entities.Patient.list('-updated_date', 500, all.length).catch(() => []);
      const list = rows || [];
      all.push(...list);
      if (list.length < 500) break;
      await sleep(60);
    }

    const changes: Array<{ id: string; name: string; store_id: string; before: string; after: string }> = [];
    for (const p of all) {
      if (!p?.id) continue;
      const before = String(p.address || '');
      const after = repairAddress(before);
      if (after !== before) {
        changes.push({ id: p.id, name: p.full_name || '', store_id: p.store_id || '', before, after });
      }
    }

    const samples = changes.slice(0, 40).map((c) => `${c.name}: "${c.before}" -> "${c.after}"`);

    if (!apply) {
      return Response.json({
        success: true,
        mode: 'dryRun',
        patientsScanned: all.length,
        corruptedFound: changes.length,
        samples,
        durationMs: Date.now() - t0,
      });
    }

    // ── Apply ───────────────────────────────────────────────────────────
    let updated = 0;
    const failed: string[] = [];
    for (let i = 0; i < changes.length; i += 25) {
      const chunk = changes.slice(i, i + 25);
      const results = await Promise.allSettled(
        chunk.map((c) => b44.asServiceRole.entities.Patient.update(c.id, { address: c.after })),
      );
      results.forEach((r: any, idx: number) => {
        if (r.status === 'fulfilled') updated += 1;
        else failed.push(`${chunk[idx].id}: ${String(r.reason?.message || r.reason).slice(0, 120)}`);
      });
      await sleep(120);
    }

    return Response.json({
      success: failed.length === 0,
      mode: 'apply',
      patientsScanned: all.length,
      corruptedFound: changes.length,
      updated,
      failed: failed.slice(0, 10),
      samples,
      durationMs: Date.now() - t0,
    });
  } catch (e: any) {
    return Response.json({ success: false, error: String(e?.message || e) }, { status: e?.status || 500 });
  }
});
