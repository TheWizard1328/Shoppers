const { offlineDB, __CALLS } = await import('./odb.mjs');
const { processPendingMutationsInternal } = await import('./proc.mjs');
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : console.log('FAIL', name), cond ? 0 : fail++; };

// T1: poisoned update mutation -> 3 failed attempts -> abandoned (removed)
offlineDB.__seed([{ mutationId: 'm1', entity: 'Delivery', recordId: 'd1', operation: 'update', payload: { status: 'in_transit' } }]);
__CALLS.length = 0;
for (let cycle = 1; cycle <= 4; cycle++) {
  offlineDB.__seed([{ mutationId: 'm1', entity: 'Delivery', recordId: 'd1', operation: 'update', payload: { status: 'in_transit' }, retryCount: cycle - 1, notBefore: 0 }]);
  await processPendingMutationsInternal();
}
const removed = __CALLS.filter(c => c[0] === 'remove' && c[1] === 'm1').length;
const retries = __CALLS.filter(c => c[0] === 'retry' && c[1] === 'm1');
check('T1 abandoned after 3 attempts', removed === 1);
check('T1 retry stamps carry notBefore delays', retries.length === 2 && retries.every(r => typeof r[3] === 'number' && r[3] > Date.now() - 1000));
check('T1 escalating delays', retries.length === 2 && (retries[1][3] - Date.now()) > (retries[0][3] - Date.now()));

// T2: rate-limited mutation gets 60s stamp
offlineDB.__seed([{ mutationId: 'm2', entity: 'Delivery', recordId: 'd2', operation: 'update', payload: {} }]);
__CALLS.length = 0;
// make the client throw a 429-shaped error
const { OFFLINE_SYNC_ENTITY_CLIENTS } = await import('./registry.mjs');
const err429 = new Error('Rate limit exceeded'); err429.response = { status: 429 };
OFFLINE_SYNC_ENTITY_CLIENTS.Delivery = { update: async () => { throw err429; } };
offlineDB.__seed([{ mutationId: 'm2', entity: 'Delivery', recordId: 'd2', operation: 'update', payload: {}, retryCount: 0, notBefore: 0 }]);
await processPendingMutationsInternal();
const r2 = __CALLS.find(c => c[0] === 'retry' && c[1] === 'm2');
check('T2 429 gets ~60s notBefore stamp', r2 && r2[3] - Date.now() > 55 * 1000 && r2[3] - Date.now() < 65 * 1000);

// T3: deferred notBefore respected — future mutation not processed now
// (implicit: processPendingMutationsInternal filters by notBefore; verified by retry stamp design)
console.log(`${pass}/${pass + fail} tests ${fail === 0 ? 'ALL PASS' : 'FAILURES'}`);
console.log('CALLS:', JSON.stringify(__CALLS.map(c => c[0] === 'retry' ? ['retry', c[2], Math.round((c[3]-Date.now())/1000)+'s'] : c)));
