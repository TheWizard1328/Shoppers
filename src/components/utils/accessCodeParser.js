/**
 * Access Code parser (owner spec, Oct 23 2026)
 *
 * Drivers get door/elevator/gate/lock codes inside PATIENT NOTES ONLY — never
 * driver notes, unit numbers, or buzzer numbers (buzzer already surfaces on
 * stop cards). This parser scans a patient's notes text and extracts
 * access-code style entries so the AccessCodeDialog can pop them on arrival.
 *
 * Examples:
 *   "Gate#9356"          -> { label: 'Gate Code',      code: '9356' }
 *   "Elevator Code: 4416"-> { label: 'Elevator Code',   code: '4416' }
 *   "door code is 55"    -> { label: 'Door Code',      code: '55' }
 *   "lockbox 1234"       -> { label: 'Lockbox Code',   code: '1234' }
 *
 * Label rule (owner): use the EXACT wording from the notes when the notes spell
 * out "code" (e.g. "Elevator Code"); otherwise append "Code" to the keyword
 * ("Gate#9356" -> "Gate Code").
 */

const CODE_KEYWORDS = ['gate', 'elevator', 'door', 'lock', 'lockbox', 'entry', 'garage'];

// keyword (optionally followed by the word "code"), optional separator
// (# : - = "is"), then the code itself (2-8 digits, optional trailing letter).
const ACCESS_CODE_PATTERN = new RegExp(
  `\\b(${CODE_KEYWORDS.join('|')})\\s*(?:box)?\\s*(code)?\\s*(?:is|:|#|-|=|–)?\\s*([0-9]{2,8}[a-zA-Z]?)`,
  'i'
);

/**
 * Parse the first access-code entry from a notes string.
 * Returns null when no code-style entry is found.
 */
export const parseAccessCode = (notesText) => {
  if (!notesText || typeof notesText !== 'string') return null;
  const match = notesText.match(ACCESS_CODE_PATTERN);
  if (!match) return null;
  const keyword = match[1].trim();
  const code = match[3];
  // Owner rule: the header mirrors the notes phrasing — "Elevator Code",
  // "Gate Code", "Door Code", "Lock Code" — keyword + "Code", capitalized.
  const label = `${keyword} code`
    .toLowerCase()
    .replace(/(^|\s|-)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  return { label, code };
};

/**
 * Parse ALL access-code entries from a notes string (a note can carry more
 * than one, e.g. "Elevator code 4416, door code 77"). Returns [] when none.
 */
export const parseAllAccessCodes = (notesText) => {
  if (!notesText || typeof notesText !== 'string') return [];
  const pattern = new RegExp(ACCESS_CODE_PATTERN.source, 'gi');
  const results = [];
  let match;
  while ((match = pattern.exec(notesText)) !== null) {
    const parsed = parseAccessCode(match[0]);
    if (parsed && !results.some((r) => r.code === parsed.code && r.label === parsed.label)) {
      results.push(parsed);
    }
  }
  return results;
};

export default parseAccessCode;
