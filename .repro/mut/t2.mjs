const { offlineDB, __CALLS } = await import('./odb.mjs');
const { processPendingMutationsInternal } = await import('./proc.mjs');
const { OFFLINE_SYNC_ENTITY_CLIENTS } = await import('./registry.mjs');
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };

// T1: poisoned update mutation — honest lifecycle: seed once, let stubs
// maintain retryCount/notBefore; simulate the replay timer by clearing
// notBefore between cycles.
OFFLINE_SYNC_ENTITY_CLIENTS.Delivery = { update: async () => { throw new Error('HTTP 500 boom'); } };
offlineDB.__seed([{ mutationId: 'm1', entity: 'Delivery', recordId: 'd1', operation: 'update', payload: { status: 'in_transit' } }]);
__CALLS.length = 0;
const clock = async () => {
  const { offlineDB } = await import('./odb.mjs');
  // pretend the notBefore delay elapsed
  const rows = await offlineDB.getPendingMutations();
  offlineDB.__seed(rows.map(r => ({ ...r, notBefore: 0 })));
};
await processPendingMutationsInternal();        // attempt 1
await clock(); await processPendingMutationsInternal();  // attempt 2
await clock(); await processPendingMutationsInternal();  // attempt 3 -> abandoned
const retries = __CALLS.filter(c => c[0] === 'retry');
const removes = __CALLS.filter(c => c[0] === 'remove');
check('T1 two retry stamps then abandoned', retries.length === 2 && removes.length === 1);
check('T1 escalating delays (30s -> 120s)', retries.length === 2 && (retries[1][3] - Date.now()) - (retries[0][3] - Date.now()) > 60 * 1000);
// attempt 4: nothing left in queue — processor idles
__CALLS.length = 0;
const res = await processPendingMutationsInternal();
check('T1 queue empty after abandonment', __CALLS.length === 0 && (res.remaining === 0 || res.deferred === 0));

// T2: 429-shaped failure gets ~60s stamp
const err429 = new Error('Rate limit exceeded'); err429.response = { status: 429 };
OFFLINE_SYNC_ENTITY_CLIENTS.Delivery = { update: async () => { throw err429; } };
offlineDB.__seed([{ mutationId: 'm2', entity: 'Delivery', recordId: 'd2', operation: 'update', payload: { status: 'in_transit' } }]);
__CALLS.length = 0;
await processPendingMutationsInternal();
const r2 = __CALLS.find(c => c[0] === 'retry' && c[1] === 'm2');
check('T2 429 gets ~60s notBefore stamp', r2 && r2[3] - Date.now() > 50 * 1000 && r2[3] - Date.now() < 70 * 1000);

// T3: successful mutation never hits the retry path (cap only punishes failures)
OFFLINE_SYNC_ENTITY_CLIENTS.Delivery = { update: async () => ({ id: 'd3' }) };
offlineDB.__seed([{ mutationId: 'm3', entity: 'Delivery', recordId: 'd3', operation: 'update', payload: { status: 'in_transit' } }]);
__CALLS.length = 0;
const res3 = await processPendingMutationsInternal();
check('T3 success processed cleanly', res3.processed === 1 && __CALLS.filter(c => c[0] === 'retry').length === 0);

console.log(`${pass}/${pass + fail} tests ${fail === 0 ? 'ALL PASS' : 'FAILURES'}`);
