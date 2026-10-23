import React, { useEffect, useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { getEffectiveUser } from '@/components/utils/auth';
import JsBarcode from 'jsbarcode';
import { Barcode, Printer, Eye, EyeOff, ShieldAlert, X, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * LoginBarcodes — printable CODE128 barcode sheets for dispatcher store
 * logins (owner request, resuming the Oct 1 design; reference sheet
 * re-supplied Oct 23): ONE barcode for the username (login email) and ONE
 * for the password per account, laid out as a compact grid — 4 login cards
 * per printed row, username barcode over password barcode, small labels.
 *
 * Scan flow: the store PC scanners are keyboard-wedge style — the typed
 * barcode lands in the focused login field. Login.jsx jumps focus from the
 * email field to the password field on Enter while the password is empty,
 * so scan username → scan password → the second scan's Enter logs in.
 *
 * SECURITY MODEL:
 *  - Passwords are typed here by the owner and live ONLY in local component
 *    state for the current session — never written to any entity, IDB store,
 *    cache, or log. Closing/reloading the page clears them.
 *  - Owner/admin access only.
 */

function BarcodeCell({ value, label, big, idBase }) {
  const svgRef = React.useRef(null);
  const ok = !!value;
  useEffect(() => {
    if (!svgRef.current || !ok) return;
    try {
      JsBarcode(svgRef.current, String(value), {
        format: 'CODE128',
        lineColor: '#000000',
        width: big ? 1.4 : 1.1,
        height: big ? 44 : 34,
        displayValue: false,
        margin: 2,
      });
    } catch { /* render failure leaves the raw text below */ }
  }, [value, big, ok]);

  return (
    <div className="text-center min-w-0">
      <div className="text-[9px] font-bold uppercase tracking-wide text-slate-600 leading-none mb-0.5">{label}</div>
      {ok
        ? <svg id={idBase} ref={svgRef} className="w-full h-auto mx-auto" style={{ maxHeight: big ? 44 : 34 }} />
        : <div className="w-full border border-dashed border-slate-400 rounded flex items-center justify-center text-[9px] text-slate-400"
            style={{ height: big ? 44 : 34 }}>no password</div>}
      <div className="text-[8px] font-mono text-slate-600 mt-0.5 break-all leading-tight">{value || '—'}</div>
    </div>
  );
}

function LoginCard({ user, idx }) {
  return (
    <div className="bc-login-card border-2 border-black rounded-md px-2 py-1.5">
      <div className="text-center text-[11px] font-extrabold tracking-wide leading-none truncate mb-1">
        {user.user_name}
      </div>
      <div className="space-y-1">
        <BarcodeCell value={user.email} label="Username" big idBase={`bcu-${user.id}-${idx}`} />
        <BarcodeCell value={user.password} label="Password" idBase={`bcp-${user.id}-${idx}`} />
      </div>
    </div>
  );
}

export default function LoginBarcodes() {
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [users, setUsers] = useState([]);
  const [passwords, setPasswords] = useState({});
  const [usernames, setUsernames] = useState({});
  const [showPasswords, setShowPasswords] = useState({});
  const [selected, setSelected] = useState({});
  const [copies, setCopies] = useState(2);
  const [showPrintOverlay, setShowPrintOverlay] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [me, appUsersData, authUsersData, storesData] = await Promise.all([
          getEffectiveUser().catch(() => null),
          base44.entities.AppUser.list().catch(() => []),
          base44.entities.User.list().catch(() => []),
          base44.entities.Store.list().catch(() => []),
        ]);
        const isAdmin = !!(me?.app_roles?.includes('admin') || me?.app_roles?.includes('owner'));
        if (!isAdmin) { setForbidden(true); return; }

        const storeNameById = {};
        (storesData || []).forEach((s) => { storeNameById[s.id] = s.name; });

        // Merge AppUser (roles, name) with the auth User record (login email)
        // — same resolution the AppUsers admin page uses. If the auth email
        // can't be read, fall back to the Oct 1 sheet convention
        // ("StoreName.Shoppers"); every row is editable either way.
        const authById = new Map((authUsersData || []).map((u) => [u.id, u]));
        const merged = (appUsersData || [])
          .filter((u) => (u.app_roles || []).includes('dispatcher'))
          .map((u) => {
            const auth = authById.get(u.user_id);
            const fallback = `${String(u.user_name || '').replace(/[^A-Za-z0-9]+/g, '')}.Shoppers`;
            return { ...u, email: auth?.email || fallback, storeName: (u.store_ids || []).map((sid) => storeNameById[sid]).filter(Boolean).join(', ') };
          })
          .sort((a, b) => (a.user_name || '').localeCompare(b.user_name || ''));
        setUsers(merged);
        const pre = {};
        merged.forEach((u) => { if (u.status !== 'inactive') pre[u.id] = true; });
        setSelected(pre);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const sheets = useMemo(() => users.map((u) => ({
    ...u,
    email: usernames[u.id] ?? u.email,
    password: passwords[u.id] || '',
  })), [users, usernames, passwords]);

  const selectedSheets = useMemo(() => sheets.filter((u) => selected[u.id]), [sheets, selected]);
  const withPassword = useMemo(() => selectedSheets.filter((u) => u.password), [selectedSheets]);

  const handlePrint = () => {
    if (selectedSheets.length === 0) { alert('Select at least one account.'); return; }
    if (withPassword.length === 0) {
      alert('Enter at least one password — sheets without a password barcode are useless.');
      return;
    }
    setShowPrintOverlay(true);
  };

  useEffect(() => {
    if (!showPrintOverlay) return;
    const t = setTimeout(() => { try { window.print(); } catch {} }, 400);
    return () => clearTimeout(t);
  }, [showPrintOverlay]);

  if (loading) return <div className="p-12 text-center text-slate-500">Loading…</div>;

  if (forbidden) {
    return (
      <div className="p-12 flex flex-col items-center justify-center text-center gap-3">
        <Lock className="w-10 h-10 text-slate-400" />
        <div className="text-lg font-bold">Admin access only</div>
        <div className="text-sm text-slate-500">Login barcode sheets can only be generated by an administrator.</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* PRINT STYLES: only the .bc-sheet grid is visible to the printer */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .bc-sheet, .bc-sheet * { visibility: visible; }
          .bc-sheet { position: absolute; left: 0; top: 0; width: 100%; }
          .bc-no-print { display: none !important; }
          @page { margin: 8mm; }
        }
        @media screen {
          .bc-sheet { margin: 0 auto; max-width: 800px; }
        }
        .bc-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
        @media (max-width: 900px) { .bc-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      `}</style>

      <div className="bc-no-print flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Barcode className="w-6 h-6" /> Login Barcode Sheets</h1>
          <p className="text-sm text-slate-500 mt-1">Printable username + password barcodes for dispatcher logins. Passwords are typed here and never saved anywhere.</p>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-500">Copies each</Label>
          <select value={copies} onChange={(e) => setCopies(Number(e.target.value))}
            className="border rounded-lg px-2 py-2 text-sm bg-background">
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <Button onClick={handlePrint} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
            <Printer className="w-4 h-4" /> Print ({withPassword.length} logins)
          </Button>
        </div>
      </div>

      <div className="bc-no-print flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 text-sm">
        <ShieldAlert className="w-5 h-5 flex-shrink-0" />
        <span>Each printed card grants full account access. Store printouts in the store office only. To revoke access, change the account password.</span>
      </div>

      <div className="bc-no-print space-y-3">
        {sheets.map((u) => {
          const isSel = !!selected[u.id];
          return (
            <div key={u.id} className={`rounded-xl border p-4 flex flex-col md:flex-row md:items-center gap-4 transition-colors ${isSel ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-200'}`}>
              <label className="flex items-center gap-3 md:w-56 cursor-pointer">
                <input type="checkbox" checked={isSel} onChange={(e) => setSelected((p) => ({ ...p, [u.id]: e.target.checked }))}
                  className="w-5 h-5 accent-emerald-600" />
                <div className="min-w-0">
                  <div className="font-bold truncate">{u.user_name}{u.status === 'inactive' ? ' (inactive)' : ''}</div>
                  <div className="text-xs text-slate-500 truncate">{u.storeName || 'dispatcher'}</div>
                </div>
              </label>
              <div className="flex-1 min-w-0">
                <Label className="text-xs text-slate-500">Username (scans into the Email field)</Label>
                <Input value={u.email} onChange={(e) => setUsernames((p) => ({ ...p, [u.id]: e.target.value }))}
                  className="font-mono mt-1" />
              </div>
              <div className="flex-1 md:max-w-xs">
                <Label htmlFor={`pw-${u.id}`} className="text-xs text-slate-500">Password (never saved)</Label>
                <div className="relative mt-1">
                  <Input id={`pw-${u.id}`}
                    type={showPasswords[u.id] ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={u.password}
                    onChange={(e) => setPasswords((p) => ({ ...p, [u.id]: e.target.value }))}
                    placeholder="Type the account password…"
                    className="pr-10 font-mono" />
                  <button type="button" onClick={() => setShowPasswords((p) => ({ ...p, [u.id]: !p[u.id] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    aria-label={showPasswords[u.id] ? 'Hide password' : 'Show password'}>
                    {showPasswords[u.id] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {sheets.length === 0 && <div className="text-slate-500 py-8 text-center">No dispatcher accounts found.</div>}
      </div>

      {/* PRINT OVERLAY — the only thing the printer sees */}
      {showPrintOverlay && (
        <div className="fixed inset-0 z-[9999] bg-white overflow-auto">
          <div className="bc-no-print sticky top-0 bg-white border-b p-3 flex items-center justify-between">
            <div className="text-sm text-slate-600">Print preview — {withPassword.length} login(s), {copies} cop{copies > 1 ? 'ies' : 'y'} each. Use Ctrl+P if the Print dialog didn't open.</div>
            <Button variant="outline" className="gap-2" onClick={() => setShowPrintOverlay(false)}><X className="w-4 h-4" /> Close</Button>
          </div>
          <div className="bc-sheet bg-white text-black p-4">
            <div className="bc-grid">
              {withPassword.flatMap((u) =>
                Array.from({ length: copies }, (_, c) => <LoginCard key={`${u.id}-${c}`} user={u} idx={c} />)
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
