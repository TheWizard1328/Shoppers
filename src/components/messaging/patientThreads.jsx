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

/** Patients this staff member can message (portal users first). */
export async function loadMessagablePatients(user, limit = 200) {
  const storeIds = staffStoreIds(user);
  try {
    if (storeIds.length === 0 || staffSeesAllStores(user)) {
      const rows = await base44.entities.Patient.filter({ status: 'active' }, '-last_login_date', limit);
      return rows || [];
    }
    const batches = await Promise.all(
      storeIds.map((storeId) =>
        base44.entities.Patient.filter({ store_id: storeId, status: 'active' }, '-last_login_date', limit).catch(() => [])
      )
    );
    const seen = new Set();
    return batches.flat().filter((p) => {
      if (!p?.id || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
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
  if (!user?.id) return [];
  try {
    const rows = await base44.entities.Message.filter({ driver_id: user.id }, '-created_date', limit);
    return rows || [];
  } catch {
    return [];
  }
}

export async function loadPatientsForDriver(user, limit = 300) {
  if (!user?.id) return [];
  try {
    const deliveries = await base44.entities.Delivery.filter({ driver_id: user.id }, '-delivery_date', limit);
    const ids = Array.from(new Set((deliveries || []).map((d) => d.patient_id).filter(Boolean)));
    if (ids.length === 0) return [];
    const rows = await Promise.all(
      ids.slice(0, 120).map((id) => base44.entities.Patient.get(id).catch(() => null))
    );
    const seen = new Set();
    return rows.filter((p) => {
      if (!p?.id || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  } catch {
    return [];
  }
}

/** Driver → patient reply: writes the driver thread row and pushes to the patient. */
export async function sendDriverMessageToPatient({ user, patient, content, storeName }) {
  const text = String(content || '').trim();
  if (!text || !patient?.id || !user?.id) return null;

  const message = await base44.entities.Message.create({
    sender_id: user.id,
    sender_name: user.full_name || user.user_name || 'Driver',
    receiver_id: patientSenderId(patient.id),
    receiver_name: patient.full_name || 'Patient',
    conversation_id: driverThreadConversationId(user.id, patient.id),
    content: text,
    message_type: 'text',
    read: false,
    patient_id: patient.id,
    store_id: patient.store_id || '',
    driver_id: user.id,
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

  const preview = text.length > 140 ? `${text.slice(0, 137)}...` : text;

  // Patient's devices.
  base44.functions.invoke('patientPush', {
    action: 'send',
    patient_id: patient.id,
    title: driverName ? `${staffName} · ${driverName}` : staffName,
    body: preview,
    url: '/patient-portal',
    tag: `driver-thread-${patient.id}`,
  }).catch(() => {});

  // The driver's devices.
  base44.functions.invoke('patientPush', {
    action: 'notifyDriver',
    driver_id: driverId,
    patient_id: patient.id,
    title: `${staffName} · ${patient.full_name || 'Patient'}`,
    body: preview,
    url: '/',
    tag: `driver-thread-${patient.id}`,
  }).catch(() => {});

  return message;
}

/** Duty status for a set of driver ids (patient-facing status chips). */
export async function loadDriverDirectory(patientId) {
  if (!patientId) return { drivers: [], today: '' };
  try {
    const res = await base44.functions.invoke('patientPush', { action: 'driverDirectory', patient_id: patientId });
    const data = res?.data || res || {};
    return { drivers: data.drivers || [], today: data.today || '' };
  } catch {
    return { drivers: [], today: '' };
  }
}
