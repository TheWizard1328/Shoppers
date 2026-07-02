import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const countryCode = body.countryCode || 'CA';
    const year = body.year || new Date().getFullYear();
    const province = body.province || null; // e.g. "CA-AB" for Alberta

    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;
    const res = await fetch(url);

    if (!res.ok) {
      return Response.json({ error: `Nager.Date API returned ${res.status}` }, { status: 502 });
    }

    const data = await res.json();

    // Filter to holidays that are either national (no counties) or apply to the selected province
    const seen = new Set();
    const holidays = data
      .filter((h) => {
        const types = Array.isArray(h.types) ? h.types : [h.type];
        if (!types.includes('Public')) return false;
        // If a province is selected, keep national holidays (no counties restriction) + province-specific ones
        if (province) {
          const counties = h.counties || [];
          return counties.length === 0 || counties.includes(province);
        }
        // No province selected: national holidays only (no counties restriction)
        return !h.counties || h.counties.length === 0;
      })
      .filter((h) => {
        if (seen.has(h.date)) return false;
        seen.add(h.date);
        return true;
      })
      .map((h) => ({
        date: h.date,
        holiday_name: h.localName || h.name,
      }));

    return Response.json({ holidays });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});