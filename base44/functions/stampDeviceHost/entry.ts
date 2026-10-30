// stampDeviceHost — records WHICH DOMAIN this device is running on.
//
// Owner report Oct 29 2026: "the logged in domain is not being saved at all to
// the device settings data" — the Devices panel showed "not recorded yet" for
// every device. Two reasons this can silently fail from the client:
//   1. UserDevice carries row-level security keyed on created_by ===
//      {{user.email}}, so a device whose record was created by a DIFFERENT
//      account (e.g. an admin registering it, or a service-role write) cannot
//      update its own row at all — the write 403s with no visible symptom.
//   2. The 5-minute up-sync only fires while the app is foregrounded, so a
//      fresh reload can look like "nothing saved" for a long time.
// This function is callable by ANY signed-in user but only ever touches the
// caller's OWN device record (user_id must equal the authenticated auth id),
// writes under the service role, and merges device_info so nothing else is lost.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const normalizeHost = (raw: unknown) => {
  const host = String(raw || '').trim().toLowerCase();
  if (!host) return '';
  return host.slice(0, 200);
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const deviceIdentifier = String(body?.deviceIdentifier || '').trim();
    const host = normalizeHost(body?.host);
    if (!deviceIdentifier) return Response.json({ error: 'Missing deviceIdentifier' }, { status: 400 });
    if (!host) return Response.json({ error: 'Missing host' }, { status: 400 });

    // Self-scoped only: the caller's auth id is the UserDevice.user_id key.
    const authId = String(user.id);
    const rows = await base44.asServiceRole.entities.UserDevice.filter({
      user_id: authId,
      device_identifier: deviceIdentifier,
    }).catch(() => []);
    const rec = Array.isArray(rows) ? rows[0] : null;
    if (!rec?.id) return Response.json({ skipped: 'device record not found' });

    const deviceInfo = rec.device_info && typeof rec.device_info === 'object' ? { ...rec.device_info } : {};
    if (deviceInfo.host === host) return Response.json({ unchanged: true, host });

    deviceInfo.host = host;
    const updated = await base44.asServiceRole.entities.UserDevice.update(rec.id, { device_info: deviceInfo });
    return Response.json({ host, device: updated });
  } catch (error) {
    return Response.json({ error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
