import { base44 } from "@/api/base44Client";

// Watcher query for dashboard devices (public backend function).
export const patientPortalWatchers = async (data) => {
  return base44.functions.invoke("patientPortalWatchers", data);
};
