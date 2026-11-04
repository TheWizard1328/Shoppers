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

    // OWNER REQUEST Nov 4 2026: the name picker must identify WHICH record it
    // is, so every match carries its store abbreviation, active/inactive state
    // and address. Inactive records are returned too (greyed in the UI): a
    // shared number often belongs to an old record, and hiding it left the
    // patient staring at two identical names.
    const [activePatients, inactivePatients] = await Promise.all([
      base44.asServiceRole.entities.Patient.filter({ status: 'active' }).catch(() => []),
      base44.asServiceRole.entities.Patient.filter({ status: 'inactive' }).catch(() => []),
    ]);

    const storeAbbrev = new Map();
    const storeName = new Map();
    try {
      const stores = await base44.asServiceRole.entities.Store.list('-created_date', 500);
      for (const st of stores || []) {
        if (!st?.id) continue;
        storeAbbrev.set(st.id, st.abbreviation || '');
        storeName.set(st.id, st.name || '');
      }
    } catch { /* names are a nicety — never fail the lookup over them */ }

    const phoneMatch = (p) =>
      normalizePhone(p.phone) === inputPhone ||
      normalizePhone(p.phone_secondary) === inputPhone;

    const shape = (p) => ({
      id: p.id,
      full_name: p.full_name,
      has_email: !!(p.email && p.email.trim()),
      status: p.status || 'active',
      store_abbreviation: storeAbbrev.get(p.store_id) || '',
      store_name: storeName.get(p.store_id) || '',
      address: p.address || '',
      unit_number: p.unit_number || '',
    });

    const matches = [
      ...(activePatients || []).filter(phoneMatch).map(shape),
      ...(inactivePatients || []).filter(phoneMatch).map(shape),
    ]
      .sort((a, b) => (a.status === b.status ? String(a.full_name).localeCompare(String(b.full_name)) : a.status === 'active' ? -1 : 1))
      .slice(0, 25);

    return Response.json({ matches });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});