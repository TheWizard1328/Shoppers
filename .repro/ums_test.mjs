import fs from 'fs';
const src = fs.readFileSync('src/components/utils/clientRouteEngine.js', 'utf8');
const start = src.indexOf('function _unitNumberMicroSort');
const end = src.indexOf('\n}', start) + 2;
let fn = src.slice(start, end);
fn = fn.replace('function _unitNumberMicroSort(stops, patientMap, storeMap)', 'export default function _unitNumberMicroSort(stops, patientMap, storeMap, getDeliveryCoords)');
fs.writeFileSync('/tmp/ums_fn.mjs', fn);
const microSort = (await import('/tmp/ums_fn.mjs')).default;

const ADDR = '123 Fake St';
const patientMap = new Map();
const pid = (k, unit) => { patientMap.set('p' + k, { lat: 53.5231, lng: -113.5211, address: ADDR, unit_number: unit }); return 'p' + k; };
const getCoords = (d, pm) => { const p = pm.get(d.patient_id); return p ? { lat: p.lat, lng: p.lng } : null; };
const mk = (id, unit, status, puid) => ({ delivery: { id, delivery_id: 'DID-1', patient_id: pid(id, unit), unit_number: unit, status, puid, patient_address: ADDR } });

let pass = 0, total = 0;
const check = (name, stops, expected) => {
  microSort(stops, patientMap, new Map(), getCoords);
  const got = stops.map(s => s.delivery.id);
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${got.join(',')} expected ${expected.join(',')}`);
};

// T1: same address, one chain, units out of order -> unit sort
check('single chain unit sort',
  [mk('A','302','in_transit','PU1'), mk('B','101','pending','PU1'), mk('C','201','pending','PU1')],
  ['B','C','A']);
// T2: two chains — chain order preserved, units sorted within each
// PU1's span (positions 1,3) preserved; units sorted inside each chain
check('two chains interleave',
  [mk('D','302','pending','PU1'), mk('E','101','pending','PU2'), mk('F','2','pending','PU1')],
  ['F','E','D']);
// T3: unnumbered after numbered
check('numbered before unnumbered',
  [mk('G','','pending','PU1'), mk('H','101','pending','PU1')],
  ['H','G']);
// T4: different buildings untouched (out of cluster)
patientMap.set('pX', { lat: 53.6, lng: -113.6, address: '999 Other Ave', unit_number: '5' });
const stops4 = [mk('A','302','pending','PU1'), { delivery: { id: 'X', delivery_id: 'DID-1', patient_id: 'pX', unit_number: '5', status: 'pending', puid: 'PU2', patient_address: '999 Other Ave' } }, mk('B','101','pending','PU1')];
check('non-cluster stop untouched', stops4, ['B','X','A']);
// T5: pending + in_transit mix at same address -> all sorted
check('mixed statuses',
  [mk('A','2','in_transit','PU1'), mk('B','1','pending','PU1')],
  ['B','A']);
console.log(`${pass}/${total} tests pass`);
