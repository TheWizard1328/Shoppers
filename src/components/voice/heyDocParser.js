/**
 * Hey Doc — voice command parser (Phase 1: stop info + calls).
 *
 * Pure functions only: takes a raw transcript, returns a typed intent.
 * Matching/normalizing is deliberately lenient — delivery-truck noise,
 * accents and engine mishearings are the norm, so we match on word
 * presence rather than exact phrases.
 *
 * Phase 2 will extend this with 'optimize_route' and Phase 3 with the
 * confirm-gated stop actions (complete / fail / return).
 */

const normalize = (raw) =>
  String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Words a driver may use for the assigned pickup store
const STORE_WORDS = /^(store|pharmacy|shop|pickup|pickup store|drug store|drugstore)$/;

/**
 * @returns {{type:'none'}} nothing usable in the transcript
 * @returns {{type:'info', field:'name'|'address'|'phone'|'notes'|'all'}} stop info query
 * @returns {{type:'help'}} list available commands
 * @returns {{type:'optimize_route'}} run the silent route re-optimization
 * @returns {{type:'call_store'}} call the current delivery's pickup store
 * @returns {{type:'call_name', name:string}} call a person/store by name
 * @returns {{type:'unknown'}} speech captured but no command recognized
 */
export const parseHeyDocCommand = (rawText) => {
  let text = normalize(rawText);
  if (!text) return { type: 'none', text: rawText };
  // Strip a leading wake phrase if the engine caught it
  text = text.replace(/^(hey doc|hey talk|a doc|hey ,?doc)\s*/, '').trim();
  if (!text) return { type: 'none', text: rawText };

  // ── Help intent ───────────────────────────────────────
  // "what can I say", "what commands", "help", "what are my options"
  // Checked first: these phrases must never bleed into info/call matching.
  if (/\bhelp\b|\bwhat can (i|you) (say|do)\b|\bwhat commands?\b|\bcommands? (are )?available\b|\bwhat are my options\b|\blist (the )?commands\b/.test(text)) {
    return { type: 'help', text: rawText };
  }

  // ── Route optimization intent ───────────────────────
  // "optimize my route", "re-optimize", "replan the route", "recalculate my
  // route", "reorder my stops" — all map to the same silent re-route pass the
  // dashboard's FAB uses (source: silent_reoptimize via triggerReoptimizeRoute).
  if (/\b(?:re-?)?optimi[sz]e\b|\breplan\b|\brecalculat(?:e|ing)\b|\bre-?order\b.*\b(?:stops?|route)\b/.test(text)) {
    return { type: 'optimize_route', text: rawText };
  }

  // ── Call intents ──────────────────────────────────────────────
  // Any sentence containing "call ..." routes to dialing. "call the
  // store" (or bare "call") = current pickup store; anything else is
  // treated as a name to resolve against stores + people.
  // "phone" as a verb only counts at the start ("phone the store") — a
  // trailing "phone number" is an info query, not a dial request.
  const callMatch = text.match(/^phone\s+(?:the|my|our|a)\s+(.+)$/) || text.match(/\b(?:dial|ring)\s+(.+)$/) || text.match(/\bcall\s+(.+)$/);
  if (/\b(call|dial|ring)\b/.test(text) || /^phone\s+(?:the|my|our|a)\s/.test(text)) {
    let target = callMatch ? callMatch[1].trim() : '';
    target = target.replace(/^(the|my|our)\s+/, '').trim();
    if (!target || STORE_WORDS.test(target)) {
      return { type: 'call_store', text: rawText };
    }
    return { type: 'call_name', name: target, text: rawText };
  }

  // ── Stop info intents ─────────────────────────────────────────
  if (/\bnotes?\b|\binstructions?\b|\bcomments?\b/.test(text)) {
    return { type: 'info', field: 'notes', text: rawText };
  }
  if (/\baddress\b|\bwhere\b|\blocated?\b/.test(text)) {
    return { type: 'info', field: 'address', text: rawText };
  }
  if (/\bphone\b|\bphone number\b|\bnumber\b/.test(text)) {
    return { type: 'info', field: 'phone', text: rawText };
  }
  if (/\bname\b|\bwho\b/.test(text)) {
    return { type: 'info', field: 'name', text: rawText };
  }
  if (/\bdetails?\b|\bsummary\b|\binfo\b|\bstop\b/.test(text)) {
    return { type: 'info', field: 'all', text: rawText };
  }

  return { type: 'unknown', text: rawText };
};

/**
 * Fuzzy-score how well a candidate name matches a spoken query.
 * Returns a positive score or 0 (no match).
 * Handles partial names ("call anna", "call southpoint") and
 * first/last word swaps.
 */
export const scoreNameMatch = (candidateName, query) => {
  const name = normalize(candidateName);
  const q = normalize(query);
  if (!name || !q) return 0;

  if (name === q) return 100;
  if (name.startsWith(q) || name.endsWith(q)) return 85;
  if (name.includes(q)) return 80;

  const nameWords = name.split(' ').filter(Boolean);
  const qWords = q.split(' ').filter(Boolean);
  let score = 0;
  for (const qw of qWords) {
    for (const nw of nameWords) {
      if (nw === qw) score += 45;
      else if (nw.startsWith(qw) || qw.startsWith(nw)) score += 35;
    }
  }
  return score;
};

/**
 * Resolve a spoken name against stores and people.
 * @param {string} query spoken target, e.g. "anna" or "southpoint"
 * @param {Array} stores Store records ({name, phone})
 * @param {Array} people AppUser records ({user_name, phone, ...})
 * @returns {{kind:'store'|'person', record, score, ambiguousWith?}}
 */
export const resolveCallTarget = (query, stores = [], people = []) => {
  const candidates = [];
  for (const s of stores) {
    if (!s?.name || !s?.phone) continue;
    const score = scoreNameMatch(s.name, query);
    if (score > 0) candidates.push({ kind: 'store', record: s, score });
  }
  for (const p of people) {
    if (!p?.user_name || !p?.phone) continue;
    const score = scoreNameMatch(p.user_name, query);
    if (score > 0) candidates.push({ kind: 'person', record: p, score });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const runnerUp = candidates[1];

  // Too close to call between two different contacts — ask the driver
  // to be more specific instead of risking dialing the wrong person.
  if (runnerUp && top.score - runnerUp.score < 10 && runnerUp.score >= 35) {
    return { ...top, ambiguousWith: runnerUp };
  }
  if (top.score < 30) return null;
  return top;
};
