import React, { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Save, ShieldAlert, Hand, Activity, Gauge, Users, Search, Check } from 'lucide-react';
import {
  DEFAULT_EMERGENCY_SETTINGS,
  mergeEmergencySettings,
  normalizeTestUsers
} from '@/components/emergency/emergencyAccess';

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL EMERGENCY ACTIVATION + SENSITIVITY (owner request Nov 14 2026)
//
// Tuning panel for the emergency system. Two activation switches and one hit
// sensitivity slider. Stored as `emergency_settings` inside the existing
// AppSettings record (setting_key 'refresh_intervals') so every device reads the
// same values — this is what gets flipped on globally when the pilot ends.
// ─────────────────────────────────────────────────────────────────────────────

// Re-exported for existing imports; the real defaults live in emergencyAccess.
export { DEFAULT_EMERGENCY_SETTINGS };

// Slider runs on "sensitivity" (1 = barely reacts, 100 = reacts to anything) and
// maps to a real acceleration threshold, because a m/s² number means nothing to
// a human but a slider does.
const MIN_THRESHOLD = 25;   // most sensitive
const MAX_THRESHOLD = 80;   // most forgiving
const thresholdToSensitivity = (threshold) => {
  const clamped = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Number(threshold) || DEFAULT_EMERGENCY_SETTINGS.crash_threshold));
  const pct = ((MAX_THRESHOLD - clamped) / (MAX_THRESHOLD - MIN_THRESHOLD)) * 100;
  // The PERCENTAGE is what moves in 5% steps (owner request Nov 14 2026), so the
  // handle always sits on a clean 0/5/10…100 mark.
  return Math.round(pct / 5) * 5;
};
const sensitivityToThreshold = (sensitivity) => {
  const pct = Math.max(0, Math.min(100, Number(sensitivity) || 0));
  // Only the percent is stepped (5% at a time); the equivalent m/s² is derived
  // from it and shown for reference.
  return Math.round(MAX_THRESHOLD - (pct / 100) * (MAX_THRESHOLD - MIN_THRESHOLD));
};

const EmergencySettingsPanel = () => {
  const [settings, setSettings] = useState({ ...DEFAULT_EMERGENCY_SETTINGS });
  const [savedSettings, setSavedSettings] = useState({ ...DEFAULT_EMERGENCY_SETTINGS });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  // Pilot scope picker (owner request Nov 14 2026): All users, or multi-select.
  const [people, setPeople] = useState([]);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleSearch, setPeopleSearch] = useState('');
  const [showOnlySelected, setShowOnlySelected] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      let raw = rows?.[0]?.setting_value;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
      let stored = raw?.emergency_settings;
      if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { stored = null; } }
      const merged = mergeEmergencySettings(stored);
      setSettings(merged);
      setSavedSettings(merged);
    } catch (err) {
      console.warn('[EmergencySettings] load failed:', err?.message || err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Everybody who can be put on the pilot. AppUser is the app-side directory;
  // its `user_id` is the auth id the signed-in user object carries.
  useEffect(() => {
    let alive = true;
    (async () => {
      setPeopleLoading(true);
      try {
        // Positional pagination returns an array (same call shape as DevicesPanel);
        // also tolerate a cursor page object so an SDK bump cannot blank the list.
        const res = await base44.entities.AppUser.list('user_name', 500);
        const rows = Array.isArray(res) ? res : (res?.items || []);
        if (!alive) return;
        const seen = new Set();
        // Active accounts only, in the app's usual user order (see
        // buildPilotPeople in emergencyAccess.jsx).
        const list = buildPilotPeople(rows || []);
        setPeople(list);
      } catch (err) {
        console.warn('[EmergencySettings] user list failed:', err?.message || err);
        if (alive) setPeople([]);
      } finally {
        if (alive) setPeopleLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Column count is measured from the card's OWN width, not the viewport: the
  // admin area sits right of a user-resizable sidebar, so a 1440px screen can
  // leave this panel under 1000px wide. ResizeObserver keeps it honest.
  const gridRef = useRef(null);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const node = gridRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (width) => {
      const next = width >= 900 ? 3 : width >= 620 ? 2 : 1;
      setColumns((prev) => (prev === next ? prev : next));
    };
    measure(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width || 0;
      if (width) measure(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isLoading]);

  // At 2 columns the picker takes the full first row and the switches sit beside
  // the sensitivity block; at 3 columns they are one row.
  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap: columns >= 3 ? 16 : 12,
    alignItems: 'start'
  };
  const userPanelStyle = columns === 2 ? { gridColumn: 'span 2' } : undefined;

  const selectedIds = (settings.test_users || []).map((entry) => String(entry.id));
  const toggleUser = (person) => {
    setSettings((prev) => {
      const current = normalizeTestUsers(prev.test_users);
      const exists = current.some((entry) => entry.id === person.id);
      const next = exists
        ? current.filter((entry) => entry.id !== person.id)
        : [...current, { id: person.id, user_id: person.user_id, name: person.name }];
      return { ...prev, test_users: next };
    });
  };
  const filteredPeople = people.filter((person) => {
    if (showOnlySelected && !selectedIds.includes(person.id)) return false;
    const q = peopleSearch.trim().toLowerCase();
    if (!q) return true;
    return String(person.name).toLowerCase().includes(q)
      || person.roles.join(' ').toLowerCase().includes(q);
  });

  const save = useCallback(async () => {
    setIsSaving(true);
    setJustSaved(false);
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const current = rows?.[0]?.setting_value || {};
      const payload = {
        ...current,
        emergency_settings: {
          manual_enabled: !!settings.manual_enabled,
          crash_enabled: !!settings.crash_enabled,
          crash_threshold: Math.round(Number(settings.crash_threshold) || DEFAULT_EMERGENCY_SETTINGS.crash_threshold),
          // Pilot scope — who runs the emergency system right now.
          test_all_users: !!settings.test_all_users,
          test_users: normalizeTestUsers(settings.test_users)
        }
      };
      if (rows && rows.length > 0) {
        await base44.entities.AppSettings.update(rows[0].id, {
          setting_value: payload,
          description: 'App-wide administrative settings'
        });
      } else {
        await base44.entities.AppSettings.create({
          setting_key: 'refresh_intervals',
          setting_value: payload,
          description: 'App-wide administrative settings'
        });
      }
      setSavedSettings({ ...settings });
      setJustSaved(true);
      // Live devices pick the change up immediately.
      window.dispatchEvent(new CustomEvent('emergencySettingsUpdated', {
        detail: { data: { setting_key: 'refresh_intervals', setting_value: payload } }
      }));
    } catch (err) {
      console.error('[EmergencySettings] save failed:', err);
    } finally {
      setIsSaving(false);
    }
  }, [settings]);

  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const sensitivity = thresholdToSensitivity(settings.crash_threshold);

  return (
    <Card
      className={`rounded-[14px] border transition-all ${justSaved && !dirty ? 'border-red-500' : 'border-red-500/60'}`}
      style={{ boxShadow: '0 0 0 1px rgba(239,68,68,0.25), 0 10px 36px -10px rgba(239,68,68,0.35)' }}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-bold tracking-tight text-slate-900 dark:text-white">
          <ShieldAlert className="w-5 h-5 text-red-500" />
          Emergency System
        </CardTitle>
        <CardDescription className="text-slate-500 dark:text-[#a89b8f]">
          Pilot scope, activation and hit sensitivity. This card decides which accounts run the emergency system, so it lives with the alert history.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-slate-500 dark:text-[#a89b8f]">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <>
            {/* Wide screens were a single tall stack (owner request Nov 14 2026:
                "make the card a bit cleaner ... a 2 or 3 column layout to reduce
                its height"). Measured columns: 1 on phones, 2 on tablets/small
                laptops (picker across the top, switches beside sensitivity),
                3 on desktop (scope | activation | sensitivity). */}
            <div ref={gridRef} style={gridStyle}>
            {/* PILOT SCOPE — All users, or multi-select (owner request Nov 14 2026) */}
            <div style={userPanelStyle} className="rounded-lg border border-slate-300 bg-slate-50 p-3 dark:border-[#3a2e24] dark:bg-[#1a1410]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                    <Users className="w-4 h-4 text-red-500" />
                    Testing phase users
                  </div>
                  <p className="mt-1 text-xs text-slate-600 dark:text-[#a89b8f]">
                    Only these accounts get the map hold, impact detection, alert banner and siren. The App Owner is always included.
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:text-red-300">
                  {settings.test_all_users ? 'All users' : `${selectedIds.length} selected`}
                </span>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-[#3a2e24] dark:bg-[#120d0a]">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">All users</div>
                  <p className="text-[11px] text-slate-500 dark:text-[#a89b8f]">Every signed-in account runs the emergency system.</p>
                </div>
                <Switch
                  checked={!!settings.test_all_users}
                  onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, test_all_users: !!checked }))}
                />
              </div>

              <div className={`mt-3 space-y-2 transition-opacity ${settings.test_all_users ? 'pointer-events-none opacity-40' : ''}`}>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={peopleSearch}
                      onChange={(e) => setPeopleSearch(e.target.value)}
                      placeholder="Search people or roles…"
                      className="h-8 pl-7 text-xs"
                      disabled={!!settings.test_all_users}
                    />
                  </div>
                  <Button
                    type="button"
                    variant={showOnlySelected ? 'default' : 'outline'}
                    size="sm"
                    className="h-8 shrink-0 px-2 text-[11px]"
                    disabled={!!settings.test_all_users}
                    onClick={() => setShowOnlySelected((prev) => !prev)}
                  >
                    <Check className="mr-1 h-3 w-3" />
                    Selected
                  </Button>
                </div>

                <div className="max-h-56 overflow-y-auto rounded-md border border-slate-300 bg-white dark:border-[#3a2e24] dark:bg-[#120d0a]">
                  {peopleLoading ? (
                    <div className="flex items-center justify-center py-6 text-xs text-slate-500 dark:text-[#a89b8f]">
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading users…
                    </div>
                  ) : filteredPeople.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-slate-500 dark:text-[#a89b8f]">
                      {people.length === 0 ? 'No app users found.' : 'Nobody matches that search.'}
                    </div>
                  ) : (
                    filteredPeople.map((person) => {
                      const checked = selectedIds.includes(person.id);
                      return (
                        <label
                          key={person.id}
                          className={`flex cursor-pointer items-center gap-2 border-b border-slate-200 px-3 py-2 last:border-b-0 hover:bg-slate-50 dark:border-[#2a2019] dark:hover:bg-[#1a1410] ${checked ? 'bg-red-50/60 dark:bg-[#241713]' : ''}`}
                        >
                          <Checkbox
                            checked={checked}
                            disabled={!!settings.test_all_users}
                            onCheckedChange={() => toggleUser(person)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold text-slate-900 dark:text-white">{person.name}</span>
                            <span className="block truncate text-[11px] text-slate-500 dark:text-[#a89b8f]">
                              {[person.roles.join(', ') || 'no role', person.duty].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-[#a89b8f]">
                  Saved to the app settings, so a selected device arms itself on next load — no rebuild needed.
                </p>
              </div>
            </div>

            {/* COLUMN 2 — activation switches */}
            <div className="min-w-0 space-y-3">
            {/* Toggle 1 — manual map hold */}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-300 bg-slate-50 p-3 dark:border-[#3a2e24] dark:bg-[#1a1410]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <Hand className="w-4 h-4 text-amber-500" />
                  Map hold activation
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-[#a89b8f]">
                  5 second press and hold on the Dashboard map opens the emergency screen.
                </p>
              </div>
              <Switch
                checked={!!settings.manual_enabled}
                onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, manual_enabled: !!checked }))}
              />
            </div>

            {/* Toggle 2 — impact detection */}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-300 bg-slate-50 p-3 dark:border-[#3a2e24] dark:bg-[#1a1410]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <Activity className="w-4 h-4 text-red-500" />
                  Impact detection
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-[#a89b8f]">
                  Watches the phone's motion sensor for a hard hit and prompts the driver.
                </p>
              </div>
              <Switch
                checked={!!settings.crash_enabled}
                onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, crash_enabled: !!checked }))}
              />
            </div>

            </div>

            {/* COLUMN 3 — sensitivity + reference notes */}
            <div className="min-w-0 space-y-3">
            {/* Slider — sensitivity */}
            <div className={`rounded-lg border p-3 transition-opacity ${settings.crash_enabled ? 'border-slate-300 bg-slate-50 dark:border-[#3a2e24] dark:bg-[#1a1410]' : 'border-slate-200 bg-slate-50/40 opacity-50 dark:border-[#3a2e24] dark:bg-[#1a1410]'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <Gauge className="w-4 h-4 text-orange-500" />
                  Hit sensitivity
                </div>
                <span className="font-mono text-xs text-slate-700 dark:text-[#d6c9ba]">
                  {sensitivity}% · {Math.round(settings.crash_threshold)} m/s²
                </span>
              </div>
              <Slider
                className="mt-3"
                value={[sensitivity]}
                min={0}
                max={100}
                step={5}
                disabled={!settings.crash_enabled}
                onValueChange={(value) => {
                  const next = sensitivityToThreshold(Array.isArray(value) ? value[0] : value);
                  setSettings((prev) => ({ ...prev, crash_threshold: next }));
                }}
              />
              <div className="mt-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-[#a89b8f]">
                <span>Reacts to everything</span>
                <span>Only a hard crash</span>
              </div>
              <p className="mt-2 text-xs text-slate-600 dark:text-[#a89b8f]">
                {sensitivity >= 70
                  ? 'Very easy to trigger. Charging the phone or setting it on a table can set it off.'
                  : sensitivity >= 40
                    ? 'Balanced. A knocked phone or a pothole should not trip it.'
                    : 'Forgiving. Only a genuinely violent impact will trip it.'}
              </p>
            </div>

            <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-xs text-slate-600 space-y-1 dark:border-[#3a2e24] dark:bg-[#1a1410] dark:text-[#a89b8f]">
              <div>Pilot scope is the user list above; the App Owner is always included.</div>
              <div>A real hit must also be followed by ~15s of stillness before anything is sent.</div>
            </div>

            </div>
            </div>

            <Button
              onClick={save}
              disabled={isSaving || !dirty}
              size="sm"
              className="mt-3 w-full gap-2 border-0 font-semibold bg-red-100 text-red-900 hover:bg-red-200 dark:bg-[#f3c9c9] dark:text-[#1a1410] focus-visible:ring-red-500/40"
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {isSaving ? 'Saving…' : justSaved && !dirty ? '✓ Saved' : 'Save Emergency Settings'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default EmergencySettingsPanel;
