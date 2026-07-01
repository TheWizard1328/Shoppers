import { base44 } from "@/api/base44Client";

export async function fetchPublicHolidays(payload) {
  return base44.functions.invoke("fetchPublicHolidays", payload);
}