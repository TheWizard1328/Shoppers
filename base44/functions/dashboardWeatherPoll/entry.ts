// dashboardWeatherPoll — 5-MINUTE dashboard weather-bar poll (backend half of
// the thermometer bar feature). Runs from the "Dashboard Weather Poll" workflow
// every 5 minutes. Zero integration credits — plain web fetches, no LLM, no
// platform-managed service calls.
//
// Logic:
//   1. Fetch weather for EVERY configured city (owner request, Sep 28 —
//      the bar updates every 5 minutes even when no driver is on duty).
//   2. Fetch current + daily weather per active city
//      (Open-Meteo → wttr.in → met.no, same 3-provider fallback as the
//      morning briefing).
//   3. Diff against the shared AppSettings 'dashboard_weather' record.
//      ANY meaningful change (temp, condition, icon, high/low, precip) →
//      ONE entity update → the existing AppSettings WebSocket subscription
//      broadcasts 'appSettingsUpdated' to every online device, which is what
//      updates the weather thermometer bars everywhere.
//      No change → NO write, NO broadcast (silent poll).
// Devices that come online later just read the stored record — they never hit
// the weather services themselves.
//
// Params: { dry_run?: boolean, client_refresh?: boolean, force_refresh?: boolean }
//  client_refresh — set by the app when it loads and the stored snapshot is
//    >5 min old: also re-fetches previously stored cities (works with no
//    drivers on duty). Still subject to the 4-minute freshness guard.
//  force_refresh — bypasses the freshness guard (admin/testing).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SETTINGS_KEY = 'dashboard_weather';

function edmontonToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

// WMO weather interpretation codes → short text
function wmoText(code) {
  const m = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
    85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm',
  };
  return m[code] || 'Mixed';
}

// Icon bucket for the thermometer bar: sun / partly / cloud / fog / rain / snow / storm
function wmoIcon(code) {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2) return 'partly';
  if (code === 45 || code === 48) return 'fog';
  if (code === 3) return 'cloud';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
}
function iconFromText(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('thunder')) return 'storm';
  if (t.includes('snow') || t.includes('sleet') || t.includes('blizzard') || t.includes('ice')) return 'snow';
  if (t.includes('rain') || t.includes('drizzle') || t.includes('shower')) return 'rain';
  if (t.includes('fog') || t.includes('mist')) return 'fog';
  if (t.includes('partly')) return 'partly';
  if (t.includes('cloud') || t.includes('overcast')) return 'cloud';
  if (t.includes('clear') || t.includes('sunny')) return 'sun';
  return 'cloud';
}

function mapWttrDesc(v) {
  const d = (v || '').toLowerCase();
  if (d.includes('thunder')) return 'Thunderstorm';
  if (d.includes('snow') || d.includes('sleet') || d.includes('blizzard') || d.includes('ice')) return 'Snow';
  if (d.includes('rain') || d.includes('drizzle') || d.includes('shower')) return 'Rain';
  if (d.includes('fog') || d.includes('mist')) return 'Fog';
  if (d.includes('overcast')) return 'Overcast';
  if (d.includes('partly cloudy')) return 'Partly cloudy';
  if (d.includes('clear') || d.includes('sunny')) return 'Clear';
  return 'Mixed';
}
function mapMetNoSymbol(s) {
  const c = (s || '');
  if (c.includes('thunder')) return 'Thunderstorm';
  if (c.includes('sleet')) return 'Sleet';
  if (c.includes('snow')) return 'Snow';
  if (c.includes('rain')) return 'Rain';
  if (c.includes('fog')) return 'Fog';
  if (c.startsWith('partlycloudy')) return 'Partly cloudy';
  if (c.startsWith('cloudy')) return 'Cloudy';
  if (c.startsWith('clearsky')) return 'Clear';
  return 'Mixed';
}

// ── Weather providers (same normalization as driverWeatherBriefing) ─────────
async function fetchOpenMeteo(lat, lon, attempt = 1) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum,weather_code` +
    `&timezone=America%2FEdmonton&forecast_days=1`;
  let res = await fetch(url).catch((e) => { console.warn('[dashboardWeatherPoll] open-meteo attempt', attempt, 'network error:', e?.message || e); return null; });
  if (!res || !res.ok) {
    if (res) console.warn('[dashboardWeatherPoll] open-meteo attempt', attempt, 'HTTP', res.status);
    if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500)); return fetchOpenMeteo(lat, lon, attempt + 1); }
    return null;
  }
  const j = await res.json().catch(() => null);
  if (!j?.current || !j?.daily) { console.warn('[dashboardWeatherPoll] open-meteo OK HTTP but malformed payload'); return null; }
  const code = j.current.weather_code;
  return {
    current: { temp: Math.round(j.current.temperature_2m), feels: Math.round(j.current.apparent_temperature), text: wmoText(code), icon: wmoIcon(code), wind: Math.round(j.current.wind_speed_10m) },
    daily: { high: Math.round(j.daily.temperature_2m_max?.[0]), low: Math.round(j.daily.temperature_2m_min?.[0]), precipProb: j.daily.precipitation_probability_max?.[0] ?? null, snowCm: j.daily.snowfall_sum?.[0] ?? 0, text: wmoText(j.daily.weather_code?.[0]) },
    source: 'open-meteo',
  };
}
async function fetchWttr(lat, lon) {
  const res = await fetch(`https://wttr.in/${lat},${lon}?format=j1`, { headers: { 'User-Agent': 'RxDeliver-WeatherBar/1.0' } }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null);
  const cur = j?.current_condition?.[0];
  const today = j?.weather?.[0];
  if (!cur || !today) return null;
  let precipProb = 0;
  for (const h of (today.hourly || [])) precipProb = Math.max(precipProb, Number(h?.chanceofrain) || 0, Number(h?.chanceofsnow) || 0);
  const text = mapWttrDesc(cur.weatherDesc?.[0]?.value);
  return {
    current: { temp: Math.round(Number(cur.temp_C)), feels: Math.round(Number(cur.FeelsLikeC)), text, icon: iconFromText(text), wind: Math.round(Number(cur.windspeedKmph) || 0) },
    daily: { high: Math.round(Number(today.maxtempC)), low: Math.round(Number(today.mintempC)), precipProb: precipProb || null, snowCm: Number(today.totalSnow_cm) || 0, text },
    source: 'wttr.in',
  };
}
async function fetchMetNo(lat, lon) {
  const res = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${Number(lat).toFixed(4)}&lon=${Number(lon).toFixed(4)}`, {
    headers: { 'User-Agent': 'RxDeliver-WeatherBar/1.0 (github.com/TheWizard1328/Shoppers)' },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null);
  const ts = j?.properties?.timeseries;
  if (!ts?.length) return null;
  const first = ts[0]?.data || {};
  const inst = first.instant?.details || {};
  const sym = first.next_1_hours?.summary?.symbol_code || first.next_6_hours?.summary?.symbol_code || first.next_12_hours?.summary?.symbol_code || '';
  const todayStr = edmontonToday();
  let hi = -999, lo = 999;
  for (const t of ts) {
    if (!String(t.time || '').startsWith(todayStr)) continue;
    const temp = t?.data?.instant?.details?.air_temperature;
    if (Number.isFinite(temp)) { if (temp > hi) hi = temp; if (temp < lo) lo = temp; }
  }
  if (hi === -999) { hi = inst.air_temperature; lo = inst.air_temperature; }
  const text = mapMetNoSymbol(sym);
  return {
    current: { temp: Math.round(inst.air_temperature || 0), feels: Math.round(inst.air_temperature || 0), text, icon: iconFromText(text), wind: Math.round((inst.wind_speed || 0) * 3.6) },
    daily: { high: Math.round(hi), low: Math.round(lo), precipProb: null, snowCm: 0, text },
    source: 'met.no',
  };
}
// Provider order (owner fix, Sep 28): open-meteo FIRST (fresh current temp,
// matches the driver's phone), met.no SECOND (live observation model), wttr.in
// LAST — wttr.in serves cached "current" conditions that can lag hours behind
// reality (it reported 10C at 02:12 MDT when the actual temp was ~5C), so it's
// only a last-resort fallback now.
async function getWeatherForCity(lat, lon) {
  return (await fetchOpenMeteo(lat, lon)) || (await fetchMetNo(lat, lon)) || (await fetchWttr(lat, lon));
}

// Fields that count as a "real change" (source flapping alone is not a change)
const COMPARE_FIELDS = ['temp', 'feels', 'text', 'icon', 'high', 'low', 'precipProb', 'snowCm'];

function buildCityEntry(city, w) {
  return {
    city_id: city.id,
    city_name: city.name || null,
    temp: w.current.temp,
    feels: w.current.feels,
    text: w.current.text,
    icon: w.current.icon || iconFromText(w.current.text),
    high: w.daily.high,
    low: w.daily.low,
    precipProb: w.daily.precipProb,
    snowCm: w.daily.snowCm,
    wind: w.current.wind,
    forecast: w.daily.text,
    source: w.source,
  };
}

async function handlePoll(base44, params) {
  const startedAt = Date.now();
  const dryRun = !!params?.dry_run;
  const clientRefresh = !!params?.client_refresh;
  const forceRefresh = !!params?.force_refresh;

  // 0. Stored snapshot — read EARLY: staleness guard + (on client-triggered
  //    refresh) the union of previously stored cities so the bar can refresh
  //    even when nobody is currently on duty.
  const settings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: SETTINGS_KEY }).catch(() => []);
  const rec = settings?.[0] || null;
  const prevCities = (rec?.setting_value?.cities) || {};
  const fetchedAtRaw = rec?.setting_value?.fetched_at;
  const storedAgeMs = fetchedAtRaw ? Date.now() - new Date(fetchedAtRaw).getTime() : Infinity;

  // Freshness guard: if the stored snapshot is younger than 4 minutes, skip.
  // The */5 workflow and simultaneous app loads from many devices all funnel
  // through here — this makes extra invocations cheap no-ops instead of
  // hammering the weather providers.
  if (!dryRun && !forceRefresh && Number.isFinite(storedAgeMs) && storedAgeMs < 4 * 60 * 1000 && Object.keys(prevCities).length > 0) {
    return { success: true, changed: false, skipped_reason: 'fresh', age_ms: Math.round(storedAgeMs), duration_ms: Date.now() - startedAt };
  }

  // 1. ALL cities (owner request, Sep 28): the bar must update every 5 minutes
  // even when NO driver is on duty. The City set is tiny (3 cities), so every
  // poll fetches every city with usable coords — no on-duty-driver query at
  // all. Previously the poll skipped entirely with no drivers on duty, and
  // client_refresh only patched it up on app loads with stale data, which made
  // updates irregular (the stale-on-load trigger + 5-min read interval raced
  // the 4-min freshness guard, so real polls could land 10+ minutes apart).
  const cities = await base44.asServiceRole.entities.City.list('name', 500).catch(() => []);
  const activeCityIds = new Set((cities || []).map((c) => c?.id).filter(Boolean));
  if (clientRefresh) Object.keys(prevCities).forEach((id) => activeCityIds.add(id));

  if (activeCityIds.size === 0) {
    return { success: true, dry_run: dryRun, active_cities: 0, changed: false, skipped_reason: 'no cities configured', duration_ms: Date.now() - startedAt };
  }

  // 2. City coords
  const usableCities = (cities || []).filter((c) => Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude)));

  // 3. Fetch + diff
  const newCities = {};
  let changed = false;
  const failures = [];
  for (const c of usableCities) {
    const w = await getWeatherForCity(c.latitude, c.longitude);
    if (!w) { failures.push(c.name || c.id); continue; }
    const entry = buildCityEntry(c, w);
    const prev = prevCities[c.id] || null;
    const isChanged = !prev || COMPARE_FIELDS.some((f) => entry[f] !== prev[f]);
    if (isChanged) changed = true;
    newCities[c.id] = entry;
  }

  // Weather unchanged → still touch the record's fetched_at (merged cities,
  // never dropping a city just because its fetch failed) so the freshness
  // guard and the client staleness checks know the data was JUST verified.
  // Without this, unchanged weather would leave fetched_at stale forever and
  // every app load would re-poll the weather providers.
  if (!changed) {
    const merged = { ...prevCities, ...newCities };
    if (!dryRun && Object.keys(merged).length > 0) {
      const touch = { cities: merged, fetched_at: new Date().toISOString() };
      if (rec?.id) {
        await base44.asServiceRole.entities.AppSettings.update(rec.id, { setting_value: touch }).catch(() => {});
      } else {
        await base44.asServiceRole.entities.AppSettings.create({ setting_key: SETTINGS_KEY, setting_value: touch }).catch(() => {});
      }
    }
    return { success: true, dry_run: dryRun, active_cities: Object.keys(newCities).length || usableCities.length, changed: false, touched: !dryRun, weather_failures: failures, duration_ms: Date.now() - startedAt };
  }

  const payload = {
    cities: newCities,
    fetched_at: new Date().toISOString(),
  };

  if (dryRun) {
    return { success: true, dry_run: true, changed: true, would_write: payload, weather_failures: failures, duration_ms: Date.now() - startedAt };
  }

  payload.cities = { ...prevCities, ...newCities };

  if (rec?.id) {
    await base44.asServiceRole.entities.AppSettings.update(rec.id, { setting_value: payload, description: 'Dashboard weather thermometer bar — per-city current/high/low, refreshed every 5 min for all cities' });
  } else {
    await base44.asServiceRole.entities.AppSettings.create({
      setting_key: SETTINGS_KEY,
      setting_value: payload,
      description: 'Dashboard weather thermometer bar — per-city current/high/low, refreshed every 5 min for all cities',
    });
  }

  return {
    success: true,
    dry_run: dryRun,
    changed: true,
    broadcast: true,
    active_cities: Object.keys(newCities).length,
    weather_failures: failures,
    duration_ms: Date.now() - startedAt,
  };
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const params = await req.json().catch(() => ({}));
  return Response.json(await handlePoll(base44, params));
});
