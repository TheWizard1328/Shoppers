import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

/**
 * Returns the count of GoogleAPILog entries for today (local server time),
 * grouped by api_type. This replaces the client-side full-row fetch that
 * was pulling every GoogleAPILog row for the 24h window just to count them.
 *
 * Frontend calls this instead of GoogleAPILog.filter({timestamp:{$gte,...}}),
 * so the growing log table never gets pulled client-side for a simple count.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Build today's UTC window
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10); // yyyy-MM-dd (UTC)
    const todayStart = new Date(todayStr + 'T00:00:00.000Z').toISOString();
    const todayEnd = new Date(todayStr + 'T23:59:59.999Z').toISOString();

    // Fetch only the api_type field for today's logs — we count client-side
    // to avoid a server-side aggregation that the SDK doesn't support.
    // Limit to 5000 to cap the response size even on heavy days.
    const logs = await base44.asServiceRole.entities.GoogleAPILog.filter({
      timestamp: { $gte: todayStart, $lte: todayEnd }
    }, '-timestamp', 5000);

    // Count by api_type
    const byType: Record<string, number> = {};
    let total = 0;
    for (const log of logs || []) {
      const t = log?.api_type || 'unknown';
      byType[t] = (byType[t] || 0) + 1;
      total++;
    }

    return Response.json({
      total,
      byType,
      date: todayStr,
      truncated: (logs || []).length >= 5000,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}