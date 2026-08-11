import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

  const db = base44.asServiceRole;
  const BATCH = 500;
  const CUTOFF = '2026-01-01';

  const returnPatients = {
    '68e1e249f45648303b222cdf': 'Hamptons',
    '68e1e249f45648303b222bff': 'Callingwood',
    '68e1e249f45648303b222956': 'Beverly',
    '68e1e249f45648303b222ddd': 'Londonderry',
    '68e156d4b5b79aa33ef88dd1': 'Kingsway',
    '68e1e249f45648303b222a13': 'Bonnie Doon',
    '6940fbe3ffa8cc080a3d6c46': 'Sherwood Park Mall',
    '696667d6fe7cbd5a34eb3bf8': 'Lakeland Ridge',
    '68e1e249f45648303b223185': 'WestPark',
    '68e1e249f45648303b22313c': 'SouthPoint',
    '68e1e249f45648303b222eb8': 'Meadows',
    '68e1e249f45648303b223073': 'Scona',
  };

  // Compact summary — just counts per store
  const summary = {};
  const problems = [];

  for (const [patientId, storeName] of Object.entries(returnPatients)) {
    summary[storeName] = { total: 0, unknown: 0, missing: 0, empty: 0, clean: 0 };
    let skip = 0;

    while (true) {
      const batch = await db.entities.Delivery.filter(
        { patient_id: patientId },
        'created_date', BATCH, skip
      ).catch(e => { console.error(`Fetch error ${patientId}: ${e.message}`); return []; });

      if (!batch.length) break;

      for (const d of batch) {
        const dDate = d.delivery_date || d.created_date || '';
        if (dDate < CUTOFF) continue;

        summary[storeName].total++;
        const notes = d.delivery_notes || '';

        const hasForUnknown = /For:\s*Unknown/i.test(notes);
        const hasFor = /For:/i.test(notes);

        let afterFor = '';
        if (hasFor) {
          const forIdx = notes.indexOf('For:');
          afterFor = notes.substring(forIdx + 4).trim();
          const rtnIdx = afterFor.indexOf('(RTN)');
          if (rtnIdx !== -1) afterFor = afterFor.substring(0, rtnIdx).trim();
          const fromIdx = afterFor.indexOf('From:');
          if (fromIdx !== -1) afterFor = afterFor.substring(0, fromIdx).trim();
        }

        let type = null;
        if (!notes || notes.trim() === '') { type = 'empty'; summary[storeName].empty++; }
        else if (hasForUnknown) { type = 'unknown'; summary[storeName].unknown++; }
        else if (!hasFor) { type = 'missing_for'; summary[storeName].missing++; }
        else if (afterFor === '') { type = 'for_empty'; summary[storeName].missing++; }
        else { summary[storeName].clean++; }

        if (type) {
          // Compact: only essential fields
          problems.push({
            store: storeName,
            id: d.id,
            date: d.delivery_date || d.created_date,
            type,
          });
        }
      }

      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }

  return Response.json({
    total_problems: problems.length,
    summary: Object.entries(summary).map(([name, d]) => ({
      store: name, total: d.total, unknown: d.unknown, missing: d.missing, empty: d.empty, clean: d.clean, needs_fixing: d.unknown + d.missing + d.empty
    })),
    problems,
  });
});
