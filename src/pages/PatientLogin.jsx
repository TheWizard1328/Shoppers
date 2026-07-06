import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Phone, HeartPulse, CheckCircle, Mail, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { verifyPatient } from '@/functions/verifyPatient';
import { lookupPatientByPhone } from '@/functions/lookupPatientByPhone';
import { PatientSessionManager } from '@/components/patient-portal/PatientSessionManager';
import PWAInstallPrompt from '@/components/common/PWAInstallPrompt';

const normalizePhone = (p) => (p || '').replace(/\D/g, '');
const VALID_PHONE_LENGTH = 10;

export default function PatientLogin() {
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Phone lookup results
  const [phoneMatches, setPhoneMatches] = useState([]); // [{id, full_name, has_email}]
  const [selectedPatient, setSelectedPatient] = useState(null); // {id, full_name, has_email}
  const [showNamePicker, setShowNamePicker] = useState(false);



  const lookupTimerRef = useRef(null);

  // If already logged in, redirect immediately
  useEffect(() => {
    if (PatientSessionManager.isValid()) {
      window.location.href = '/patient-portal';
    }
  }, []);

  // Debounced phone lookup — fires when phone reaches 10 digits
  useEffect(() => {
    clearTimeout(lookupTimerRef.current);
    const digits = normalizePhone(phone);

    if (digits.length < VALID_PHONE_LENGTH) {
      setPhoneMatches([]);
      setSelectedPatient(null);
      setShowNamePicker(false);
      setError('');
      return;
    }

    lookupTimerRef.current = setTimeout(async () => {
      setLookingUp(true);
      setError('');
      try {
        const res = await lookupPatientByPhone({ phone: digits });
        const matches = res.data?.matches || [];
        setPhoneMatches(matches);
        if (matches.length === 1) {
          setSelectedPatient(matches[0]);
          setShowNamePicker(false);
        } else if (matches.length > 1) {
          setSelectedPatient(null);
          setShowNamePicker(true);
        } else {
          setSelectedPatient(null);
          setShowNamePicker(false);
          setError('No patient found with that phone number.');
        }
      } catch {
        setError('Could not look up phone number. Please try again.');
      } finally {
        setLookingUp(false);
      }
    }, 500);

    return () => clearTimeout(lookupTimerRef.current);
  }, [phone]);

  // Whether the email field should be enabled
  const phoneValid = normalizePhone(phone).length >= VALID_PHONE_LENGTH;
  const emailEnabled = phoneValid && !!selectedPatient;

  // Main login submit
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedPatient) return;
    setError('');
    setLoading(true);
    try {
      const payload = {
        patient_id: selectedPatient.id,
        phone: phone.trim(),
        email: email.trim() || undefined,
      };

      const res = await verifyPatient(payload);
      const data = res.data;

      if (data?.success && data?.patient) {
        PatientSessionManager.login({ ...data.patient, email: email.trim() || data.patient.email });
        setSuccess(true);
        setTimeout(() => { window.location.href = '/patient-portal'; }, 1200);
      } else {
        setError(data?.error || 'Verification failed. Please try again.');
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Verification failed. Please check your details.');
    } finally {
      setLoading(false);
    }
  };



  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-slate-900 mb-4">
            <HeartPulse className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Patient Portal</h1>
          <p className="text-slate-500 mt-1 text-sm">Track your pharmacy deliveries</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">

          {/* ── Main login form ── */}
          <>
              <h2 className="text-lg font-semibold text-slate-800 mb-1">Sign in to your portal</h2>
              <p className="text-sm text-slate-500 mb-6">Enter your phone number to get started.</p>

              {success && (
                <div className="mb-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  Verified! Loading your portal...
                </div>
              )}
              {error && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

              <form onSubmit={handleSubmit} className="space-y-4">

                {/* 1) Phone — always first */}
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input id="phone" type="tel" placeholder="e.g. 780-555-1234" value={phone}
                      onChange={(e) => setPhone(e.target.value)} className="pl-10 h-12" required autoFocus />
                    {lookingUp && (
                      <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 animate-spin" />
                    )}
                  </div>
                </div>

                {/* 2) Name picker — only when multiple patients share the same number */}
                {showNamePicker && phoneMatches.length > 1 && (
                  <div className="space-y-2">
                    <Label htmlFor="namePicker">Select Your Name</Label>
                    <div className="relative">
                      <select
                        id="namePicker"
                        value={selectedPatient?.id || ''}
                        onChange={(e) => {
                          const found = phoneMatches.find((m) => m.id === e.target.value);
                          setSelectedPatient(found || null);
                        }}
                        className="w-full h-12 pl-4 pr-10 rounded-md border border-input bg-background text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">— Select your name —</option>
                        {phoneMatches.map((m) => (
                          <option key={m.id} value={m.id}>{m.full_name}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                    </div>
                  </div>
                )}

                {/* Single match — show selected name as read-only confirmation */}
                {phoneMatches.length === 1 && selectedPatient && (
                  <div className="px-4 py-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
                    Found: <span className="font-semibold">{selectedPatient.full_name}</span>
                  </div>
                )}

                {/* 3) Email — replaces "Full Name"; disabled until phone valid + patient selected */}
                <div className="space-y-2">
                  <Label htmlFor="email" className={!emailEnabled ? 'text-slate-400' : ''}>
                    Email Address
                    {!emailEnabled && <span className="ml-1 text-xs font-normal">(enter phone first)</span>}
                    {emailEnabled && !selectedPatient?.has_email && <span className="ml-1 text-xs font-normal text-blue-600">(you'll set this on first login)</span>}
                  </Label>
                  <div className="relative">
                    <Mail className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${emailEnabled ? 'text-slate-400' : 'text-slate-300'}`} />
                    <Input
                      id="email"
                      type="email"
                      placeholder={emailEnabled ? 'you@example.com' : 'Enter phone number first'}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={`pl-10 h-12 ${!emailEnabled ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''}`}
                      disabled={!emailEnabled}
                      required={emailEnabled && selectedPatient?.has_email}
                    />
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full h-12 font-medium bg-slate-900 hover:bg-slate-800 text-white"
                  disabled={loading || success || !selectedPatient}
                >
                  {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying...</> : 'Access My Deliveries'}
                </Button>
              </form>
          </>

          <p className="mt-6 text-center text-xs text-slate-400">
            Having trouble? Contact your pharmacy for assistance.
          </p>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          Staff?{' '}
          <a href="/login" className="text-slate-600 hover:underline font-medium">Staff Login →</a>
        </p>
      </div>
      <PWAInstallPrompt storageKey="patient_pwa_install_dismissed" />
    </div>
  );
}