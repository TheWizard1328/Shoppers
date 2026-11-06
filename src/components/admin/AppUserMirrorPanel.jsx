/**
 * AppUserMirrorPanel.jsx
 * Owner-only control for the AppUser IndexedDB mirror (owner spec Nov 6 2026).
 *
 * The button does not push anything itself: it raises a stamp in AppSettings.
 * Every device compares its local stamp at boot and, when the server is newer,
 * wipes its local app_users store and rewrites it from the server. That way
 * devices that are offline or not yet installed also heal themselves.
 */
import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Database, Loader2, RefreshCw } from 'lucide-react';
import {
  APP_USER_MIRROR_KEY,
  bumpAppUserMirrorVersion,
  getLocalMirrorVersion,
  runAppUserMirror,
} from '@/components/utils/appUserMirror';

const fmt = (ms) => {
  const n = Number(ms) || 0;
  if (!n) return 'never';
  try {
    return new Date(n).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return 'unknown'; }
};

export default function AppUserMirrorPanel() {
  const [serverVersion, setServerVersion] = useState(0);
  const [localVersion, setLocalVersion] = useState(() => getLocalMirrorVersion());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const loadVersions = async () => {
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: APP_USER_MIRROR_KEY });
      setServerVersion(Number(rows?.[0]?.setting_value?.version) || 0);
    } catch { /* offline - keep shown values */ }
    setLocalVersion(getLocalMirrorVersion());
  };

  useEffect(() => { loadVersions(); }, []);

  const handleForce = async () => {
    if (!window.confirm(
      'Force every device to replace its local AppUser cache with the server copy?\n\n' +
      'Each device does this on its next app open. Local AppUser rows that were never synced ' +
      'to the server would be discarded; the device skips the mirror if it has any pending.'
    )) return;
    setBusy(true);
    setStatus('');
    try {
      const version = await bumpAppUserMirrorVersion();
      const local = await runAppUserMirror({ reason: 'admin-forced' });
      setServerVersion(version);
      setLocalVersion(getLocalMirrorVersion());
      setStatus(
        local?.mirrored
          ? `Stamp raised. This device mirrored ${local.mirrored} users. Every other device follows on its next open.`
          : `Stamp raised. This device skipped: ${local?.skipped || 'unknown'}. Other devices follow on their next open.`
      );
    } catch (err) {
      setStatus(`Failed: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  const pending = serverVersion > localVersion;

  return (
    <Card className="bg-surface border-surface">
      <CardHeader className="p-4 sm:p-6">
        <CardTitle className="flex items-start gap-2 text-body text-base">
          <Database className="w-5 h-5 mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">App User Cache Mirror</span>
        </CardTitle>
        <CardDescription className="text-soft text-xs sm:text-sm">
          Replaces the local AppUser cache on every device with the server copy, clearing junk rows.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0 space-y-3">
        <div className="flex flex-col gap-1 text-xs text-soft">
          <span>Server stamp: <span className="font-mono text-body">{fmt(serverVersion)}</span></span>
          <span>This device: <span className="font-mono text-body">{fmt(localVersion)}</span></span>
          {pending && <Badge variant="secondary" className="w-fit">Mirror pending on this device</Badge>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={handleForce} disabled={busy} className="w-full sm:w-auto">
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Force mirror on all devices
          </Button>
          <Button variant="outline" onClick={loadVersions} disabled={busy} className="w-full sm:w-auto">
            Refresh stamp
          </Button>
        </div>
        {status && <p className="text-xs text-body break-words">{status}</p>}
      </CardContent>
    </Card>
  );
}
