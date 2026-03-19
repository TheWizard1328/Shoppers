import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, AlertCircle, Loader2, QrCode } from 'lucide-react';

export default function Register() {
  const [status, setStatus] = useState('loading'); // loading | valid | invalid | expired | already_used
  const [inviteToken, setInviteToken] = useState(null);
  const [tokenData, setTokenData] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('inviteToken');
    
    if (!token) {
      setStatus('invalid');
      return;
    }
    
    setInviteToken(token);
    validateToken(token);
  }, []);

  const validateToken = async (token) => {
    try {
      // Check if user is already logged in
      let user = null;
      try {
        user = await base44.auth.me();
        setCurrentUser(user);
      } catch (e) {
        // Not logged in - that's ok
      }

      // Look up the invite token record
      const tokens = await base44.entities.InviteToken.filter({ token });
      
      if (!tokens || tokens.length === 0) {
        setStatus('invalid');
        return;
      }

      const tokenRecord = tokens[0];
      setTokenData(tokenRecord);

      // Check if expired
      if (tokenRecord.expires_at && new Date(tokenRecord.expires_at) < new Date()) {
        setStatus('expired');
        return;
      }

      // Check if already used
      if (tokenRecord.status === 'used') {
        setStatus('already_used');
        return;
      }

      setStatus('valid');
    } catch (error) {
      console.error('Error validating token:', error);
      setStatus('invalid');
    }
  };

  const handleAcceptInvite = async () => {
    if (!currentUser) {
      // Redirect to login, then come back here
      base44.auth.redirectToLogin(window.location.href);
      return;
    }

    // User is logged in - mark token as used and redirect to dashboard
    try {
      if (tokenData) {
        await base44.entities.InviteToken.update(tokenData.id, {
          status: 'used',
          used_by_user_id: currentUser.id,
          used_at: new Date().toISOString()
        });
      }
      window.location.href = '/';
    } catch (error) {
      console.error('Error accepting invite:', error);
      window.location.href = '/';
    }
  };

  const getRoleLabel = (role) => {
    switch (role) {
      case 'admin': return 'Administrator';
      case 'dispatcher': return 'Dispatcher';
      case 'driver': return 'Driver';
      case 'patient': return 'Patient';
      default: return role || 'User';
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
              <QrCode className="w-8 h-8 text-emerald-600" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold text-slate-900">
            RxDeliver Invite
          </CardTitle>
        </CardHeader>

        <CardContent className="text-center space-y-4 pt-2">
          {status === 'loading' && (
            <div className="py-8">
              <Loader2 className="w-8 h-8 animate-spin text-emerald-500 mx-auto mb-3" />
              <p className="text-slate-600">Validating your invitation...</p>
            </div>
          )}

          {status === 'valid' && tokenData && (
            <>
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
                <CheckCircle className="w-6 h-6 text-emerald-600 mx-auto mb-2" />
                <p className="text-emerald-800 font-semibold">
                  You've been invited as a <span className="capitalize">{getRoleLabel(tokenData.role)}</span>
                </p>
                {tokenData.generated_by_name && (
                  <p className="text-emerald-700 text-sm mt-1">
                    Invited by {tokenData.generated_by_name}
                  </p>
                )}
              </div>

              {currentUser ? (
                <>
                  <p className="text-slate-600 text-sm">
                    Logged in as <strong>{currentUser.full_name || currentUser.email}</strong>
                  </p>
                  <Button
                    onClick={handleAcceptInvite}
                    className="w-full bg-emerald-600 hover:bg-emerald-700"
                  >
                    Accept Invitation & Enter App
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-slate-600 text-sm">
                    Sign in or create an account to accept this invitation and access RxDeliver.
                  </p>
                  <Button
                    onClick={handleAcceptInvite}
                    className="w-full bg-emerald-600 hover:bg-emerald-700"
                  >
                    Sign In / Create Account
                  </Button>
                  <p className="text-xs text-slate-400">
                    You'll be redirected back here after signing in.
                  </p>
                </>
              )}
            </>
          )}

          {status === 'expired' && (
            <div className="py-4">
              <AlertCircle className="w-10 h-10 text-orange-500 mx-auto mb-3" />
              <h3 className="font-semibold text-slate-900 mb-2">Invitation Expired</h3>
              <p className="text-slate-600 text-sm">
                This invitation link has expired. Please ask an admin to generate a new QR code.
              </p>
            </div>
          )}

          {status === 'already_used' && (
            <div className="py-4">
              <CheckCircle className="w-10 h-10 text-slate-400 mx-auto mb-3" />
              <h3 className="font-semibold text-slate-900 mb-2">Already Used</h3>
              <p className="text-slate-600 text-sm">
                This invitation has already been used. If you need access, please contact an admin.
              </p>
              <Button
                onClick={() => window.location.href = '/'}
                variant="outline"
                className="mt-4 w-full"
              >
                Go to App
              </Button>
            </div>
          )}

          {status === 'invalid' && (
            <div className="py-4">
              <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
              <h3 className="font-semibold text-slate-900 mb-2">Invalid Invitation</h3>
              <p className="text-slate-600 text-sm">
                This invitation link is invalid or could not be found. Please ask an admin for a new invite.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}