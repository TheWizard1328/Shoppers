/**
 * recordIdUtils.js — Base44/MongoDB record-ID validation.
 *
 * WHY (owner report Oct 19 2026): a delivery carried a locally-minted
 * `temp_patient_*` id in patient_id, and every Patient.filter({ id: { $in } })
 * batch containing it 400'd server-side ("Invalid query: id is not a valid
 * record ID") — killing the whole sync batch (Pull to Sync, RequestQueue,
 * priority boot sync) on EVERY device that touched the route. An $in query is
 * all-or-nothing: one junk id fails the entire batch of up to 50 valid ids.
 *
 * Rule: entity record ids are 24-char hex ObjectIds. Anything else
 * (temp_*, empty strings, null, truncated ids) must NEVER reach the API —
 * filter it out before querying, and repair the data at the source.
 */

const VALID_RECORD_ID_RE = /^[0-9a-fA-F]{24}$/;

/** True when the value is a valid 24-hex record id (string-safe). */
export const isValidRecordId = (value) =>
  typeof value === 'string' && VALID_RECORD_ID_RE.test(value);

/**
 * Filter an id list down to valid record ids, dropping duplicates.
 * Logs the dropped values (rate-limited by the remote logger's dedup) so
 * corrupt sources are still traceable without spamming.
 */
export const toValidRecordIds = (ids = []) => {
  const seen = new Set();
  const valid = [];
  const dropped = [];
  for (const id of ids || []) {
    if (typeof id === 'string' && VALID_RECORD_ID_RE.test(id)) {
      if (!seen.has(id)) { seen.add(id); valid.push(id); }
    } else if (id != null && id !== '') {
      dropped.push(String(id));
    }
  }
  if (dropped.length > 0) {
    console.warn(`[RecordId] ${dropped.length} invalid record id(s) skipped before query: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? ` (+${dropped.length - 5} more)` : ''}`);
  }
  return valid;
};
