import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Returns a list of active patients matching the given phone number (no auth, no login stamp).
// Used by the login page to detect duplicates before the full verifyPatient call.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { phone } = await req.json();

    if (!phone) {
      return Response.json({ error: 'Phone is required' }, { status: 400 });
    }

    const normalizePhone = (p) => (p || '').replace(/\D/g, '');
    const inputPhone = normalizePhone(phone);

    if (inputPhone.length < 7) {
      return Response.json({ matches: [] });
    }

    const patients = await base44.asServiceRole.entities.Patient.filter({ status: 'active' });

    const matches = patients
      .filter((p) =>
        normalizePhone(p.phone) === inputPhone ||
        normalizePhone(p.phone_secondary) === inputPhone
      )
      .map((p) => ({
        id: p.id,
        full_name: p.full_name,
        has_email: !!(p.email && p.email.trim()),
      }));

    return Response.json({ matches });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});