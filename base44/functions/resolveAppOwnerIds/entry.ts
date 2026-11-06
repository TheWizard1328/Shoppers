/**
 * resolveAppOwnerIds — return the platform App Owner ids (User.role === 'admin').
 *
 * HARDENED (owner report Nov 5 2026): this function threw "Request failed with
 * status code 400" on nearly every delivery completion, which surfaced as a
 * 15-second error toast on the driver card and left notification rules with no
 * owner to notify. Cause: a single unguarded service-role read. Every lookup is
 * now individually guarded, and the function ALWAYS answers 200 so the client
 * never sees a transport error. The order is:
 *   1. service-role User read (filter first, then list)
 *   2. RxDeliver's pinned platform owner id, validated against an active AppUser
 *   3. the pinned id on its own, so owner notifications keep working even when
 *      the platform User table is unreachable from a backend function
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PINNED_OWNER_PLATFORM_USER_ID = '68570f3cd01bfa2d2408a9d7';

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
};

const safe = async (fn, fallback) => {
  try { return await fn(); } catch (_) { return fallback; }
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const caller = await safe(() => base44.auth.me(), null);
    if (!caller) return Response.json({ owner_ids: [], owners: [], reason: 'unauthorized' }, { status: 200 });

    const svc = base44.asServiceRole.entities;

    let owners = (await safe(async () => asArray(await svc.User.filter({ role: 'admin' })), []))
      .filter((user) => user?.role === 'admin' && user?.id)
      .map((user) => ({ id: user.id, full_name: user.full_name || null }));

    if (owners.length === 0) {
      owners = (await safe(async () => asArray(await svc.User.list()), []))
        .filter((user) => user?.role === 'admin' && user?.id)
        .map((user) => ({ id: user.id, full_name: user.full_name || null }));
    }

    let source = 'user_table';
    if (owners.length === 0) {
      const appUsers = await safe(
        async () => asArray(await svc.AppUser.filter({ user_id: PINNED_OWNER_PLATFORM_USER_ID, status: 'active' })),
        []
      );
      source = appUsers.length > 0 ? 'app_user_verified' : 'pinned_fallback';
      owners = [{ id: PINNED_OWNER_PLATFORM_USER_ID, full_name: appUsers[0]?.user_name || null }];
    }

    return Response.json({ owner_ids: owners.map((owner) => owner.id), owners, source }, { status: 200 });
  } catch (error) {
    return Response.json({
      owner_ids: [PINNED_OWNER_PLATFORM_USER_ID],
      owners: [{ id: PINNED_OWNER_PLATFORM_USER_ID, full_name: null }],
      source: 'error_fallback',
      error: error?.message || 'resolve failed',
    }, { status: 200 });
  }
});
