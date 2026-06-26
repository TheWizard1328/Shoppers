import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { full_name, phone } = await req.json();

    if (!full_name || !phone) {
      return Response.json({ error: 'Name and phone are required' }, { status: 400 });
    }

    // Normalize: strip non-digits from phone for comparison
    const normalizePhone = (p) => (p || '').replace(/\D/g, '');
    const inputPhone = normalizePhone(phone);
    const inputName = full_name.trim().toLowerCase();

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

    return Response.json({
      success: true,
      patient: {
        id: match.id,
        full_name: match.full_name,
        phone: match.phone,
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