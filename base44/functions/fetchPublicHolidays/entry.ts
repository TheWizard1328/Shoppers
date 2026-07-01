import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const countryCode = body.countryCode || 'CA';
    const year = body.year || new Date().getFullYear();

    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;
    const res = await fetch(url);

    if (!res.ok) {
      return Response.json({ error: `Nager.Date API returned ${res.status}` }, { status: 502 });
    }

    const data = await res.json();

    // Filter to "Public" type only (statutory), deduplicate by date keeping the first entry
    const seen = new Set();
    const holidays = data
      .filter((h) => Array.isArray(h.types) ? h.types.includes('Public') : h.type === 'Public')
      .filter((h) => {
        if (seen.has(h.date)) return false;
        seen.add(h.date);
        return true;
      })
      .map((h) => ({
        date: h.date,
        holiday_name: h.name,
      }));

    return Response.json({ holidays });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});