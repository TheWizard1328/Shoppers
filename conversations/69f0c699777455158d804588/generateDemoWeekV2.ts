import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
const toRad = (d: number) => d * Math.PI / 180;
const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};
const offsetCoords = (lat: number, lon: number, km: number, angle: number) => {
  const R = 6371, br = toRad(angle), lr = toRad(lat), ad = km/R;
  const nl = Math.asin(Math.sin(lr)*Math.cos(ad) + Math.cos(lr)*Math.sin(ad)*Math.cos(br));
  const nlon = toRad(lon) + Math.atan2(Math.sin(br)*Math.sin(ad)*Math.cos(lr), Math.cos(ad)-Math.sin(lr)*Math.sin(nl));
  return { latitude: +(nl*180/Math.PI).toFixed(6), longitude: +(nlon*180/Math.PI).toFixed(6) };
};
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random()*arr.length)];
const randInt = (a: number, b: number) => Math.floor(Math.random()*(b-a+1))+a;
const rand = (a: number, b: number) => Math.random()*(b-a)+a;
const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
const fmtDate = (d: Date) => d.toISOString().split('T')[0];
const buildDT = (d: Date, time: string) => `${fmtDate(d)}T${time}:00`;
const h2m = (t: string) => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const m2h = (m: number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const addMin = (t: string, n: number) => m2h(h2m(t)+n);
const genId = (len: number) => Array.from({length:len}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[randInt(0,53)]).join('');

// Edmonton street data for realistic addresses
const streetNames = ['Maple','Oak','Cedar','Pine','Spruce','River','Lake','Hill','Park','Elm','Sunset','Meadow','82','104','118','137','156','170','178','199','Jasper','Whyte','Calgary','St Albert','111','124','66','50'];
const streetTypes = ['Street','Avenue','Road','Drive','Boulevard','Lane','Court','Crescent','Place','Way'];
const firstNames = ['Emma','Olivia','Sophia','Ava','Mia','Amelia','Sarah','Jennifer','Michael','David','James','Robert','William','Linda','Patricia','Susan','Karen','Nancy','Lisa','Betty','Margaret','Sandra','Ashley','Kimberly','Emily','Donna','Carol','Michelle','Laura','Sarah','Heather','Stephen','Chris','Mark','Daniel','Matthew','Andrew','Joseph','Thomas','Nancy'];
const lastNames = ['Johnson','Smith','Brown','Taylor','Wilson','Martin','Lee','Clark','Young','Hall','Allen','King','Wright','Lopez','Hill','Scott','Green','Adams','Baker','Nelson','Carter','Mitchell','Roberts','Turner','Phillips','Campbell','Parker','Evans','Edwards','Collins','Stewart','Sanchez','Morris','Rogers','Reed','Cook','Morgan','Bell','Murphy','Bailey','Rivera','Cooper','Cox','Howard','Ward','Torres','Peterson','Gray','Ramirez','James','Watson','Brooks','Russell','Griffin','Hayes','Myers','Price','Bennett','Wood','Barnes','Ross','Henderson','Coleman','Jenkins','Perry','Powell','Long','Patterson','Hughes','Flores','Washington','Butler','Simmons','Foster','Bryant','Alexander','Russell','Griffin','Hayes','Carter','Robinson','Shaw','Garcia'];

// ═══════════════════════════════════════════════════════════════
// Data: 4 Drivers
// ═══════════════════════════════════════════════════════════════
const DRIVERS = [
  { user_id: '68570f3cd01bfa2d2408a9d7', id: '68dfe2ef6c16bedca49a41b9', name: 'Robert T', role: 'primary',
    home_lat: 53.4024845, home_lon: -113.5796823, pay_rate: 6.15, pay_cycle: 'semimonthly',
    extra_km_rate: 0.615, extra_km_limit: 10, oversized_rate: 1.5, sort_order: 1 },
  { user_id: '696825d8ffeeeb3965f2db70', id: '6968265f58e58d9cee41e741', name: 'Sharuk', role: 'primary',
    home_lat: 53.4843478, home_lon: -113.5100505, pay_rate: 5.50, pay_cycle: 'weekly',
    extra_km_rate: 0.55, extra_km_limit: 10, oversized_rate: 1.5, sort_order: 2 },
  { user_id: '6a0530f5d3e4aaf2e4095309', id: '6a053162eb3e03cee8a6bb82', name: 'Erin', role: 'secondary',
    home_lat: 53.48225957059834, home_lon: -113.50388457216759, pay_rate: 5.25, pay_cycle: 'semimonthly',
    extra_km_rate: 0.525, extra_km_limit: 10, oversized_rate: 1.0, sort_order: 3 },
  { user_id: '6a41857fe03681a2a1d3ca7b', id: '6a4186103ccd41fc4c6d2292', name: 'Anna', role: 'secondary',
    home_lat: 53.479975, home_lon: -113.457778, pay_rate: 6.15, pay_cycle: 'semimonthly',
    extra_km_rate: 0.615, extra_km_limit: 10, oversized_rate: 1.5, sort_order: 4 },
];

// ═══════════════════════════════════════════════════════════════
// Data: 12 Stores with pickup windows
// ═══════════════════════════════════════════════════════════════
const STORES = [
  { id: '695b6333e8a9b6f5b0c467d7', name: 'Lakeland Ridge', abbr: 'LR', lat: 53.5422291, lon: -113.2674898, color: '#008282', sort_order: 10, address: '550 Baseline Rd',
    am: { start: '12:00', end: '12:30', driver: '696825d8ffeeeb3965f2db70' }, pm: { start: '17:00', end: '17:30', driver: '696825d8ffeeeb3965f2db70' } },
  { id: '69354c3f7d5201849e84af97', name: 'Sherwood Pk Mall', abbr: 'SM', lat: 53.532611, lon: -113.2939723, color: '#ff329b', sort_order: 9, address: '2020 Sherwood Drive',
    am: { start: '11:30', end: '12:00', driver: '696825d8ffeeeb3965f2db70' }, pm: { start: '17:30', end: '18:00', driver: '696825d8ffeeeb3965f2db70' } },
  { id: '685cd33055969a07cb634fe9', name: 'Beverly', abbr: 'BS', lat: 53.5705384, lon: -113.4007079, color: '#a52d2d', sort_order: 3, address: '3812 118 Avenue NW',
    am: null, pm: { start: '14:00', end: '15:30', driver: '68570f3cd01bfa2d2408a9d7' }, sat_am: { start: '10:00', end: '12:00', driver: '696825d8ffeeeb3965f2db70' } },
  { id: '685cd33055969a07cb634fe8', name: 'WestPark', abbr: 'WP', lat: 53.6820807, lon: -113.2476868, color: '#008282', sort_order: 13, address: '100 Westpark Blvd',
    am: { start: '12:00', end: '13:00', driver: '6a41857fe03681a2a1d3ca7b' }, pm: null },
  { id: '685cd33055969a07cb634fe7', name: 'SouthPoint', abbr: 'SP', lat: 53.6947782, lon: -113.21636, color: '#0000ff', sort_order: 14, address: '9360 Southfort Dr',
    am: { start: '13:00', end: '14:00', driver: '6a41857fe03681a2a1d3ca7b' }, pm: null },
  { id: '685cd33055969a07cb634fe6', name: 'Callingwood', abbr: 'CW', lat: 53.5016037, lon: -113.6288272, color: '#008282', sort_order: 2, address: '6655 178 Street NW Unit 400',
    am: { start: '12:00', end: '13:00', driver: '68570f3cd01bfa2d2408a9d7' }, pm: null, cycling: { name: 'Callingwood Flo', lat: 53.5058511, lon: -113.6277473 } },
  { id: '685cd33055969a07cb634fe5', name: 'Hamptons', abbr: 'HS', lat: 53.4954693, lon: -113.6659074, color: '#ff329b', sort_order: 1, address: '6290 199 Street NW',
    am: { start: '10:00', end: '11:00', driver: '68570f3cd01bfa2d2408a9d7' }, pm: null },
  { id: '685cd33055969a07cb634fe4', name: 'Londonderry', abbr: 'LD', lat: 53.6012949, lon: -113.4468583, color: '#0000ff', sort_order: 4, address: '6806 137 Avenue NW Unit 101',
    am: null, pm: { start: '16:00', end: '17:00', driver: '68570f3cd01bfa2d2408a9d7' }, cycling: { name: 'Londonderry Flo', lat: 53.6041356, lon: -113.4453285 } },
  { id: '685cd33055969a07cb634fe3', name: 'Meadows', abbr: 'MD', lat: 53.4552334, lon: -113.3786324, color: '#820082', sort_order: 12, address: '2350 24 Street NW',
    am: null, pm: { start: '15:00', end: '16:00', driver: '6a41857fe03681a2a1d3ca7b' } },
  { id: '685cd33055969a07cb634fe2', name: 'Bonnie Doon', abbr: 'BD', lat: 53.5204309, lon: -113.4578861, color: '#820082', sort_order: 6, address: '8330 82 Avenue NW',
    am: { start: '11:00', end: '12:00', driver: '696825d8ffeeeb3965f2db70' }, pm: { start: '16:30', end: '17:30', driver: '696825d8ffeeeb3965f2db70' } },
  { id: '685cd33055969a07cb634fe1', name: 'Scona', abbr: 'SC', lat: 53.516657, lon: -113.4966775, color: '#ff329b', sort_order: 11, address: '8065 104 Street NW',
    am: null, pm: { start: '14:00', end: '15:00', driver: '6a0530f5d3e4aaf2e4095309' } },
  { id: '685cd33055969a07cb634fe0', name: 'Kingsway', abbr: 'KW', lat: 53.5633715, lon: -113.5068197, color: '#ff8c00', sort_order: 5, address: '1 Kingsway NW Unit 192',
    am: { start: '09:15', end: '09:45', driver: '696825d8ffeeeb3965f2db70' }, pm: null,
    sat_am: { start: '11:00', end: '12:00', driver: '696825d8ffeeeb3965f2db70' }, sun_am: { start: '10:00', end: '11:00', driver: '696825d8ffeeeb3965f2db70' } },
];

// InterStore locations for ISP/ISD
const IS_LOCATIONS = [
  { name: 'Millbourne Mall', lat: 53.4718923, lon: -113.4509796, addr: '188 38 Ave & Millwoods Rd', phone: '7804624704', num: '319' },
  { name: 'Millwoods TC', lat: 53.4558049, lon: -113.4297839, addr: '2331 66th St NW', phone: '7804611121', num: '346' },
  { name: 'Oliver Place', lat: 53.5413027, lon: -113.5238734, addr: '11720 Jasper Ave NW', phone: '7804821011', num: '365' },
  { name: 'Cromdale', lat: 53.5702047, lon: -113.466827, addr: '8121 118 Ave NW', phone: '7804771540', num: '370' },
  { name: 'Eaux Claires', lat: 53.6204151, lon: -113.490002, addr: '15969 97th Street NW', phone: '7804732813', num: '2374' },
  { name: 'West Edmonton Mall', lat: 53.5221441, lon: -113.6185465, addr: '8882 170th Street NW', phone: '7804444591', num: '3241' },
  { name: 'Jasper Gate Mall', lat: 53.5417269, lon: -113.5809445, addr: '10116 150 Street NW', phone: '7804879636', num: '2443' },
  { name: 'Calgary Trail', lat: 53.4877045, lon: -113.4927316, addr: '5050 Gateway Blvd NW', phone: '7804092011', num: '3734' },
  { name: 'Skyview', lat: 53.60008449999999, lon: -113.5464838, addr: '13040 137th Ave', phone: '7804564330', num: '397' },
  { name: 'Summerwood', lat: 53.5578547, lon: -113.2739846, addr: '20 4005 Clover Bar Road', phone: '7804493319', num: '2313' },
];

// ═══════════════════════════════════════════════════════════════
// 1-Week Schedule Plan
// Maps day-of-week → list of { storeId, slot: 'am'|'pm'|'sat_am'|'sun_am', driverId, useCycling, interStore }
// ═══════════════════════════════════════════════════════════════
const ROBERT = '68570f3cd01bfa2d2408a9d7';
const SHARUK = '696825d8ffeeeb3965f2db70';
const ERIN = '6a0530f5d3e4aaf2e4095309';
const ANNA = '6a41857fe03681a2a1d3ca7b';

type DayPlan = { store: typeof STORES[0], slot: string, driverId: string, driverName: string, useCycling?: boolean, isp?: typeof IS_LOCATIONS[0], isd?: typeof IS_LOCATIONS[0] };

function buildWeekPlan(): DayPlan[][] {
  const byId = (id: string) => STORES.find(s => s.id === id)!;
  const days: DayPlan[][] = [];

  // Monday
  days.push([
    { store: byId('685cd33055969a07cb634fe0'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Kingsway AM
    { store: byId('685cd33055969a07cb634fe5'), slot: 'am', driverId: ROBERT, driverName: 'Robert T' }, // Hamptons AM
    { store: byId('685cd33055969a07cb634fe2'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Bonnie Doon AM
    { store: byId('685cd33055969a07cb634fe8'), slot: 'am', driverId: ANNA, driverName: 'Anna' }, // WestPark AM
    { store: byId('685cd33055969a07cb634fe6'), slot: 'am', driverId: ROBERT, driverName: 'Robert T', useCycling: true }, // Callingwood AM (cycling)
    { store: byId('685cd33055969a07cb634fe9'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T' }, // Beverly PM
    { store: byId('685cd33055969a07cb634fe1'), slot: 'pm', driverId: ERIN, driverName: 'Erin' }, // Scona PM
    { store: byId('685cd33055969a07cb634fe3'), slot: 'pm', driverId: ANNA, driverName: 'Anna' }, // Meadows PM
    { store: byId('685cd33055969a07cb634fe4'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T', useCycling: true, isp: IS_LOCATIONS[3] }, // Londonderry PM (cycling, ISP from Cromdale)
    { store: byId('685cd33055969a07cb634fe2'), slot: 'pm', driverId: SHARUK, driverName: 'Sharuk', isd: IS_LOCATIONS[2] }, // Bonnie Doon PM (ISD to Oliver Place)
  ]);

  // Tuesday
  days.push([
    { store: byId('69354c3f7d5201849e84af97'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Sherwood Pk Mall AM
    { store: byId('695b6333e8a9b6f5b0c467d7'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Lakeland Ridge AM
    { store: byId('685cd33055969a07cb634fe7'), slot: 'am', driverId: ANNA, driverName: 'Anna' }, // SouthPoint AM
    { store: byId('685cd33055969a07cb634fe6'), slot: 'am', driverId: ROBERT, driverName: 'Robert T', useCycling: true, isp: IS_LOCATIONS[5] }, // Callingwood AM (cycling, ISP from WEM)
    { store: byId('685cd33055969a07cb634fe9'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T' }, // Beverly PM
    { store: byId('685cd33055969a07cb634fe1'), slot: 'pm', driverId: ERIN, driverName: 'Erin' }, // Scona PM
    { store: byId('685cd33055969a07cb634fe3'), slot: 'pm', driverId: ANNA, driverName: 'Anna' }, // Meadows PM
    { store: byId('69354c3f7d5201849e84af97'), slot: 'pm', driverId: SHARUK, driverName: 'Sharuk' }, // Sherwood Pk Mall PM
    { store: byId('695b6333e8a9b6f5b0c467d7'), slot: 'pm', driverId: SHARUK, driverName: 'Sharuk' }, // Lakeland Ridge PM
  ]);

  // Wednesday
  days.push([
    { store: byId('685cd33055969a07cb634fe0'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Kingsway AM
    { store: byId('685cd33055969a07cb634fe5'), slot: 'am', driverId: ROBERT, driverName: 'Robert T' }, // Hamptons AM
    { store: byId('685cd33055969a07cb634fe2'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Bonnie Doon AM
    { store: byId('685cd33055969a07cb634fe8'), slot: 'am', driverId: ANNA, driverName: 'Anna' }, // WestPark AM
    { store: byId('685cd33055969a07cb634fe6'), slot: 'am', driverId: ROBERT, driverName: 'Robert T', useCycling: true }, // Callingwood AM (cycling)
    { store: byId('685cd33055969a07cb634fe4'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T', useCycling: true }, // Londonderry PM (cycling)
    { store: byId('685cd33055969a07cb634fe9'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T' }, // Beverly PM
    { store: byId('685cd33055969a07cb634fe1'), slot: 'pm', driverId: ERIN, driverName: 'Erin' }, // Scona PM
    { store: byId('685cd33055969a07cb634fe3'), slot: 'pm', driverId: ANNA, driverName: 'Anna' }, // Meadows PM
    { store: byId('685cd33055969a07cb634fe2'), slot: 'pm', driverId: SHARUK, driverName: 'Sharuk' }, // Bonnie Doon PM
  ]);

  // Thursday
  days.push([
    { store: byId('69354c3f7d5201849e84af97'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Sherwood Pk Mall AM
    { store: byId('695b6333e8a9b6f5b0c467d7'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Lakeland Ridge AM
    { store: byId('685cd33055969a07cb634fe7'), slot: 'am', driverId: ANNA, driverName: 'Anna' }, // SouthPoint AM
    { store: byId('685cd33055969a07cb634fe6'), slot: 'am', driverId: ROBERT, driverName: 'Robert T', useCycling: true }, // Callingwood AM (cycling)
    { store: byId('685cd33055969a07cb634fe9'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T', isp: IS_LOCATIONS[3] }, // Beverly PM (ISP from Cromdale)
    { store: byId('685cd33055969a07cb634fe1'), slot: 'pm', driverId: ERIN, driverName: 'Erin', isd: IS_LOCATIONS[7] }, // Scona PM (ISD to Calgary Trail)
    { store: byId('69354c3f7d5201849e84af97'), slot: 'pm', driverId: SHARUK, driverName: 'Sharuk' }, // Sherwood Pk Mall PM
    { store: byId('695b6333e8a9b6f5b0c467d7'), slot: 'pm', driverId: SHARUK, driverName: 'Sharuk' }, // Lakeland Ridge PM
    { store: byId('685cd33055969a07cb634fe4'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T', useCycling: true }, // Londonderry PM (cycling)
  ]);

  // Friday
  days.push([
    { store: byId('685cd33055969a07cb634fe0'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Kingsway AM
    { store: byId('685cd33055969a07cb634fe5'), slot: 'am', driverId: ROBERT, driverName: 'Robert T' }, // Hamptons AM
    { store: byId('685cd33055969a07cb634fe2'), slot: 'am', driverId: SHARUK, driverName: 'Sharuk' }, // Bonnie Doon AM
    { store: byId('685cd33055969a07cb634fe8'), slot: 'am', driverId: ANNA, driverName: 'Anna' }, // WestPark AM
    { store: byId('685cd33055969a07cb634fe6'), slot: 'am', driverId: ROBERT, driverName: 'Robert T', useCycling: true, isp: IS_LOCATIONS[5] }, // Callingwood AM (cycling, ISP from WEM)
    { store: byId('685cd33055969a07cb634fe9'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T' }, // Beverly PM
    { store: byId('685cd33055969a07cb634fe1'), slot: 'pm', driverId: ERIN, driverName: 'Erin' }, // Scona PM
    { store: byId('685cd33055969a07cb634fe3'), slot: 'pm', driverId: ANNA, driverName: 'Anna' }, // Meadows PM
    { store: byId('685cd33055969a07cb634fe4'), slot: 'pm', driverId: ROBERT, driverName: 'Robert T', useCycling: true }, // Londonderry PM (cycling)
    { store: byId('685cd33055969a07cb634fe2'), slot: 'pm', driverId: SHARUK, driverName: 'Sharuk', isd: IS_LOCATIONS[0] }, // Bonnie Doon PM (ISD to Millbourne)
  ]);

  // Saturday
  days.push([
    { store: byId('685cd33055969a07cb634fe0'), slot: 'sat_am', driverId: SHARUK, driverName: 'Sharuk' }, // Kingsway Sat AM
    { store: byId('685cd33055969a07cb634fe9'), slot: 'sat_am', driverId: SHARUK, driverName: 'Sharuk' }, // Beverly Sat AM
  ]);

  // Sunday
  days.push([
    { store: byId('685cd33055969a07cb634fe0'), slot: 'sun_am', driverId: SHARUK, driverName: 'Sharuk' }, // Kingsway Sun AM
  ]);

  return days;
}

// ═══════════════════════════════════════════════════════════════
// Patient Generator
// ═══════════════════════════════════════════════════════════════
function generatePatients(store: typeof STORES[0], count: number) {
  const patients = [];
  for (let i = 0; i < count; i++) {
    const dist = rand(0.3, 18);
    const angle = rand(0, 360);
    const coords = offsetCoords(store.lat, store.lon, dist, angle);
    const fn = pick(firstNames), ln = pick(lastNames);
    const addr = `${randInt(100, 9999)} ${pick(streetNames)} ${pick(streetTypes)}`;
    patients.push({
      full_name: `${fn} ${ln}`,
      address: addr,
      latitude: coords.latitude,
      longitude: coords.longitude,
      distance_from_store: +dist.toFixed(2),
      phone: `(780) ${randInt(200, 999)}-${String(randInt(1000, 9999)).padStart(4, '0')}`,
      notes: pick(['Leave at front desk', 'Ring bell twice', 'Call on arrival', 'Side entrance', 'Fragile package', 'Mailbox OK', 'Back door', '']),
      mailbox_ok: Math.random() > 0.5,
      call_upon_arrival: Math.random() > 0.6,
      ring_bell: Math.random() > 0.2,
      dont_ring_bell: Math.random() > 0.85,
      back_door: Math.random() > 0.8,
      time_window_start: pick(['09:00', '10:00', '11:00', '13:00', '14:00']),
      time_window_end: pick(['12:00', '14:00', '16:00', '18:00', '20:00']),
    });
  }
  return patients;
}

// ═══════════════════════════════════════════════════════════════
// Nearest Neighbor Sort (optimize stop order from store)
// ═══════════════════════════════════════════════════════════════
function sortNearestNeighbor(store: typeof STORES[0], patients: any[]) {
  const remaining = [...patients];
  const sorted: any[] = [];
  let currentLat = store.lat, currentLon = store.lon;

  while (remaining.length > 0) {
    let minIdx = 0, minDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(currentLat, currentLon, remaining[i].latitude, remaining[i].longitude);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    const next = remaining.splice(minIdx, 1)[0];
    sorted.push(next);
    currentLat = next.latitude;
    currentLon = next.longitude;
  }
  return sorted;
}

// ═══════════════════════════════════════════════════════════════
// Main Handler
// ═══════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const weekStart = body.week_start_date ? new Date(body.week_start_date) : (() => {
      // Default: next Monday
      const d = new Date();
      const dow = d.getDay();
      const daysUntilMon = dow === 0 ? 1 : 8 - dow;
      d.setDate(d.getDate() + daysUntilMon);
      return d;
    })();
    const shouldClear = body.clear_existing !== false; // default true

    const db = base44.asServiceRole;
    const stats = { stores: 0, drivers: 0, patients: 0, routes: 0, cycling_markers: 0, interstore: 0, failed: 0, returns: 0 };

    // ── Clear existing demo data ──
    if (shouldClear) {
      const [routes, patients, appUsers, stores] = await Promise.all([
        db.entities.DemoRoute.filter({}, 'created_date', 500, 0),
        db.entities.DemoPatient.filter({}, 'created_date', 500, 0),
        db.entities.DemoAppUser.filter({}, 'created_date', 500, 0),
        db.entities.DemoStore.filter({}, 'created_date', 500, 0),
      ]);

      // Paginate and delete all
      const deleteAll = async (entity: string, items: any[]) => {
        let all = items;
        let skip = 500;
        while (all.length === 500) {
          const next = await (db.entities as any)[entity].filter({}, 'created_date', 500, skip);
          all = next;
          skip += 500;
        }
        // Delete in batches
        for (const item of items) {
          await (db.entities as any)[entity].delete(item.id).catch(() => {});
        }
      };

      await Promise.all([
        ...routes.map((r: any) => db.entities.DemoRoute.delete(r.id).catch(() => {})),
        ...patients.map((p: any) => db.entities.DemoPatient.delete(p.id).catch(() => {})),
        ...appUsers.map((u: any) => db.entities.DemoAppUser.delete(u.id).catch(() => {})),
        ...stores.map((s: any) => db.entities.DemoStore.delete(s.id).catch(() => {})),
      ]);
    }

    // ── Create DemoAppUsers ──
    for (const d of DRIVERS) {
      await db.entities.DemoAppUser.create({
        user_id: d.user_id,
        app_roles: d.role === 'primary' ? ['admin', 'driver'] : ['driver'],
        user_name: d.name,
        home_latitude: d.home_lat,
        home_longitude: d.home_lon,
        city_id: '6858ef85659a1fbb068efa5f',
        store_ids: [],
        sort_order: d.sort_order,
        status: 'active',
        driver_status: 'off_duty',
        location_tracking_enabled: true,
        pay_rate_per_delivery: d.pay_rate,
        extra_km_rate: d.extra_km_rate,
        extra_km_limit: d.extra_km_limit,
        oversized_item_rate: d.oversized_rate,
        pay_cycle_type: d.pay_cycle,
        gst_hst_enabled: false,
        is_demo: true,
      });
      stats.drivers++;
    }

    // ── Create DemoStores ──
    for (const s of STORES) {
      await db.entities.DemoStore.create({
        name: s.name,
        abbreviation: s.abbr,
        address: s.address,
        phone: '(780) 555-0000',
        latitude: s.lat,
        longitude: s.lon,
        city_id: '6858ef85659a1fbb068efa5f',
        color: s.color,
        status: 'active',
        sort_order: s.sort_order,
        base_tracking_number: 0,
        weekday_am_enabled: !!s.am,
        weekday_am_start: s.am?.start || '',
        weekday_am_end: s.am?.end || '',
        weekday_am_driver_id: s.am?.driver || null,
        weekday_pm_enabled: !!s.pm,
        weekday_pm_start: s.pm?.start || '',
        weekday_pm_end: s.pm?.end || '',
        weekday_pm_driver_id: s.pm?.driver || null,
        saturday_am_enabled: !!(s as any).sat_am,
        saturday_am_start: (s as any).sat_am?.start || '',
        saturday_am_end: (s as any).sat_am?.end || '',
        saturday_am_driver_id: (s as any).sat_am?.driver || null,
        sunday_am_enabled: !!(s as any).sun_am,
        sunday_am_start: (s as any).sun_am?.start || '',
        sunday_am_end: (s as any).sun_am?.end || '',
        sunday_am_driver_id: (s as any).sun_am?.driver || null,
        is_demo: true,
      });
      stats.stores++;
    }

    // ── Create DemoSettings ──
    const existingSettings = await db.entities.DemoSettings.filter({ user_id: user.id });
    if (existingSettings.length > 0) {
      await db.entities.DemoSettings.update(existingSettings[0].id, { is_demo_mode_active: true, demo_store_id: null });
    } else {
      await db.entities.DemoSettings.create({ user_id: user.id, is_demo_mode_active: true, demo_store_id: null });
    }

    // ── Generate Week of Routes ──
    const weekPlan = buildWeekPlan();
    const stopIdSet = new Set<string>();
    const genStopId = () => { let id: string; do { id = genId(3); } while (stopIdSet.has(id)); stopIdSet.add(id); return id; };

    // Store patient pools (reuse across days for same store)
    const patientPools: Map<string, any[]> = new Map();
    for (const s of STORES) {
      patientPools.set(s.id, generatePatients(s, 25));
    }

    for (let dayIdx = 0; dayIdx < weekPlan.length; dayIdx++) {
      const dayDate = addDays(weekStart, dayIdx);
      const dateStr = fmtDate(dayDate);
      const daySlots = weekPlan[dayIdx];

      for (const slot of daySlots) {
        const store = slot.store;
        const driver = DRIVERS.find(d => d.user_id === slot.driverId)!;
        const slotKey = slot.slot; // 'am', 'pm', 'sat_am', 'sun_am'
        const isAM = slotKey.includes('am');

        // Get pickup window
        let pickupWindow: { start: string; end: string };
        if (slotKey === 'am') pickupWindow = store.am!;
        else if (slotKey === 'pm') pickupWindow = store.pm!;
        else if (slotKey === 'sat_am') pickupWindow = (store as any).sat_am!;
        else if (slotKey === 'sun_am') pickupWindow = (store as any).sun_am!;
        else pickupWindow = store.am || store.pm!;

        // Determine number of deliveries (4-10, weekday more, weekend less)
        const isWeekend = dayIdx >= 5;
        const numDeliveries = isWeekend ? randInt(5, 10) : randInt(5, 12);

        // Get patients for this slot
        const pool = patientPools.get(store.id)!;
        const slotPatients: any[] = [];
        for (let i = 0; i < numDeliveries; i++) {
          slotPatients.push(pool[(dayIdx * 7 + i) % pool.length]);
        }

        // Optimize stop order (nearest neighbor from store)
        const sortedPatients = sortNearestNeighbor(store, slotPatients);

        // ── Create cycling markers if applicable ──
        let pickupStopOrder = 1;
        let pickupStopId = genStopId();
        let trackingBase = 0; // Will be set per store

        if (slot.useCycling && store.cycling) {
          // Cycling Start marker (driving to cycling location)
          const cycleStartStopId = genStopId();
          await db.entities.DemoRoute.create({
            delivery_id: `DEMO-CYC-START-${store.abbr}-${driver.name}-${dateStr}`,
            patient_id: '',
            driver_id: driver.user_id,
            driver_name: driver.name,
            created_by_app_user_id: user.id,
            delivery_date: dateStr,
            delivery_time_start: pickupWindow.start,
            delivery_time_end: addMin(pickupWindow.start, 5),
            delivery_time_eta: pickupWindow.start,
            actual_delivery_time: buildDT(dayDate, addMin(pickupWindow.start, randInt(3, 10))),
            status: 'completed',
            store_id: store.id,
            tracking_number: '00',
            stop_order: 1,
            stop_id: cycleStartStopId,
            delivery_notes: `Cycling Start: ${store.cycling.name}`,
            delivery_instructions: `Drive to ${store.cycling.name} cycling location`,
            ampm_deliveries: isAM ? 'AM' : 'PM',
            extra_time: 5,
            is_cycling_marker: true,
            cycling_latitude: store.cycling.lat,
            cycling_longitude: store.cycling.lon,
            transport_mode: 'driving',
            latitude: store.cycling.lat,
            longitude: store.cycling.lon,
            is_demo: true,
          });
          stats.cycling_markers++;
          pickupStopOrder = 2;

          // Cycling End marker (cycling to store)
          const cycleEndStopId = genStopId();
          await db.entities.DemoRoute.create({
            delivery_id: `DEMO-CYC-END-${store.abbr}-${driver.name}-${dateStr}`,
            patient_id: '',
            driver_id: driver.user_id,
            driver_name: driver.name,
            created_by_app_user_id: user.id,
            delivery_date: dateStr,
            delivery_time_start: addMin(pickupWindow.start, 10),
            delivery_time_end: addMin(pickupWindow.start, 20),
            delivery_time_eta: addMin(pickupWindow.start, 15),
            actual_delivery_time: buildDT(dayDate, addMin(pickupWindow.start, randInt(15, 25))),
            status: 'completed',
            store_id: store.id,
            tracking_number: '00',
            stop_order: 2,
            stop_id: cycleEndStopId,
            delivery_notes: `Cycling End: Arrived at ${store.name}`,
            delivery_instructions: `Bike from ${store.cycling.name} to ${store.name}`,
            ampm_deliveries: isAM ? 'AM' : 'PM',
            extra_time: 10,
            is_cycling_marker: true,
            cycling_latitude: store.cycling.lat,
            cycling_longitude: store.cycling.lon,
            transport_mode: 'cycling',
            latitude: store.lat,
            longitude: store.lon,
            is_demo: true,
          });
          stats.cycling_markers++;
          pickupStopOrder = 3;
          pickupStopId = genStopId();
        }

        // ── Create ISP (InterStore Pickup) if applicable ──
        if (slot.isp) {
          const ispStopId = genStopId();
          const ispTime = addMin(pickupWindow.start, -30); // ISP happens 30 min before regular pickup
          await db.entities.DemoRoute.create({
            delivery_id: `DEMO-ISP-${store.abbr}-${driver.name}-${dateStr}`,
            patient_id: '',
            driver_id: driver.user_id,
            driver_name: driver.name,
            created_by_app_user_id: user.id,
            delivery_date: dateStr,
            delivery_time_start: ispTime,
            delivery_time_end: addMin(ispTime, 15),
            delivery_time_eta: ispTime,
            actual_delivery_time: buildDT(dayDate, addMin(ispTime, randInt(5, 15))),
            status: 'completed',
            store_id: store.id,
            tracking_number: 'ISP',
            stop_order: 0,
            stop_id: ispStopId,
            delivery_notes: `InterStore Pickup from ${slot.isp.name}`,
            delivery_instructions: `Pick up items from ${slot.isp.name} (${slot.isp.addr})`,
            ampm_deliveries: isAM ? 'AM' : 'PM',
            extra_time: 15,
            _interstore_source_id: slot.isp.num,
            _interstore_source_name: slot.isp.name,
            latitude: slot.isp.lat,
            longitude: slot.isp.lon,
            transport_mode: 'driving',
            is_demo: true,
          });
          stats.interstore++;
        }

        // ── Create Store Pickup (en_route) ──
        const pickupActualTime = buildDT(dayDate, addMin(pickupWindow.start, randInt(3, 15)));
        await db.entities.DemoRoute.create({
          delivery_id: `DEMO-PICKUP-${store.abbr}-${driver.name}-${dateStr}-${slotKey.toUpperCase()}`,
          patient_id: '',
          driver_id: driver.user_id,
          driver_name: driver.name,
          created_by_app_user_id: user.id,
          delivery_date: dateStr,
          delivery_time_start: pickupWindow.start,
          delivery_time_end: pickupWindow.end,
          delivery_time_eta: pickupWindow.start,
          actual_delivery_time: pickupActualTime,
          status: 'completed',
          store_id: store.id,
          tracking_number: '00',
          stop_order: pickupStopOrder,
          stop_id: pickupStopId,
          puid: pickupStopId,
          delivery_notes: `Store pickup: ${store.name}`,
          delivery_instructions: 'Store pickup',
          ampm_deliveries: isAM ? 'AM' : 'PM',
          extra_time: 5,
          latitude: store.lat,
          longitude: store.lon,
          transport_mode: slot.useCycling ? 'cycling' : 'driving',
          is_demo: true,
        });
        stats.routes++;

        // ── Create Delivery Stops ──
        let lastTimeMin = h2m(pickupWindow.start) + 20; // Start deliveries 20 min after pickup

        for (let i = 0; i < sortedPatients.length; i++) {
          const patient = sortedPatients[i];
          const stopOrder = pickupStopOrder + 1 + i;
          const trackingNumber = String(stopOrder).padStart(2, '0');

          // Time progression: 15-30 min per delivery
          const deliveryDuration = randInt(15, 30);
          lastTimeMin += deliveryDuration;
          const deliveryTime = m2h(Math.min(lastTimeMin, 20 * 60)); // Cap at 8 PM

          // Status: 85% completed, 10% failed, 5% returned
          const statusRoll = Math.random();
          let status = 'completed';
          if (statusRoll < 0.05) status = 'failed';
          else if (statusRoll < 0.08) status = 'cancelled';

          // COD: 70% no payment, 15% cash, 10% debit, 5% credit
          const codRoll = Math.random();
          let codType = 'No Payment';
          let codAmount = '';
          let codRequired = 0;
          if (codRoll < 0.15) { codType = 'Cash'; codAmount = String(randInt(10, 80)); codRequired = parseFloat(codAmount); }
          else if (codRoll < 0.25) { codType = 'Debit'; codAmount = String(randInt(15, 120)); codRequired = parseFloat(codAmount); }
          else if (codRoll < 0.30) { codType = 'Credit'; codAmount = String(randInt(15, 120)); codRequired = parseFloat(codAmount); }

          const actualTime = (status === 'completed' || status === 'failed' || status === 'cancelled')
            ? buildDT(dayDate, deliveryTime) : '';

          // Create or get patient record
          let patientId = `DEMO-P-${store.abbr}-${genId(5)}`;
          let createdPatient = await db.entities.DemoPatient.create({
            store_id: store.id,
            full_name: patient.full_name,
            patient_id: patientId,
            address: patient.address,
            latitude: patient.latitude,
            longitude: patient.longitude,
            distance_from_store: patient.distance_from_store,
            phone: patient.phone,
            notes: patient.notes,
            mailbox_ok: patient.mailbox_ok,
            call_upon_arrival: patient.call_upon_arrival,
            ring_bell: patient.ring_bell,
            dont_ring_bell: patient.dont_ring_bell,
            back_door: patient.back_door,
            time_window_start: patient.time_window_start,
            time_window_end: patient.time_window_end,
            status: 'active',
            is_demo: true,
          }).catch(() => null);
          if (createdPatient) stats.patients++;

          const deliveryStopId = genStopId();

          // Delivery flags
          const isFirstDelivery = Math.random() < 0.15;
          const isFridge = Math.random() < 0.12;
          const isOversized = Math.random() < 0.08;
          const needsSignature = Math.random() < 0.35;

          await db.entities.DemoRoute.create({
            delivery_id: `DEMO-DEL-${store.abbr}-${driver.name}-${dateStr}-${slotKey.toUpperCase()}-${i+1}`,
            patient_id: createdPatient?.id || patientId,
            driver_id: driver.user_id,
            driver_name: driver.name,
            created_by_app_user_id: user.id,
            delivery_date: dateStr,
            delivery_time_start: patient.time_window_start || addMin(pickupWindow.start, 30 + i * 25),
            delivery_time_end: patient.time_window_end || addMin(patient.time_window_start || pickupWindow.start, 120),
            delivery_time_eta: addMin(deliveryTime, -randInt(0, 15)),
            arrival_time: buildDT(dayDate, addMin(deliveryTime, -randInt(2, 8))),
            actual_delivery_time: actualTime,
            status,
            store_id: store.id,
            tracking_number: trackingNumber,
            stop_order: stopOrder,
            stop_id: deliveryStopId,
            puid: pickupStopId,
            delivery_notes: status === 'failed' ? pick(['Patient not home', 'Address issue', 'Delivery delayed', 'Wrong address']) :
                           status === 'cancelled' ? 'Cancelled by pharmacy' : patient.notes || 'Delivered successfully',
            delivery_instructions: patient.notes || '',
            ampm_deliveries: isAM ? 'AM' : 'PM',
            extra_time: 5,
            cod_payment_type: codType,
            cod_amount: codAmount,
            cod_total_amount_required: codRequired,
            signature_needed: needsSignature,
            signature_image_url: needsSignature && status === 'completed' ? 'demo-signature.png' : '',
            fridge_item: isFridge,
            oversized: isOversized,
            first_delivery: isFirstDelivery,
            latitude: patient.latitude,
            longitude: patient.longitude,
            estimated_distance_km: +haversineKm(store.lat, store.lon, patient.latitude, patient.longitude).toFixed(2),
            transport_mode: slot.useCycling ? 'cycling' : 'driving',
            is_demo: true,
          });
          stats.routes++;

          // ── Failed delivery follow-up (retry or return) ──
          if (status === 'failed') {
            stats.failed++;
            const followUpType = Math.random() < 0.6 ? 'retry' : 'return';
            const followUpStopId = genStopId();

            if (followUpType === 'retry') {
              // Retry next day
              const retryDate = addDays(dayDate, 1);
              const retryDateStr = fmtDate(retryDate);
              await db.entities.DemoRoute.create({
                delivery_id: `DEMO-RETRY-${store.abbr}-${driver.name}-${retryDateStr}-${i+1}`,
                patient_id: createdPatient?.id || patientId,
                driver_id: driver.user_id,
                driver_name: driver.name,
                created_by_app_user_id: user.id,
                delivery_date: retryDateStr,
                delivery_time_start: addMin(patient.time_window_start || pickupWindow.start, 60),
                delivery_time_end: addMin(patient.time_window_end || '18:00', 60),
                delivery_time_eta: addMin(patient.time_window_start || pickupWindow.start, 60),
                actual_delivery_time: buildDT(retryDate, addMin(patient.time_window_start || pickupWindow.start, randInt(60, 90))),
                status: 'completed',
                store_id: store.id,
                tracking_number: `${trackingNumber}R`,
                stop_order: stopOrder + 100,
                stop_id: followUpStopId,
                puid: pickupStopId,
                delivery_notes: 'Retry: delivered successfully after failed attempt',
                delivery_instructions: patient.notes || '',
                ampm_deliveries: isAM ? 'AM' : 'PM',
                extra_time: 5,
                latitude: patient.latitude,
                longitude: patient.longitude,
                is_demo: true,
              });
              stats.routes++;
            } else {
              // Return to store
              stats.returns++;
              await db.entities.DemoRoute.create({
                delivery_id: `DEMO-RETURN-${store.abbr}-${driver.name}-${dateStr}-${i+1}`,
                patient_id: '',
                driver_id: driver.user_id,
                driver_name: driver.name,
                created_by_app_user_id: user.id,
                delivery_date: dateStr,
                delivery_time_start: addMin(pickupWindow.end || '17:00', 30),
                delivery_time_end: addMin(pickupWindow.end || '17:00', 45),
                delivery_time_eta: addMin(pickupWindow.end || '17:00', 35),
                actual_delivery_time: buildDT(dayDate, addMin(pickupWindow.end || '17:00', randInt(30, 45))),
                status: 'completed',
                store_id: store.id,
                tracking_number: `${trackingNumber}T`,
                stop_order: 999,
                stop_id: followUpStopId,
                puid: pickupStopId,
                delivery_notes: `Return: ${store.name} Return\nFor: ${patient.full_name}`,
                delivery_instructions: 'Return to store',
                ampm_deliveries: isAM ? 'AM' : 'PM',
                extra_time: 5,
                latitude: store.lat,
                longitude: store.lon,
                is_demo: true,
              });
              stats.routes++;
            }
          }

          // ── ISD (InterStore Dropoff) if applicable ──
          if (slot.isd && i === Math.floor(sortedPatients.length / 2)) {
            // Insert ISD in the middle of the route
            const isdStopId = genStopId();
            const isdTime = m2h(lastTimeMin + 15);
            await db.entities.DemoRoute.create({
              delivery_id: `DEMO-ISD-${store.abbr}-${driver.name}-${dateStr}-${slotKey.toUpperCase()}`,
              patient_id: '',
              driver_id: driver.user_id,
              driver_name: driver.name,
              created_by_app_user_id: user.id,
              delivery_date: dateStr,
              delivery_time_start: isdTime,
              delivery_time_end: addMin(isdTime, 15),
              delivery_time_eta: isdTime,
              actual_delivery_time: buildDT(dayDate, addMin(isdTime, randInt(5, 12))),
              status: 'completed',
              store_id: store.id,
              tracking_number: 'ISD',
              stop_order: stopOrder + 0.5,
              stop_id: isdStopId,
              puid: pickupStopId,
              delivery_notes: `InterStore Dropoff to ${slot.isd.name}`,
              delivery_instructions: `Drop off items at ${slot.isd.name} (${slot.isd.addr})`,
              ampm_deliveries: isAM ? 'AM' : 'PM',
              extra_time: 15,
              _interstore_dest_id: slot.isd.num,
              _interstore_dest_name: slot.isd.name,
              latitude: slot.isd.lat,
              longitude: slot.isd.lon,
              transport_mode: 'driving',
              is_demo: true,
            });
            stats.interstore++;
            stats.routes++;
          }
        }
      }
    }

    // ── Final count ──
    const finalRoutes = await db.entities.DemoRoute.filter({}, 'created_date', 1, 0);

    return Response.json({
      success: true,
      week_start: fmtDate(weekStart),
      stats: {
        ...stats,
        total_routes_in_db: (await db.entities.DemoRoute.filter({}, 'created_date', 500, 0)).length,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
});
