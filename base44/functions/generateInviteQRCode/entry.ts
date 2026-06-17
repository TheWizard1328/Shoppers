import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { v4 as uuidv4 } from 'npm:uuid@9.0.1';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { role, store_ids, app_origin } = await req.json();

    if (!role) {
      return Response.json({ error: 'Role is required' }, { status: 400 });
    }

    // Generate unique token
    const token = uuidv4();

    // Create expiration date (30 days from now)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Create invite token record
    const inviteToken = await base44.entities.InviteToken.create({
      token,
      role,
      store_ids: store_ids || [],
      generated_by_user_id: user.id,
      generated_by_name: user.full_name || user.email,
      expires_at: expiresAt,
      status: 'active'
    });

    // Construct invite URL - use app_origin if provided (backend URL differs from frontend URL)
    const origin = app_origin || new URL(req.url).origin;
    const inviteUrl = `${origin}/register?inviteToken=${token}`;

    return Response.json({
      success: true,
      inviteUrl,
      token,
      expiresAt
    });
  } catch (error) {
    console.error('Error generating invite QR code:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});