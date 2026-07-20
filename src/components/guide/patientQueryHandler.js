/**
 * patientQueryHandler.js — Natural-language patient info lookup for GuideAssistant.
 *
 * Detects queries like:
 *   "Tell me about John Smith" / "patient info for John"
 *   "info" / "patient info" (for current/next delivery)
 *   "patient Smith" / "about Smith"
 *
 * Returns a structured response object with patient details, delivery stats,
 * recommended actions, and AI-style troubleshooting tips for no-answer scenarios.
 */

// ── Query detection ───────────────────────────────────────────────────

/**
 * Check if a user message is a patient info query.
 * Returns { type: 'named'|'current', patientName?: string } or null.
 */
export function detectPatientQuery(message) {
  if (!message) return null;
  const lower = message.toLowerCase().trim();

  // Bare "info" / "information" triggers current delivery lookup
  if (lower === 'info' || lower === 'information') {
    return { type: 'current' };
  }

  // Multi-word "current delivery" style queries
  const currentKeywords = [
    'patient info', 'patient information',
    'delivery info', 'delivery information',
    'current delivery', 'current patient',
    'who is next', 'who is the patient',
    'next patient', 'next delivery info',
  ];
  for (const kw of currentKeywords) {
    if (lower === kw || lower === `show ${kw}` || lower === `get ${kw}`) {
      return { type: 'current' };
    }
  }

  // "Tell me about X" / "info on X" / "patient info X" / "patient X" — extract a name
  // Pattern 1: prefix commands followed by a name
  const p1 = /^(?:tell me about|info(?:rmation)?(?:\s+(?:on|for|about))?|patient(?:\s+info(?:rmation)?)?(?:\s+(?:on|for|about))?|about|who is|look(?:up| up)|find)\s+(.+)$/i;
  // Pattern 2: "NAME info/information/details" (name comes FIRST)
  const p2 = /^(.+?)\s+(?:info|information|details)$/i;

  const m1 = lower.match(p1);
  if (m1 && m1[1]) {
    let name = m1[1].trim().replace(/\b(the|this|that|a|an|my)\b/g, '').trim();
    if (name.length >= 2) return { type: 'named', patientName: name };
  }
  const m2 = lower.match(p2);
  if (m2 && m2[1]) {
    let name = m2[1].trim().replace(/\b(the|this|that|a|an|my)\b/g, '').trim();
    // Exclude bare keywords that are not real names
    const notAName = ['patient', 'delivery', 'current', 'next'];
    if (name.length >= 2 && !notAName.includes(name)) {
      return { type: 'named', patientName: name };
    }
  }

  return null;
}

// ── Patient matching ──────────────────────────────────────────────────

/**
 * Find ALL patients matching a name query, sorted by relevance score.
 * Returns an array of { patient, score } objects.
 */
export function findAllPatientsByName(query, patients) {
  if (!patients || patients.length === 0) return [];
  const q = query.toLowerCase().trim();
  const results = [];

  for (const p of patients) {
    if (!p) continue;
    const fullName = (p.full_name || '').toLowerCase();
    if (!fullName) continue;

    let score = 0;
    if (fullName === q) {
      score = 100;
    } else if (fullName.includes(q)) {
      score = 80;
    } else {
      const queryWords = q.split(/\s+/).filter(w => w.length >= 2);
      const nameWords = fullName.split(/\s+/);
      let matchedWords = 0;
      for (const qw of queryWords) {
        for (const nw of nameWords) {
          if (nw.includes(qw) || qw.includes(nw)) { matchedWords++; break; }
        }
      }
      if (queryWords.length > 0 && matchedWords === queryWords.length) {
        score = 60 + matchedWords * 5;
      } else if (matchedWords > 0) {
        score = matchedWords * 15;
      }
    }
    if (score >= 15) results.push({ patient: p, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Backward-compatible single-patient lookup.
 */
export function findPatientByName(query, patients) {
  const results = findAllPatientsByName(query, patients);
  return results.length > 0 ? results[0].patient : null;
}

/**
 * Get the "current" patient — the one for the driver's next/active delivery.
 * For admins, returns the first active delivery of the day (any driver).
 */
export function findCurrentDeliveryPatient(currentUser, deliveries, patients, selectedDate) {
  if (!deliveries || deliveries.length === 0) return null;
  const today = selectedDate || new Date().toISOString().slice(0, 10);

  const roles = currentUser?.app_roles || [];
  const isAdmin = roles.includes('admin');
  const isDispatcher = roles.includes('dispatcher') && !isAdmin;

  // Build store filter for dispatchers
  let storeIds = null;
  if (isDispatcher) {
    storeIds = new Set(currentUser?.store_ids || []);
    if (storeIds.size === 0) return null;
  }

  const myDeliveries = deliveries.filter(d =>
    d && d.delivery_date === today &&
    (isAdmin || d.driver_id === currentUser?.id || (isDispatcher && storeIds.has(d.store_id))) &&
    !['completed', 'returned', 'cancelled'].includes(d.status)
  );
  if (myDeliveries.length === 0) return null;

  // For drivers, prefer isNextDelivery; for admins/dispatchers, just take the first active
  const nextDelivery =
    myDeliveries.find(d => d.isNextDelivery === true) ||
    myDeliveries.sort((a, b) => (a.stop_order || 999) - (b.stop_order || 999))[0];
  if (!nextDelivery) return null;

  const patient = patients?.find(p => p?.id === nextDelivery.patient_id || p?.patient_id === nextDelivery.patient_id);
  return patient ? { patient, delivery: nextDelivery } : null;
}

// ── Delivery stats ────────────────────────────────────────────────────

export function getPatientDeliveryStats(patientId, deliveries) {
  if (!deliveries || deliveries.length === 0) {
    return { total: 0, completed: 0, failed: 0, returned: 0, cancelled: 0, completionRate: 0 };
  }
  const patientDeliveries = deliveries.filter(d =>
    d && (d.patient_id === patientId || d.patient_id?.$oid === patientId)
  );
  const stats = { total: 0, completed: 0, failed: 0, returned: 0, cancelled: 0, completionRate: 0 };
  for (const d of patientDeliveries) {
    stats.total++;
    if (d.status === 'completed') stats.completed++;
    else if (d.status === 'returned') stats.returned++;
    else if (d.status === 'failed') stats.failed++;
    else if (d.status === 'cancelled') stats.cancelled++;
  }
  stats.completionRate = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
  return stats;
}

// ── Recommended actions ──────────────────────────────────────────────

export function getRecommendedActions(patient, delivery) {
  const recs = [];
  if (!patient) return recs;

  if (patient.call_upon_arrival) recs.push('📞 **Call upon arrival** — this patient expects a phone call when you arrive.');
  if (patient.ring_bell && !patient.dont_ring_bell) recs.push('🔔 **Ring the doorbell** on arrival.');
  if (patient.dont_ring_bell) recs.push('🚫 **Do NOT ring the doorbell** — knock or call instead.');
  if (patient.back_door) recs.push('🚪 **Use the back door** for delivery.');
  if (patient.mailbox_ok) recs.push('📫 **Mailbox drop is OK** — can leave in mailbox if no answer.');
  if (patient.notes) recs.push(`📝 **Patient notes:** ${patient.notes}`);

  const twStart = patient.time_window_start;
  const twEnd = patient.time_window_end;
  if (twStart || twEnd) {
    recs.push(`🕐 **Preferred time window:** ${twStart || 'any time'} – ${twEnd || 'any time'}`);
  }

  if (delivery) {
    if (delivery.fridge_item) recs.push('🧊 **Fridge item** — ensure cold chain is maintained. Check temperature before handoff.');
    if (delivery.oversized) recs.push('📦 **Oversized item** — may require special handling or two-person delivery.');
    if (delivery.signature_needed) recs.push('✍️ **Signature required** — capture patient signature on the app.');
    if (delivery.after_hours_pickup) recs.push('🌙 **After-hours pickup** — coordinate with the store for after-hours access.');
    if (delivery.cod_total_amount_required && delivery.cod_total_amount_required > 0) {
      recs.push(`💵 **COD required:** $${delivery.cod_total_amount_required.toFixed(2)} — collect payment before handoff.`);
    }
    if (delivery.delivery_instructions) recs.push(`📋 **Delivery instructions:** ${delivery.delivery_instructions}`);
  }

  if (patient.recurring) {
    const days = [];
    if (patient.recurring_weekly_mon) days.push('Mon');
    if (patient.recurring_weekly_tue) days.push('Tue');
    if (patient.recurring_weekly_wed) days.push('Wed');
    if (patient.recurring_weekly_thu) days.push('Thu');
    if (patient.recurring_weekly_fri) days.push('Fri');
    if (patient.recurring_weekly_sat) days.push('Sat');
    if (patient.recurring_weekly_sun) days.push('Sun');
    if (days.length > 0) recs.push(`🔄 **Recurring patient** — scheduled on ${days.join(', ')}.`);
  }

  return recs;
}

// ── No-answer troubleshooting ─────────────────────────────────────────

export function getNoAnswerAdvice(patient, delivery, store, cityAdmins) {
  const lines = [];
  lines.push("🤔 **Having trouble reaching the patient? Here's what to try:**\n");

  if (patient?.call_upon_arrival) {
    lines.push("1. **Call the patient** — they've requested a call upon arrival. Try calling now:");
  } else {
    lines.push("1. **Call the patient's phone** — try both primary and secondary numbers if available:");
  }
  if (patient?.phone) lines.push(`   📞 Primary: ${patient.phone}`);
  if (patient?.phone_secondary) lines.push(`   📞 Secondary: ${patient.phone_secondary}`);

  if (patient?.dont_ring_bell) {
    lines.push("\n2. **Knock on the door** — do NOT ring the doorbell (per patient preference). Wait 30 seconds, knock again.");
  } else if (patient?.ring_bell) {
    lines.push("\n2. **Ring the doorbell** — then knock. Wait 30 seconds and try again.");
  } else {
    lines.push("\n2. **Knock and ring** — try both knocking and ringing the doorbell. Wait 30 seconds between attempts.");
  }

  if (patient?.back_door) lines.push("\n3. **Check the back door** — this patient accepts deliveries at the back door.");

  if (patient?.mailbox_ok) {
    lines.push("\n4. **Mailbox drop is approved** — if there's no answer after 2 attempts, you can leave the delivery in the mailbox.");
    if (delivery?.fridge_item) lines.push("   ⚠️ However, this is a **fridge item** — do NOT leave in mailbox. Must be handed to the patient or returned to store.");
  }

  if (store?.phone) {
    lines.push(`\n5. **Contact the store** — call ${store.name || 'the store'} at ${store.phone}`);
    lines.push("   They may have alternate contact info or instructions for this patient.");
  } else if (store?.name) {
    lines.push(`\n5. **Contact ${store.name}** — they may have alternate contact information for this patient.`);
  }

  if (cityAdmins && cityAdmins.length > 0) {
    lines.push("\n6. **Contact a city admin** — if the patient can't be reached and the store is unavailable:");
    for (const admin of cityAdmins.slice(0, 2)) {
      const phone = admin.phone || admin.ETrans_Email || '';
      lines.push(`   👤 ${admin.user_name || 'Admin'}${phone ? ` — ${phone}` : ''}`);
    }
  } else {
    lines.push("\n6. **Contact your dispatcher or admin** — if the patient and store are both unreachable, notify your dispatcher for guidance.");
  }

  if (delivery?.fridge_item) {
    lines.push("\n7. **Do NOT leave this delivery unattended** — it's a fridge item and must maintain cold chain. If no one is available after all attempts, return it to the store.");
  } else if (!patient?.mailbox_ok) {
    lines.push("\n7. **If no one is available** after all attempts, mark the delivery as 'No Answer' and return the items to the store. Do not leave unattended unless mailbox drop is approved.");
  } else {
    lines.push("\n7. **If still no answer** after all steps, mark as 'No Answer' in the app.");
  }

  lines.push("\n_Remember: attempt at least 2 contact methods before marking as no-answer._");
  return lines.join('\n');
}

// ── Full response builder ────────────────────────────────────────────

export function buildPatientResponse({ patient, delivery, stats, store, cityAdmins, includeAdvice }) {
  if (!patient) {
    return "I couldn't find a patient matching that name. Could you double-check the spelling? You can also type **'info'** to look up the patient for your current delivery.";
  }

  const lines = [];
  lines.push(`📋 **${patient.full_name || 'Unknown Patient'}**\n`);

  const infoLines = [];
  if (patient.address) {
    let addr = patient.address;
    if (patient.unit_number) addr += `, Unit ${patient.unit_number}`;
    infoLines.push(`🏠 ${addr}`);
  }
  if (patient.phone) infoLines.push(`📞 ${patient.phone}`);
  if (patient.phone_secondary) infoLines.push(`📞 (alt) ${patient.phone_secondary}`);
  if (patient.email) infoLines.push(`✉️ ${patient.email}`);
  if (store?.name) infoLines.push(`🏪 Store: ${store.name}`);
  if (infoLines.length > 0) lines.push(infoLines.join('\n'));

  lines.push('\n**Delivery History:**');
  lines.push(`Total: ${stats.total} | ✅ Completed: ${stats.completed} | ↩️ Returned: ${stats.returned} | ❌ Failed: ${stats.failed}`);
  lines.push(`Completion rate: ${stats.completionRate}%`);

  if (delivery) {
    lines.push('\n**Current Delivery:**');
    if (delivery.status) lines.push(`Status: ${delivery.status}`);
    if (delivery.delivery_time_eta) lines.push(`ETA: ${delivery.delivery_time_eta}`);
    if (delivery.cod_total_amount_required > 0) lines.push(`COD: $${delivery.cod_total_amount_required.toFixed(2)}`);
    if (delivery.fridge_item) lines.push('🧊 Fridge item');
    if (delivery.oversized) lines.push('📦 Oversized');
    if (delivery.signature_needed) lines.push('✍️ Signature required');
  }

  const recs = getRecommendedActions(patient, delivery);
  if (recs.length > 0) {
    lines.push('\n**Recommended Actions:**');
    lines.push(recs.join('\n'));
  }

  if (includeAdvice) {
    lines.push('\n' + getNoAnswerAdvice(patient, delivery, store, cityAdmins));
  }

  return lines.join('\n');
}
