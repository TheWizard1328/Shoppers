import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { full_name, phone, email, save_email } = body;

    if (!full_name || !phone) {
      return Response.json({ error: 'Name and phone are required' }, { status: 400 });
    }

    // Normalize: strip non-digits from phone for comparison
    const normalizePhone = (p) => (p || '').replace(/\D/g, '');
    const inputPhone = normalizePhone(phone);
    const inputName = full_name.trim().toLowerCase();
    const inputEmail = (email || '').trim().toLowerCase();

    // Fetch all active patients (service role — no user auth needed for portal login)
    const patients = await base44.asServiceRole.entities.Patient.filter({ status: 'active' });

    const match = patients.find((p) => {
      const nameMatch = (p.full_name || '').trim().toLowerCase() === inputName;
      const phoneMatch =
        normalizePhone(p.phone) === inputPhone ||
        normalizePhone(p.phone_secondary) === inputPhone;
      return nameMatch && phoneMatch;
    });

    if (!match) {
      return Response.json({ error: 'No matching patient found. Please check your name and phone number.' }, { status: 404 });
    }

    const hasEmail = !!(match.email && match.email.trim());

    // If patient has an email on file, require it to be provided and match
    if (hasEmail) {
      if (!inputEmail) {
        return Response.json({
          success: false,
          requires_email: true,
          error: 'Please enter your email address to continue.'
        }, { status: 401 });
      }
      if (inputEmail !== (match.email || '').trim().toLowerCase()) {
        return Response.json({ error: 'Email address does not match our records.' }, { status: 401 });
      }
    }

    // Build update payload: always stamp last_login_date and increment login count; optionally save new email
    const updatePayload = {
      last_login_date: new Date().toISOString(),
      portal_login_count: (match.portal_login_count || 0) + 1,
    };
    if (save_email && inputEmail && !hasEmail) {
      updatePayload.email = email.trim();
    }

    // Update patient record asynchronously (fire and forget — don't block login)
    base44.asServiceRole.entities.Patient.update(match.id, updatePayload).catch(() => {});

    return Response.json({
      success: true,
      is_first_login: !hasEmail,
      patient: {
        id: match.id,
        full_name: match.full_name,
        phone: match.phone,
        email: match.email || null,
        address: match.address,
        latitude: match.latitude,
        longitude: match.longitude,
        store_id: match.store_id,
        notes: match.notes,
      }
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});