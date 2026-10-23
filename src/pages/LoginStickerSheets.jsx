import React, { useEffect, useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { getEffectiveUser } from '@/components/utils/auth';
import JsBarcode from 'jsbarcode';
import { Barcode, Printer, Eye, EyeOff, ShieldAlert, X, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * LoginStickerSheets — printable CODE128 barcodes for dispatcher logins,
 * laid out for the owner's 2"x2" square sticker labels (owner spec Oct 23):
 *  - Grid per sheet: 6 rows x 5 columns (30 stickers), defaults configurable.
 *  - Each login prints 2 times, SIDE BY SIDE (adjacent stickers).
 *  - Each sticker: username barcode (TOP, full login email), the STORE NAME
 *    (middle, the only readable text), password barcode (BOTTOM).
 *  - NO username/password text is printed — barcodes + store name only.
 *  - Store scanners are keyboard-wedge: each scan types the text + Enter.
 *    (Login.jsx jumps Email→Password focus on Enter while password is empty.)
 *
 * SECURITY MODEL: passwords typed here live ONLY in local component state
 * for the current session — never written to any entity, IDB, cache, or log.
 * Owner/admin access only.
 */

// 2"x2" sticker at CSS 96dpi = 192px. Print at 100% / "Actual size".
const STICKER_PX = 192;

function BarcodeImg({ value, heightPx }) {
  const svgRef = React.useRef(null);
  const ok = !!value;
  useEffect(() => {
    if (!svgRef.current || !ok) return;
    try {
      JsBarcode(svgRef.current, String(value), {
        format: 'CODE128',
        lineColor: '#000000',
        width: 1,
        height: heightPx,
        displayValue: false,
        margin: 0,
      });
    } catch { /* unscannable content — blank cell renders instead */ }
  }, [value, heightPx, ok]);
  if (!ok) return null;
  return <svg ref={svgRef} style={{ display: 'block', width: '100%', height: `${heightPx}px` }} />;
}

function Sticker({ login }) {
  // login = { userName, email, password }
  const emailBarcode = login?.email ? <BarcodeImg value={login.email} heightPx={44} /> : null;
  const passBarcode = login?.password ? <BarcodeImg value={login.password} heightPx={38} /> : null;
  return (
    <div className="bc-sticker bg-white text-black overflow-hidden flex flex-col justify-between"
      style={{ width: `${STICKER_PX}px`, height: `${STICKER_PX}px`, padding: '6px' }}>
      <div>{emailBarcode}</div>
      <div className="text-center leading-none select-none"
        style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '0.02em' }}>
        {login?.userName || ''}
      </div>
      <div>{passBarcode}</div>
    </div>
  );
}

function StickerSheet({ logins, cols }) {
  // Build the cell list: each login contributes 2 adjacent stickers. Keep
  // the pair on the same row — if it would straddle a row end, insert a
  // blank spacer cell first.
  const cells = [];
  let col = 0;
  logins.forEach((login) => {
    if (col > 0 && col % cols === cols - 1) { cells.push(null); col += 1; } // pair would split
    cells.push(login, login);
    col += 2;
  });
  return (
    <div className="bc-sheet bg-white" style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${STICKER_PX}px)` }}>
      {cells.map((login, i) => (
        login
          ? <Sticker key={i} login={login} />
          : <div key={i} style={{ width: `${STICKER_PX}px`, height: `${STICKER_PX}px` }} />
      ))}
    </div>
  );
}

export default function LoginStickerSheets() {
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [users, setUsers] = useState([]);
  const [passwords, setPasswords] = useState({});
  const [usernames, setUsernames] = useState({});
  const [showPasswords, setShowPasswords] = useState({});
  const [selected, setSelected] = useState({});
  const [rows, setRows] = useState(6);
  const [cols, setCols] = useState(5);
  const [showPrintOverlay, setShowPrintOverlay] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [me, appUsersData, authUsersData] = await Promise.all([
          getEffectiveUser().catch(() => null),
          base44.entities.AppUser.list().catch(() => []),
          base44.entities.User.list().catch(() => []),
        ]);
        const isAdmin = !!(me?.app_roles?.includes('admin') || me?.app_roles?.includes('owner'));
        if (!isAdmin) { setForbidden(true); return; }

        const authById = new Map((authUsersData || []).map((u) => [u.id, u]));
        const merged = (appUsersData || [])
          .filter((u) => (u.app_roles || []).includes('dispatcher'))
          .map((u) => ({ ...u, email: authById.get(u.user_id)?.email || '' }))
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

  const logins = useMemo(() => users.filter((u) => selected[u.id]).map((u) => ({
    id: u.id,
    userName: u.user_name,
    email: usernames[u.id] ?? u.email,
    password: passwords[u.id] || '',
  })).filter((u) => u.email && u.password), [users, selected, usernames, passwords]);

  const sheets = useMemo(() => {
    const perSheet = Math.floor((rows * cols) / 2); // 2 stickers per login
    const out = [];
    for (let i = 0; i < logins.length; i += perSheet) out.push(logins.slice(i, i + perSheet));
    return out;
  }, [logins, rows, cols]);

  const handlePrint = () => {
    if (logins.length === 0) { alert('Enter a password for at least one login (and make sure it has an email).'); return; }
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
        <div className="text-sm text-slate-500">Login barcode stickers can only be generated by an administrator.</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* PRINT STYLES: only the .bc-sheet grids reach the printer */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .bc-sheet, .bc-sheet * { visibility: visible; }
          .bc-sheet { position: absolute; left: 0; top: 0; page-break-after: always; }
          .bc-no-print { display: none !important; }
          @page { margin: 0; }
        }
        @media screen {
          .bc-sheet { margin: 0 auto 24px; }
        }
      `}</style>

      <div className="bc-no-print flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Barcode className="w-6 h-6" /> Login Sticker Sheets</h1>
          <p className="text-sm text-slate-500 mt-1">2"x2" stickers — username barcode on top, store name, password barcode below. Passwords are typed here and never saved anywhere.</p>
        </div>
        <Button onClick={handlePrint} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
          <Printer className="w-4 h-4" /> Print ({logins.length} logins, {sheets.length} sheet{sheets.length === 1 ? '' : 's'})
        </Button>
      </div>

      <div className="bc-no-print flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 text-sm">
        <ShieldAlert className="w-5 h-5 flex-shrink-0" />
        <span>Every sticker is a full account login. Keep sticker sheets in the store office. Test on plain paper first, printed at 100% / "Actual size", and hold it over a sticker sheet to check alignment before printing on the real labels.</span>
      </div>

      <div className="bc-no-print flex items-center gap-4 flex-wrap text-sm">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-500">Rows per sheet</Label>
          <select value={rows} onChange={(e) => setRows(Number(e.target.value))} className="border rounded-lg px-2 py-1.5 bg-background">
            {[5, 6, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-500">Columns per sheet</Label>
          <select value={cols} onChange={(e) => setCols(Number(e.target.value))} className="border rounded-lg px-2 py-1.5 bg-background">
            {[4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <span className="text-xs text-slate-400">Each login prints twice, side by side.</span>
      </div>

      <div className="bc-no-print space-y-3">
        {users.map((u) => {
          const isSel = !!selected[u.id];
          return (
            <div key={u.id} className={`rounded-xl border p-4 flex flex-col md:flex-row md:items-center gap-4 transition-colors ${isSel ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-200'}`}>
              <label className="flex items-center gap-3 md:w-52 cursor-pointer">
                <input type="checkbox" checked={isSel} onChange={(e) => setSelected((p) => ({ ...p, [u.id]: e.target.checked }))}
                  className="w-5 h-5 accent-emerald-600" />
                <div className="min-w-0">
                  <div className="font-bold truncate">{u.user_name}{u.status === 'inactive' ? ' (inactive)' : ''}</div>
                </div>
              </label>
              <div className="flex-1 min-w-0">
                <Label className="text-xs text-slate-500">Username (login email — top barcode)</Label>
                <Input value={usernames[u.id] ?? u.email} onChange={(e) => setUsernames((p) => ({ ...p, [u.id]: e.target.value }))}
                  placeholder={u.email ? '' : 'no login email found — type it'} className="font-mono mt-1" />
              </div>
              <div className="flex-1 md:max-w-xs">
                <Label htmlFor={`pw-${u.id}`} className="text-xs text-slate-500">Password (bottom barcode, never saved)</Label>
                <div className="relative mt-1">
                  <Input id={`pw-${u.id}`}
                    type={showPasswords[u.id] ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={passwords[u.id] || ''}
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
        {users.length === 0 && <div className="text-slate-500 py-8 text-center">No dispatcher accounts found.</div>}
      </div>

      {/* PRINT OVERLAY — the only thing the printer sees */}
      {showPrintOverlay && (
        <div className="fixed inset-0 z-[9999] bg-white overflow-auto">
          <div className="bc-no-print sticky top-0 bg-white border-b p-3 flex items-center justify-between">
            <div className="text-sm text-slate-600">Print preview — print at 100% / "Actual size". Use Ctrl+P if the dialog didn't open.</div>
            <Button variant="outline" className="gap-2" onClick={() => setShowPrintOverlay(false)}><X className="w-4 h-4" /> Close</Button>
          </div>
          {sheets.map((sheetLogins, i) => (
            <StickerSheet key={i} logins={sheetLogins} cols={cols} />
          ))}
        </div>
      )}
    </div>
  );
}
