import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    // patient_id = the entity id selected from the lookup step
    const { patient_id, phone, email, save_email } = body;

    if (!patient_id || !phone) {
      return Response.json({ error: 'Patient ID and phone are required' }, { status: 400 });
    }

    const normalizePhone = (p) => (p || '').replace(/\D/g, '');
    const inputPhone = normalizePhone(phone);
    const inputEmail = (email || '').trim().toLowerCase();

    // Fetch the specific patient by id
    const match = await base44.asServiceRole.entities.Patient.get(patient_id);

    if (!match || match.status !== 'active') {
      return Response.json({ error: 'Patient not found.' }, { status: 404 });
    }

    // Verify phone still matches (security check)
    const phoneMatch =
      normalizePhone(match.phone) === inputPhone ||
      normalizePhone(match.phone_secondary) === inputPhone;

    if (!phoneMatch) {
      return Response.json({ error: 'Phone number does not match our records.' }, { status: 401 });
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

    // Build update payload: always stamp last_login_date and increment login count
    // Also save email if this is their first login and one was provided
    const updatePayload = {
      last_login_date: new Date().toISOString(),
      portal_login_count: (match.portal_login_count || 0) + 1,
    };
    if (inputEmail && !hasEmail) {
      updatePayload.email = email.trim();
    }

    // Update patient record asynchronously
    base44.asServiceRole.entities.Patient.update(match.id, updatePayload).catch(() => {});

    // Use the newly provided email if this was a first-login email save
    const resolvedEmail = (!hasEmail && inputEmail) ? inputEmail : (match.email || null);

    return Response.json({
      success: true,
      is_first_login: !hasEmail,
      patient: {
        id: match.id,
        full_name: match.full_name,
        phone: match.phone,
        email: resolvedEmail,
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