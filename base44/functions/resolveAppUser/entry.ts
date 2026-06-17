/**
 * resolveAppUser - Shared utility backend function
 *
 * Resolves an AppUser record given an ID that may be either:
 *   - An AppUser.id (new standard)
 *   - A Platform User.id / user_id (legacy)
 *
 * Usage: invoke via base44.asServiceRole.functions.invoke('resolveAppUser', { userId })
 * Returns: { appUser } or { appUser: null }
 *
 * Also exposes resolveAppUserById() for inline use in other Deno functions
 * by copy-pasting the helper (since no local imports are allowed).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { userId } = body || {};
    if (!userId) return Response.json({ error: 'userId is required' }, { status: 400 });

    const appUser = await resolveAppUserById(base44.asServiceRole, userId);
    return Response.json({ appUser: appUser || null });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

/**
 * Resolve an AppUser record from either an AppUser.id or a Platform user_id (legacy).
 * Always returns the AppUser entity record (with .id = AppUser.id), or null.
 *
 * Copy this function into any backend function that needs it (no local imports allowed).
 */
export async function resolveAppUserById(serviceRoleApi, userId) {
  if (!userId) return null;

  // 1. Try direct AppUser.id lookup first (new standard)
  try {
    const byAppId = await serviceRoleApi.entities.AppUser.filter({ id: userId }, '-created_date', 1);
    if (byAppId?.[0]) return byAppId[0];
  } catch (_) {}

  // 2. Fallback: legacy Platform user_id lookup
  try {
    const byUserId = await serviceRoleApi.entities.AppUser.filter({ user_id: userId }, '-created_date', 1);
    if (byUserId?.[0]) return byUserId[0];
  } catch (_) {}

  return null;
}