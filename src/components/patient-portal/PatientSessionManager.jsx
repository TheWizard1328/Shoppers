/**
 * PatientSessionManager
 * Manages the lightweight session for the Patient Portal.
 * Session is stored in localStorage — persists across app restarts (PWA/APK/browser).
 * No automatic expiration — patient stays logged in until explicit logout.
 * The patient only sees their own delivery data, so persistent storage is safe.
 */

const SESSION_KEY = 'rxdeliver_patient_session';

export const PatientSessionManager = {
  /**
   * Save patient session after successful login.
   * Stored in localStorage so it survives tab close / app kill / PWA restart.
   */
  login(patient) {
    const session = {
      patient,
      loggedInAt: Date.now(),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  },

  /**
   * Refresh the session data (e.g. when patient info is updated).
   * Preserves the original loggedInAt timestamp.
   */
  refreshSession(patient) {
    const existing = this.getSession();
    const session = {
      patient,
      loggedInAt: existing?.loggedInAt || Date.now(),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  },

  /**
   * Returns the full session object or null if not logged in.
   */
  getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  /**
   * Returns the patient object or null.
   */
  getPatient() {
    return this.getSession()?.patient || null;
  },

  /**
   * Returns true if a session exists.
   * No expiration check — session persists until explicit logout.
   */
  isValid() {
    return !!this.getSession();
  },

  /**
   * Clear the session and redirect to patient login.
   */
  logout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = '/patient-login';
  },

  /**
   * No-op — kept for backward compatibility with existing callers.
   * Previously started a 1-hour expiration timer; now sessions persist indefinitely.
   */
  startExpirationTimer() {
    // Intentionally empty — sessions persist until explicit logout.
  },
};
