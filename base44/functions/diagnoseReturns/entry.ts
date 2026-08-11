import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

  const db = base44.asServiceRole;
  const BATCH = 500;
  const CUTOFF = '2026-01-01';

  // Return patient IDs for all 12 active stores
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

  const storeSummary = {};
  const allProblemDeliveries = [];

  for (const [patientId, storeName] of Object.entries(returnPatients)) {
    storeSummary[storeName] = { total_returns: 0, unknown: 0, missing: 0, empty: 0, clean: 0, problems: [] };
    let skip = 0;

    while (true) {
      const batch = await db.entities.Delivery.filter(
        { patient_id: patientId },
        'created_date', BATCH, skip
      ).catch(e => { console.error(`Fetch error ${patientId}: ${e.message}`); return []; });

      if (!batch.length) break;

      for (const d of batch) {
        const dDate = d.delivery_date || d.created_date || '';
        if (dDate < CUTOFF) continue; // 2026 only

        storeSummary[storeName].total_returns++;

        const notes = d.delivery_notes || '';
        const hasForUnknown = /For:\s*Unknown/i.test(notes);
        const hasFor = /For:/i.test(notes);

        // Extract text after "For:" to check if it's empty/whitespace only
        let afterFor = '';
        if (hasFor) {
          const forIdx = notes.indexOf('For:');
          afterFor = notes.substring(forIdx + 4).trim();
          // Strip (RTN) and From: prefixes
          const rtnIdx = afterFor.indexOf('(RTN)');
          if (rtnIdx !== -1) afterFor = afterFor.substring(0, rtnIdx).trim();
          const fromIdx = afterFor.indexOf('From:');
          if (fromIdx !== -1) afterFor = afterFor.substring(0, fromIdx).trim();
        }

        let problemType = null;
        if (!notes || notes.trim() === '') {
          problemType = 'empty';
          storeSummary[storeName].empty++;
        } else if (hasForUnknown) {
          problemType = 'unknown';
          storeSummary[storeName].unknown++;
        } else if (!hasFor) {
          problemType = 'missing_for';
          storeSummary[storeName].missing++;
        } else if (afterFor === '') {
          problemType = 'for_empty';
          storeSummary[storeName].missing++;
        } else {
          storeSummary[storeName].clean++;
        }

        if (problemType) {
          const entry = {
            store: storeName,
            delivery_id: d.id,
            delivery_date: d.delivery_date || d.created_date,
            status: d.status,
            problem_type: problemType,
            delivery_notes: notes ? notes.substring(0, 300) : '(null)',
          };
          storeSummary[storeName].problems.push(entry);
          allProblemDeliveries.push(entry);
        }
      }

      skip += BATCH;
      if (batch.length < BATCH) break;
    }
  }

  return Response.json({
    total_problem_deliveries: allProblemDeliveries.length,
    store_summary: Object.entries(storeSummary).map(([name, data]) => ({
      store_name: name,
      total_returns: data.total_returns,
      unknown: data.unknown,
      missing: data.missing,
      empty: data.empty,
      clean: data.clean,
      needs_fixing: data.unknown + data.missing + data.empty,
      problems: data.problems,
    })),
    all_problems: allProblemDeliveries,
  });
});
