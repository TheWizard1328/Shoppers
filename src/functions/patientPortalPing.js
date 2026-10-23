import { base44 } from "@/api/base44Client";

// Presence heartbeat from the Patient Portal (public backend function).
// Fire-and-forget by design — the portal never blocks its UI on presence.
export const patientPortalPing = async (data) => {
  return base44.functions.invoke("patientPortalPing", data);
};
