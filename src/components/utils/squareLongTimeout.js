/**
 * squareLongTimeout — compatibility passthrough.
 *
 * The heavy Square function timeouts (120s) are now enforced INSIDE
 * base44Client.js, where axios.create is wrapped so every SDK instance gets a
 * request interceptor matching the function name in the URL. (Runtime mutation
 * of axios.defaults was ineffective: the SDK snapshots its instance configs at
 * createClient() time.)
 *
 * Call sites keep using invokeWithLongTimeout() so the intent stays explicit
 * if the timeout mechanism ever needs to move again.
 */
import { base44 } from '@/api/base44Client';

export const invokeWithLongTimeout = async (fnName, payload) => {
  return base44.functions.invoke(fnName, payload);
};
