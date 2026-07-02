import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { format, parseISO } from 'date-fns';
import { CalendarDays, Plus, Trash2, RefreshCw, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { invalidateStatHolidayCache } from '@/components/utils/statHolidayResolver';
import { fetchPublicHolidays } from '@/functions/fetchPublicHolidays';

export default function StatHolidays() {
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [importCountry, setImportCountry] = useState('CA');
  const [importProvince, setImportProvince] = useState('CA-AB');
  const [importYear, setImportYear] = useState(String(new Date().getFullYear()));

  const load = async () => {
    setLoading(true);
    try {
      const list = await base44.entities.StatHoliday.list('date', 200);
      setHolidays(list.sort((a, b) => a.date.localeCompare(b.date)));
    } catch {
      toast.error('Failed to load stat holidays');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!newDate || !newName.trim()) {
      toast.error('Please enter both a date and a holiday name.');
      return;
    }
    if (holidays.some((h) => h.date === newDate)) {
      toast.error('A stat holiday already exists for that date.');
      return;
    }
    setSaving(true);
    try {
      const created = await base44.entities.StatHoliday.create({ date: newDate, holiday_name: newName.trim() });
      setHolidays((prev) => [...prev, created].sort((a, b) => a.date.localeCompare(b.date)));
      invalidateStatHolidayCache();
      setNewDate('');
      setNewName('');
      toast.success('Stat holiday added');
    } catch {
      toast.error('Failed to add stat holiday');
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const province = importCountry === 'CA' ? importProvince : null;
      const res = await fetchPublicHolidays({ countryCode: importCountry, year: parseInt(importYear), province });
      const fetched = res?.data?.holidays || [];
      if (!fetched.length) { toast.error('No holidays returned for that selection.'); return; }

      const existingDates = new Set(holidays.map((h) => h.date));
      const toAdd = fetched.filter((h) => !existingDates.has(h.date));

      if (!toAdd.length) { toast.info('All holidays for that year are already in your list.'); return; }

      let added = 0;
      for (const h of toAdd) {
        const created = await base44.entities.StatHoliday.create(h);
        setHolidays((prev) => [...prev, created].sort((a, b) => a.date.localeCompare(b.date)));
        added++;
      }
      invalidateStatHolidayCache();
      toast.success(`Imported ${added} holiday${added !== 1 ? 's' : ''}`);
    } catch (e) {
      toast.error('Import failed: ' + (e?.message || 'Unknown error'));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await base44.entities.StatHoliday.delete(id);
      setHolidays((prev) => prev.filter((h) => h.id !== id));
      invalidateStatHolidayCache();
      toast.success('Stat holiday removed');
    } catch {
      toast.error('Failed to remove stat holiday');
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--bg-slate-50)', color: 'var(--text-slate-900)' }}>
      {/* Header */}
      <div className="flex-shrink-0 border-b px-5 py-4 flex items-center gap-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <CalendarDays className="w-5 h-5 text-amber-500" />
        <div>
          <h1 className="text-lg font-bold">Stat Holidays</h1>
          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
            Stat holiday dates suppress automatic driver scheduling and require manual driver selection in the delivery form.
          </p>
        </div>
        {loading && <RefreshCw className="w-4 h-4 animate-spin text-blue-500 ml-auto" />}
      </div>

      <div className="flex-1 overflow-auto p-5 space-y-6">
        {/* Import from Public API */}
        <div className="rounded-xl border p-4 space-y-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <div>
            <h2 className="text-sm font-semibold">Import Public Holidays</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>Fetch official public holidays from Nager.Date and add any that aren't already in your list.</p>
          </div>
          <div className="flex gap-3 items-end flex-wrap">
            <div className="space-y-1">
              <Label className="text-xs">Country</Label>
              <Select value={importCountry} onValueChange={(v) => { setImportCountry(v); setImportProvince(''); }}>
                <SelectTrigger className="h-9 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CA">🇨🇦 Canada</SelectItem>
                  <SelectItem value="US">🇺🇸 United States</SelectItem>
                  <SelectItem value="GB">🇬🇧 United Kingdom</SelectItem>
                  <SelectItem value="AU">🇦🇺 Australia</SelectItem>
                  <SelectItem value="NZ">🇳🇿 New Zealand</SelectItem>
                  <SelectItem value="DE">🇩🇪 Germany</SelectItem>
                  <SelectItem value="FR">🇫🇷 France</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {importCountry === 'CA' && (
              <div className="space-y-1">
                <Label className="text-xs">Province</Label>
                <Select value={importProvince} onValueChange={setImportProvince}>
                  <SelectTrigger className="h-9 w-48">
                    <SelectValue placeholder="Select province" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CA-AB">Alberta</SelectItem>
                    <SelectItem value="CA-BC">British Columbia</SelectItem>
                    <SelectItem value="CA-MB">Manitoba</SelectItem>
                    <SelectItem value="CA-NB">New Brunswick</SelectItem>
                    <SelectItem value="CA-NL">Newfoundland & Labrador</SelectItem>
                    <SelectItem value="CA-NS">Nova Scotia</SelectItem>
                    <SelectItem value="CA-NT">Northwest Territories</SelectItem>
                    <SelectItem value="CA-NU">Nunavut</SelectItem>
                    <SelectItem value="CA-ON">Ontario</SelectItem>
                    <SelectItem value="CA-PE">Prince Edward Island</SelectItem>
                    <SelectItem value="CA-QC">Quebec</SelectItem>
                    <SelectItem value="CA-SK">Saskatchewan</SelectItem>
                    <SelectItem value="CA-YT">Yukon</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Year</Label>
              <Select value={importYear} onValueChange={setImportYear}>
                <SelectTrigger className="h-9 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1].map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleImport} disabled={importing} variant="outline" className="gap-2 h-9">
              {importing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {importing ? 'Importing...' : 'Import Holidays'}
            </Button>
          </div>
        </div>

        {/* Add Holiday Form */}
        <div className="rounded-xl border p-4 space-y-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <h2 className="text-sm font-semibold">Add Stat Holiday</h2>
          <div className="flex gap-3 items-end flex-wrap">
            <div className="space-y-1">
              <Label className="text-xs">Date</Label>
              <Input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="h-9 w-44"
                disabled={saving}
              />
            </div>
            <div className="space-y-1 flex-1 min-w-[180px]">
              <Label className="text-xs">Holiday Name</Label>
              <Input
                placeholder="e.g. Canada Day"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                className="h-9"
                disabled={saving}
              />
            </div>
            <Button onClick={handleAdd} disabled={saving || !newDate || !newName.trim()} className="gap-2 h-9">
              <Plus className="w-4 h-4" />Add
            </Button>
          </div>
        </div>

        {/* Holiday List */}
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          {loading ? (
            <div className="py-10 text-center text-sm" style={{ color: 'var(--text-slate-400)' }}>Loading...</div>
          ) : holidays.length === 0 ? (
            <div className="py-10 text-center text-sm" style={{ color: 'var(--text-slate-400)' }}>
              No stat holidays configured yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                  <th className="px-4 py-2 text-left text-xs font-semibold" style={{ color: 'var(--text-slate-500)' }}>Date</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold" style={{ color: 'var(--text-slate-500)' }}>Holiday Name</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold" style={{ color: 'var(--text-slate-500)' }}></th>
                </tr>
              </thead>
              <tbody>
                {holidays.map((h, idx) => (
                  <tr
                    key={h.id}
                    className="border-b"
                    style={{ borderColor: 'var(--border-slate-100)', background: idx % 2 === 0 ? 'var(--bg-white)' : 'var(--bg-slate-50)' }}>
                    <td className="px-4 py-2.5 font-medium">
                      🎉 {format(parseISO(h.date), 'MMMM d, yyyy')}
                    </td>
                    <td className="px-4 py-2.5" style={{ color: 'var(--text-slate-700)' }}>
                      {h.holiday_name}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-400 hover:text-red-600"
                        onClick={() => handleDelete(h.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}