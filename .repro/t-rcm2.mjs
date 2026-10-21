const { commitDeliveryUpdatesSilently } = await import('./rcm-test.mjs');
const { lockDeliveryFields, unlockAll } = await import('./completionLockout-test.mjs');
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };
const now = new Date().toISOString();
const setIDB = (rows) => { globalThis.__TEST_IDB = rows; };
const commit = async (updates, idb) => { if (idb) setIDB(idb); globalThis.__COMMITLOG = []; return commitDeliveryUpdatesSilently(updates); };

// intercept the bulk invoke to capture what actually commits
const { base44 } = await import('./b44-stub.js');
base44.functions.invoke = async (_fn, payload) => { globalThis.__COMMITLOG.push(payload.updates.map(u => u.id)); return { updatedCount: payload.updates.length }; };

// T1: stale accept batch (pre-Start snapshot) over just-started IDB record -> dropped
unlockAll();
let n = await commit([{ id: 'A', data: { status: 'pending', isNextDelivery: false, stop_order: 3, encoded_polyline: null } }],
  [{ id: 'A', status: 'en_route', isNextDelivery: true, updated_date: now }]);
check('T1 stale pre-Start entry dropped', n === 0);

// T2: same entry over a still-pending record -> kept (legit pending-clear)
n = await commit([{ id: 'B', data: { status: 'pending', isNextDelivery: false, encoded_polyline: null } }],
  [{ id: 'B', status: 'pending', isNextDelivery: false, updated_date: now }]);
check('T2 pending-clear on pending record kept', n === 1);

// T3: lock-value guard — Start pinned isNextDelivery=true; stale writer sets false (IDB not fresh-started)
unlockAll();
lockDeliveryFields('C', ['status', 'isNextDelivery', 'delivery_time_start'], 60000, { status: 'en_route', isNextDelivery: true, delivery_time_start: '15:00' });
n = await commit([{ id: 'C', data: { isNextDelivery: false, stop_order: 2 } }],
  [{ id: 'C', status: 'in_transit', isNextDelivery: false, updated_date: new Date(Date.now() - 10 * 60 * 1000).toISOString() }]);
check('T3 locked-field stomp dropped', n === 0);

// T4: terminal write over locked/started record passes
n = await commit([{ id: 'C', data: { status: 'completed', isNextDelivery: false } }],
  [{ id: 'C', status: 'in_transit', isNextDelivery: true, updated_date: new Date(Date.now() - 60 * 1000).toISOString() }]);
check('T4 terminal write passes guards', n === 1);

// T5: matching values pass (second Start / legit writer)
unlockAll();
lockDeliveryFields('D', ['status', 'isNextDelivery'], 60000, { status: 'en_route', isNextDelivery: true });
n = await commit([{ id: 'D', data: { status: 'en_route', isNextDelivery: true, stop_order: 5 } }],
  [{ id: 'D', status: 'en_route', isNextDelivery: true, updated_date: now }]);
check('T5 matching locked values kept', n === 1);

// T6: terminal-stomp guard still works (active over terminal IDB)
n = await commit([{ id: 'E', data: { status: 'in_transit' } }],
  [{ id: 'E', status: 'completed', updated_date: now }]);
check('T6 active-over-terminal dropped', n === 0);

// T7: normal eta-only batch untouched
n = await commit([{ id: 'F', data: { delivery_time_eta: '16:30' } }], [{ id: 'F', status: 'en_route', updated_date: now }]);
check('T7 eta-only batch kept', n === 1);

console.log(`${pass}/${pass + fail} tests ${fail === 0 ? 'ALL PASS' : 'FAILURES'}`);
