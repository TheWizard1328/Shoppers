import { base44 } from "@/api/base44Client";

export const lookupPatientByPhone = async (data) => {
  return base44.functions.invoke("lookupPatientByPhone", data);
};