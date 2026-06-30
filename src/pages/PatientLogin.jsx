import React, { useState, useEffect } from 'react';
import { Loader2, Phone, User, HeartPulse, CheckCircle, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { verifyPatient } from '@/functions/verifyPatient';
import { PatientSessionManager } from '@/components/patient-portal/PatientSessionManager';

export default function PatientLogin() {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Step: 'login' | 'email_required' | 'collect_email'
  // email_required = returning patient with email on file needs to enter it
  // collect_email  = first-time patient, needs to set their email
  const [step, setStep] = useState('login');
  const [pendingPatient, setPendingPatient] = useState(null);

  // If already logged in, redirect immediately
  useEffect(() => {
    if (PatientSessionManager.isValid()) {
      window.location.href = '/patient-portal';
    }
  }, []);

  // Step 1: verify name + phone (and email if returning patient)
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const payload = { full_name: fullName.trim(), phone: phone.trim() };
      if (step === 'email_required') {
        payload.email = email.trim();
      }

      const res = await verifyPatient(payload);
      const data = res.data;

      if (data?.success && data?.patient) {
        // First-time login — ask them to set an email before entering
        if (data.is_first_login) {
          setPendingPatient(data.patient);
          setStep('collect_email');
          setLoading(false);
          return;
        }
        // Successful returning login
        PatientSessionManager.login(data.patient);
        setSuccess(true);
        setTimeout(() => { window.location.href = '/patient-portal'; }, 1200);
      } else if (data?.requires_email && step !== 'email_required') {
        // Patient has email on file — prompt for it
        setStep('email_required');
        setError('');
      } else {
        setError(data?.error || 'Verification failed. Please try again.');
      }
    } catch (err) {
      const msg = err?.response?.data?.error || 'No matching patient found. Please check your details.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Step 2 (collect_email): save email and complete login
  const handleSaveEmail = async (e) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('Please enter a valid email address.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      // Re-call verifyPatient with save_email flag so backend persists the email
      await verifyPatient({
        full_name: pendingPatient.full_name,
        phone: pendingPatient.phone,
        email: email.trim(),
        save_email: true,
      });
      // Log them in with the updated patient (merge email in)
      PatientSessionManager.login({ ...pendingPatient, email: email.trim() });
      setSuccess(true);
      setTimeout(() => { window.location.href = '/patient-portal'; }, 1200);
    } catch (err) {
      setError('Could not save your email. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const isEmailStep = step === 'collect_email';
  const needsEmailLogin = step === 'email_required';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo / Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-slate-900 mb-4">
            <HeartPulse className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Patient Portal</h1>
          <p className="text-slate-500 mt-1 text-sm">Track your pharmacy deliveries</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">

          {/* ── Collect email (first login) ── */}
          {isEmailStep ? (
            <>
              <div className="flex items-center gap-3 mb-4 p-3 rounded-lg bg-blue-50 border border-blue-200">
                <Mail className="w-5 h-5 text-blue-600 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-blue-800">Welcome, {pendingPatient?.full_name}!</p>
                  <p className="text-xs text-blue-600 mt-0.5">Please add an email address. Future logins will require it.</p>
                </div>
              </div>

              {success && (
                <div className="mb-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  Email saved! Loading your portal...
                </div>
              )}

              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSaveEmail} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email Address</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10 h-12"
                      required
                      autoFocus
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  className="w-full h-12 font-medium bg-slate-900 hover:bg-slate-800 text-white"
                  disabled={loading || success}
                >
                  {loading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</>
                  ) : (
                    'Save & Continue'
                  )}
                </Button>
              </form>
            </>
          ) : (
            /* ── Standard login (phone only, or phone + email) ── */
            <>
              <h2 className="text-lg font-semibold text-slate-800 mb-1">Sign in to your portal</h2>
              <p className="text-sm text-slate-500 mb-6">
                {needsEmailLogin
                  ? 'Please enter your email address along with your phone number.'
                  : 'Enter the name and phone number on file with your pharmacy.'}
              </p>

              {success && (
                <div className="mb-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  Verified! Loading your portal...
                </div>
              )}

              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                {!needsEmailLogin && (
                  <div className="space-y-2">
                    <Label htmlFor="fullName">Full Name</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        id="fullName"
                        type="text"
                        placeholder="As it appears on your prescriptions"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        className="pl-10 h-12"
                        required
                        autoFocus
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      id="phone"
                      type="tel"
                      placeholder="e.g. 780-555-1234"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="pl-10 h-12"
                      required
                    />
                  </div>
                </div>

                {needsEmailLogin && (
                  <div className="space-y-2">
                    <Label htmlFor="emailLogin">Email Address</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        id="emailLogin"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="pl-10 h-12"
                        required
                        autoFocus
                      />
                    </div>
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full h-12 font-medium bg-slate-900 hover:bg-slate-800 text-white"
                  disabled={loading || success}
                >
                  {loading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying...</>
                  ) : (
                    'Access My Deliveries'
                  )}
                </Button>
              </form>
            </>
          )}

          <p className="mt-6 text-center text-xs text-slate-400">
            Having trouble? Contact your pharmacy for assistance.
          </p>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          Staff?{' '}
          <a href="/login" className="text-slate-600 hover:underline font-medium">
            Staff Login →
          </a>
        </p>
      </div>
    </div>
  );
}