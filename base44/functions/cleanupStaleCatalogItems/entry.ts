import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  await base44.auth.me().catch(() => { throw new Error('Unauthorized'); });

  // Delete 8 stale duplicate SquareCatalogItems records with null delivery_id
  // (4 delivery pairs, each with 2 duplicate catalog object IDs from the re-creation loop)
  const staleIds = [
    '6a972f41bf742c99bffbf49e',
    '6a972f3e861f605ee51e10c0',
    '6a972f3ecf1abd973ec807ca',
    '6a972f3ee93cb79ff1cccb39',
    '6a96f0813d58a8353bc22787',
    '6a96f08178a1efb272f7b9ed',
    '6a96f0812a7b8e5d13c59e08',
    '6a96f081f95fa3179660be72',
  ];

  const results = [];
  for (const id of staleIds) {
    try {
      await base44.asServiceRole.entities.SquareCatalogItems.delete(id);
      results.push({ id, deleted: true });
    } catch (e) {
      results.push({ id, deleted: false, error: e?.message || String(e) });
    }
  }

  // Also delete the corresponding Square catalog objects
  const SQUARE_TOKEN = Deno.env.get('SQUARE_ACCESS_TOKEN');
  const squareObjectIds = [
    'MKBW6RGQP3TZYIWYLVUKZT4P', 'JJMMIYLMONHEBACIK5RZDDHI',
    'P42ZEY33F2QUOZX4WATNGTSS', 'TKTZE7LBYY3UCT5MHQYTMV6P',
    'QEF6VZ244POWYH2MRZ6WYQJQ', 'TMFW3DBE766ASCFOTLGFRPKV',
    'ALY2QSVQSKBGPMRPH6EHCWR3', 'CLCPBQUD5KMFVLRAD4YW5TVH',
  ];

  const squareResults = [];
  if (SQUARE_TOKEN) {
    for (const objId of squareObjectIds) {
      try {
        const r = await fetch(`https://connect.squareup.com/v2/catalog/object/${objId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${SQUARE_TOKEN}`, 'Square-Version': '2025-01-23' },
        });
        squareResults.push({ objId, status: r.status, ok: r.ok || r.status === 404 });
      } catch (e) {
        squareResults.push({ objId, error: e?.message || String(e) });
      }
    }
  }

  return Response.json({
    dbDeleted: results.filter(r => r.deleted).length,
    dbFailed: results.filter(r => !r.deleted).length,
    results,
    squareResults,
  });
});
