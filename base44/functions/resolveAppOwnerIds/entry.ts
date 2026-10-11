import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PINNED_OWNER_PLATFORM_USER_ID = '68570f3cd01bfa2d2408a9d7';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const result = await base44.asServiceRole.entities.User.list({ limit: 500 });
    const users = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : []);
    let owners = users
      .filter((user) => user?.role === 'admin' && user?.id)
      .map((user) => ({ id: user.id, full_name: user.full_name || null }));

    // Base44 can return an empty built-in User list to app backend functions.
    // Use RxDeliver's established pinned platform owner only after validating
    // that the corresponding active AppUser still exists in this app.
    if (owners.length === 0) {
      const appUsers = await base44.asServiceRole.entities.AppUser.filter({
        user_id: PINNED_OWNER_PLATFORM_USER_ID,
        status: 'active',
      }).catch(() => []);
      if (Array.isArray(appUsers) && appUsers.length > 0) {
        owners = [{ id: PINNED_OWNER_PLATFORM_USER_ID, full_name: appUsers[0]?.user_name || null }];
      }
    }

    return Response.json({ owner_ids: owners.map((owner) => owner.id), owners });
  } catch (error) {
    return Response.json({ error: error?.message || 'Failed to resolve app owner' }, { status: 500 });
  }
});
