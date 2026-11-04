import { base44 } from '@/api/base44Client';

/**
 * Patient portal messaging conventions (owner build Nov 2 2026).
 *
 * Patients are not Base44 users, so a patient thread is stored in the normal
 * Message entity with a reserved shape:
 *
 *   conversation_id : `patient:<patientId>`   (one thread per patient)
 *   patient_id      : <patientId>             (indexed lookup field)
 *   store_id        : patient's store at send time (dispatcher scoping)
 *   patient → staff : sender_id = `patient:<patientId>`, receiver_id = ''
 *   staff → patient : sender_id = <staff userId>,      receiver_id = `patient:<patientId>`
 *
 * `read` means "the recipient has not read it yet", exactly like 1:1 staff chat.
 */

export const PATIENT_SENDER_PREFIX = 'patient:';

export const patientConversationId = (patientId) => `patient:${patientId}`;

/** A conversation id that belongs to a patient thread, not staff chat. */
export const isPatientThreadConversationId = (conversationId) => {
  const id = String(conversationId || '');
  return id.startsWith('patient:') || id.startsWith('driver:');
};
export const driverThreadConversationId = (driverId, patientId) => `driver:${driverId}:patient:${patientId}`;
export const isDriverThread = (message) => !!message?.driver_id;
export const patientSenderId = (patientId) => `${PATIENT_SENDER_PREFIX}${patientId}`;
export const isPatientSender = (senderId) => String(senderId || '').startsWith(PATIENT_SENDER_PREFIX);
export const patientIdFromSender = (senderId) => String(senderId || '').slice(PATIENT_SENDER_PREFIX.length);

/** Store ids the staff member can see. Empty array = all stores (owner/admin). */
export function staffStoreIds(user) {
  const ids = [];
  if (Array.isArray(user?.store_ids)) ids.push(...user.store_ids.filter(Boolean));
  if (user?.store_id) ids.push(user.store_id);
  return Array.from(new Set(ids));
}

export function staffSeesAllStores(user) {
  const roles = Array.isArray(user?.app_roles) ? user.app_roles : [];
  return roles.includes('admin') || roles.includes('app_owner') || user?.role === 'admin';
}

/**
 * Recent patient-thread messages visible to this staff member (newest first).
 * Scoped by store_id so a dispatcher never pulls another store's patient chat.
 */
export async function loadPatientThreadMessages(user, limit = 300) {
  const storeIds = staffStoreIds(user);
  try {
    if (storeIds.length === 0 || staffSeesAllStores(user)) {
      const all = await base44.entities.Message.filter({}, '-created_date', limit);
      return (all || []).filter((m) => m?.patient_id);
    }
    const batches = await Promise.all(
      storeIds.map((storeId) =>
        base44.entities.Message.filter({ store_id: storeId }, '-created_date', limit).catch(() => [])
      )
    );
    return batches.flat().filter((m) => m?.patient_id);
  } catch {
    return [];
  }
}

/** Send a staff message to a patient thread and push it to their devices. */
export async function sendStaffMessageToPatient({ user, patient, content, storeName }) {
  const text = String(content || '').trim();
  if (!text || !patient?.id) return null;

  const message = await base44.entities.Message.create({
    sender_id: user?.id || '',
    sender_name: user?.full_name || user?.user_name || 'Pharmacy',
    receiver_id: patientSenderId(patient.id),
    receiver_name: patient.full_name || 'Patient',
    conversation_id: patientConversationId(patient.id),
    content: text,
    message_type: 'text',
    read: false,
    patient_id: patient.id,
    store_id: patient.store_id || '',
  });

  // Push to every device the patient registered (best effort — the in-app
  // thread still gets the message if the patient has no devices).
  base44.functions.invoke('patientPush', {
    action: 'send',
    patient_id: patient.id,
    title: storeName || 'Your pharmacy',
    body: text.length > 140 ? `${text.slice(0, 137)}...` : text,
    url: '/patient-portal',
    tag: `patient-msg-${patient.id}`,
  }).catch(() => {});

  return message;
}

/**
 * DRIVER SIDE (owner request Nov 2 2026)
 *
 * A driver sees only the patient threads they are part of: messages carrying
 * their own driver_id. Patients they have delivered to can start a new thread
 * with them, so the "messageable" list is the patients on their deliveries.
 */
export async function loadDriverPatientThreads(user, limit = 300) {
  const authId = user?.user_id || user?.id; // Delivery/Message.driver_id = AUTH user id
  if (!authId) return [];
  try {
    const rows = await base44.entities.Message.filter({ driver_id: authId }, '-created_date', limit);
    return rows || [];
  } catch {
    return [];
  }
}

/** Driver → patient reply: writes the driver thread row and pushes to the patient. */
export async function sendDriverMessageToPatient({ user, patient, content, storeName }) {
  const text = String(content || '').trim();
  if (!text || !patient?.id || !user?.id) return null;

  const authId = user.user_id || user.id;
  const message = await base44.entities.Message.create({
    sender_id: authId,
    sender_name: user.full_name || user.user_name || 'Driver',
    receiver_id: patientSenderId(patient.id),
    receiver_name: patient.full_name || 'Patient',
    conversation_id: driverThreadConversationId(authId, patient.id),
    content: text,
    message_type: 'text',
    read: false,
    patient_id: patient.id,
    store_id: patient.store_id || '',
    driver_id: authId,
  });

  base44.functions.invoke('patientPush', {
    action: 'send',
    patient_id: patient.id,
    title: user.full_name || storeName || 'Your driver',
    body: text.length > 140 ? `${text.slice(0, 137)}...` : text,
    url: '/patient-portal',
    tag: `driver-thread-${patient.id}`,
  }).catch(() => {});

  return message;
}

/**
 * STAFF reply inside a patient↔driver thread (owner report Nov 3 2026).
 * The row belongs to that DRIVER's thread so the patient's portal separates it
 * from the pharmacy thread, the driver receives the push, and the patient gets
 * their own device alert.
 */
export async function sendStaffMessageToDriverThread({ user, patient, driverId, driverName, content, storeName }) {
  const text = String(content || '').trim();
  if (!text || !patient?.id || !driverId) return null;
  const staffName = user?.full_name || user?.user_name || 'Pharmacy';

  const message = await base44.entities.Message.create({
    sender_id: user?.id || '',
    sender_name: staffName,
    receiver_id: patientSenderId(patient.id),
    receiver_name: patient.full_name || 'Patient',
    conversation_id: driverThreadConversationId(driverId, patient.id),
    content: text,
    message_type: 'text',
    read: false,
    patient_id: patient.id,
    store_id: patient.store_id || '',
    driver_id: driverId,
  });

  // patientThreadMsg writes the row again under its own control and pushes BOTH
  // sides in one call; the local row above is only the fallback copy.
  try {
    const res = await base44.functions.invoke('patientThreadMsg', {
      action: 'staffSend',
      patient_id: patient.id,
      driver_id: driverId,
      content: text,
    });
    const sent = res?.data?.message || res?.message || null;
    if (sent?.id) return sent;
  } catch { /* fall through: guaranteed alerts below */ }

  const preview = text.length > 140 ? `${text.slice(0, 137)}...` : text;
  base44.functions.invoke('patientPush', {
    action: 'send',
    patient_id: patient.id,
    title: driverName ? `${staffName} · ${driverName}` : staffName,
    body: preview,
    url: '/patient-portal',
    tag: `driver-thread-${patient.id}`,
  }).catch(() => {});

  return message;
}

/**
 * PATIENT → DRIVER thread write (owner report Nov 3 2026). patientPush resolves
 * drivers by a different id than Delivery.driver_id carries and cannot be
 * redeployed, so driver-thread writes go through patientThreadMsg. Falls back to
 * patientPush only if that call fails outright.
 */
export async function sendPatientMessageToDriver({ patientId, driverId, content }) {
  const text = String(content || '').trim();
  if (!patientId || !driverId || !text) return null;
  // patientThreadMsg is the ONLY writer for a driver thread. The old
  // patientPush fallback resolved the driver by AppUser.id, missed every time,
  // and dropped the patient's message into the pharmacy thread instead — so a
  // refusal is now surfaced to the patient rather than silently misrouted.
  const res = await base44.functions.invoke('patientThreadMsg', {
    action: 'send', patient_id: patientId, driver_id: driverId, content: text,
  }).catch((err) => ({ data: { error: err?.message || 'send_failed' } }));
  const data = res?.data || res || {};
  const created = data.message || res?.message || null;
  if (created?.id) return created;
  throw new Error(data.error || 'send_failed');
}

/** Read receipt for one driver thread. */
export async function markDriverThreadRead({ patientId, driverId }) {
  if (!patientId || !driverId) return;
  try {
    await base44.functions.invoke('patientThreadMsg', {
      action: 'markRead', patient_id: patientId, driver_id: driverId,
    });
    return;
  } catch { /* fall back */ }
  await base44.functions.invoke('patientPush', {
    action: 'patientMarkRead', patient_id: patientId, driver_id: driverId,
  }).catch(() => {});
}

const ACTIVE_DELIVERY_STATUSES = ['in_transit', 'en_route', 'arrived', 'out_for_delivery'];

/**
 * Duty status for a set of driver ids (patient-facing status chips).
 *
 * The server copy of driver_status can lag or be missing (the profile row is
 * resolved by auth user id), so the portal also treats "this driver is carrying
 * a live delivery to you right now" as ON DUTY — the same thing the map shows
 * as a green marker. The server's on_break always wins.
 */
export async function loadDriverDirectory(patientId) {
  if (!patientId) return { drivers: [], today: '' };
  try {
    let data = null;
    try {
      const res = await base44.functions.invoke('patientThreadMsg', { action: 'directory', patient_id: patientId });
      data = res?.data || res || null;
    } catch { data = null; }
    if (!data?.drivers) {
      const res = await base44.functions.invoke('patientPush', { action: 'driverDirectory', patient_id: patientId });
      data = res?.data || res || {};
    }
    const drivers = data.drivers || [];
    const today = data.today || '';

    if (drivers.some((d) => d && d.duty_status !== 'on_duty' && d.duty_status !== 'on_break')) {
      const rows = await base44.entities.Delivery
        .filter({ patient_id: patientId, delivery_date: today }, '-delivery_date', 20)
        .catch(() => []);
      const liveDriverIds = new Set(
        (rows || [])
          .filter((d) => d?.driver_id && ACTIVE_DELIVERY_STATUSES.includes(String(d.status)))
          .map((d) => String(d.driver_id))
      );
      drivers.forEach((d) => {
        if (d && liveDriverIds.has(String(d.driver_id)) && d.duty_status !== 'on_break') {
          d.duty_status = 'on_duty';
        }
      });
    }

    return { drivers, today };
  } catch {
    return { drivers: [], today: '' };
  }
}

/**
 * FULL directory search (owner request Nov 3 2026).
 *
 * The old directory only listed drivers who had already delivered to this
 * patient, so a search found nobody else. This asks patientThreadMsg for the
 * whole AppUser driver list (active drivers when there is no query, name
 * matches otherwise) plus every store, with the patient's own pharmacy first.
 */
export async function searchPatientDirectory({ patientId, query = '' }) {
  if (!patientId) return { drivers: [], stores: [] };
  try {
    const res = await base44.functions.invoke('patientThreadMsg', {
      action: 'searchDirectory',
      patient_id: patientId,
      query,
    });
    const data = res?.data || res || {};
    return { drivers: data.drivers || [], stores: data.stores || [] };
  } catch {
    return { drivers: [], stores: [] };
  }
}

/** Patient writes into ONE pharmacy's thread (only that store's staff is pushed). */
export async function sendPatientMessageToStore({ patientId, storeId, content }) {
  const text = String(content || '').trim();
  if (!patientId || !storeId || !text) return null;
  const res = await base44.functions.invoke('patientThreadMsg', {
    action: 'sendStore', patient_id: patientId, store_id: storeId, content: text,
  });
  const created = res?.data?.message || res?.message || null;
  if (!created?.id) throw new Error(res?.data?.error || 'send_failed');
  return created;
}

/** Read receipt for one pharmacy thread. */
export async function markStoreThreadRead({ patientId, storeId }) {
  if (!patientId || !storeId) return;
  try {
    await base44.functions.invoke('patientThreadMsg', {
      action: 'markStoreRead', patient_id: patientId, store_id: storeId,
    });
  } catch { /* optional */ }
}

/**
 * Patient deletes ONE message from one of their threads (owner request Nov 4
 * 2026). The portal has no session, so the write runs in patientThreadMsg with
 * the service role after it proves the row carries this patient_id.
 */
export async function deletePatientMessage({ patientId, messageId }) {
  if (!patientId || !messageId) throw new Error('missing_ids');
  const res = await base44.functions.invoke('patientThreadMsg', {
    action: 'deleteMessage',
    patient_id: patientId,
    message_id: messageId,
  });
  const body = res?.data || res || {};
  if (body?.ok === false) throw new Error(body?.error || 'delete_failed');
  return true;
}

/**
 * Patient deletes a WHOLE thread — pass driverId for the 1:1 driver thread, or
 * nothing for the shared pharmacy thread. Only rows carrying this patient_id
 * are ever touched.
 */
export async function deletePatientThread({ patientId, driverId = '', storeId = '' }) {
  if (!patientId) throw new Error('missing_ids');
  const res = await base44.functions.invoke('patientThreadMsg', {
    action: 'deleteThread',
    patient_id: patientId,
    driver_id: driverId || '',
    store_id: storeId || '',
  });
  const body = res?.data || res || {};
  if (body?.ok === false) throw new Error(body?.error || 'delete_failed');
  return Number(body?.deleted || 0);
}
