// getPublishedBuildInfo — reports the LIVE deployment's version.json.
//
// OWNER REPORT (Oct 31 2026): the sidebar "(+N)" builds-ahead counter read
// (+42) instead of (+1) because it was computed from a baseline stamped only
// when an owner device happened to be open on the live domain — with nobody on
// live the baseline stayed at 0. The honest source of truth is the live
// deployment's own version.json. A browser fetch is blocked by CORS (the live
// host sends no Access-Control-Allow-Origin), so the read happens server-side.
//
// Returns { buildNumber, webVersion, apkDigit, pushCount, buildId, generatedAt, fetchedAt } or
// { error } — the client falls back to its stamped baseline on any failure.

const LIVE_HOSTS = [
  'https://rxdeliver.wizardworxx.com',
  'https://www.wizardworxx.com',
];

Deno.serve(async (req) => {
  try {
    let lastError = null;
    for (const host of LIVE_HOSTS) {
      try {
        const res = await fetch(`${host}/version.json?cb=${Date.now()}`, {
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!res.ok) { lastError = `${host} -> ${res.status}`; continue; }
        const data = await res.json();
        const buildNumber = Number(data?.buildNumber);
        if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
          lastError = `${host} -> no buildNumber in version.json`;
          continue;
        }
        return Response.json({
          buildNumber,
          webVersion: Number(data?.webVersion) || 0,
          // APK digit baked into the PUBLISHED bundle (src/version.js
          // BAKED_APK_DIGIT). Owner report Nov 6 2026: the live row under the
          // preview version never rendered because this function dropped the
          // field, so every client received no digit and showed nothing.
          apkDigit: Number(data?.apkDigit) || 0,
          pushCount: Number(data?.pushCount) || 0,
          buildId: data?.buildId || null,
          generatedAt: data?.generatedAt || null,
          host,
          fetchedAt: new Date().toISOString(),
        });
      } catch (err) {
        lastError = `${host} -> ${err?.message || err}`;
      }
    }
    return Response.json({ error: lastError || 'live version.json unavailable' }, { status: 502 });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
});
