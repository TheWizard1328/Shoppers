import { base44 } from "@/api/base44Client";

// OWNER FIX Nov 4 2026: the preview backend kept serving the OLD
// lookupPatientByPhone build (name + has_email only), so the login picker had
// no store badge or address to show. A brand-new function name always deploys
// fresh, so the enriched lookup lives here and the legacy name is only a
// fallback for environments that have not picked this up yet.
export const lookupPatientPhoneMatches = async (data) => {
  try {
    const res = await base44.functions.invoke("lookupPatientPhoneMatches", data);
    const matches = res?.data?.matches || [];
    if (matches.length > 0 && (matches[0].store_abbreviation !== undefined || matches[0].address !== undefined)) {
      return res;
    }
    if (matches.length > 0) {
      const legacy = await base44.functions.invoke("lookupPatientByPhone", data).catch(() => null);
      return legacy?.data?.matches?.length ? legacy : res;
    }
    return res;
  } catch {
    return base44.functions.invoke("lookupPatientByPhone", data);
  }
};
