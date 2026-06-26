/**
 * PatientSessionManager
 * Manages the lightweight session for the Patient Portal.
 * Session is stored in sessionStorage (cleared on tab close automatically).
 * Auto-logout: 1 hour after a successful delivery or return event.
 */

const SESSION_KEY = 'rxdeliver_patient_session';

export const PatientSessionManager = {
  /**
   * Save patient session after successful login.
   * No expiration set at login — expiration is only set after delivery/return.
   */
  login(patient) {
    const session = {
      patient,
      loggedInAt: Date.now(),
      expiresAt: null, // set later via startExpirationTimer
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  },

  /**
   * Call this when a delivery is marked as completed OR when the patient
   * clicks the "Return" / "Go Back" button after viewing a delivery.
   * Starts the 1-hour countdown from NOW.
   */
  startExpirationTimer() {
    const session = this.getSession();
    if (!session) return;
    session.expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour from now
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  },

  /**
   * Returns the full session object or null if not logged in.
   */
  getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
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
   * Returns true if a session exists and has not expired.
   */
  isValid() {
    const session = this.getSession();
    if (!session) return false;
    // If expiresAt is set, check if it has passed
    if (session.expiresAt && Date.now() > session.expiresAt) {
      this.logout();
      return false;
    }
    return true;
  },

  /**
   * Clear the session and redirect to patient login.
   */
  logout() {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = '/patient-login';
  },
};