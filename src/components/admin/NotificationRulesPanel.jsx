import React, { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, Save, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { applyTemplateUpdate } from '@/components/utils/notificationRules';

const formatEventLabel = (eventName) =>
  eventName ? eventName.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : '';

const FIELD_OPTIONS = [
  { value: 'store_id',                  label: 'Store' },
  { value: 'driver_id',                 label: 'Driver' },
  { value: 'signature_needed',          label: 'Signature Required' },
  { value: 'first_delivery',            label: 'First Delivery' },
  { value: 'fridge_item',               label: 'Fridge Item' },
  { value: 'oversized',                 label: 'Oversized' },
  { value: 'cod_total_amount_required', label: 'COD Amount' },
  { value: 'no_charge',                 label: 'No Charge' },
];

const OPERATOR_OPTIONS = [
  { value: 'equals',      label: '= Equals' },
  { value: 'not_equals',  label: '≠ Not Equals' },
  { value: 'greater_than',label: '> Greater Than' },
  { value: 'less_than',   label: '< Less Than' },
  { value: 'is_true',     label: '✓ Is True' },
  { value: 'is_false',    label: '✗ Is False' },
  { value: 'in_list',     label: '∈ In List' },
  { value: 'not_in_list', label: '∉ Not In List' },
];

const OPERATOR_NEEDS_VALUE = ['equals', 'not_equals', 'greater_than', 'less_than', 'in_list', 'not_in_list'];
const LIST_FIELDS = ['store_id', 'driver_id'];

const RECIPIENT_OPTIONS = [
  { value: 'dispatchers', label: '📋 Dispatchers (store-assigned)' },
  { value: 'driver',      label: '🚗 Driver (assigned to delivery)' },
  { value: 'appowner',    label: '👑 App Owner' },
  { value: 'admins',      label: '🔧 All Admins' },
];

/** Multi-select checkbox dropdown for store/driver lists */
function EntityMultiSelect({ field, value, onChange, stores, drivers }) {
  const [open, setOpen] = useState(false);

  const options = field === 'store_id'
    ? stores.map((s) => ({ id: s.id, label: s.name }))
    : drivers.map((d) => ({ id: d.user_id || d.id, label: d.user_name || d.full_name || d.id }));

  // value is comma-separated IDs
  const selectedIds = value ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];

  const toggle = (id) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
    onChange(next.join(','));
  };

  const selectedLabels = selectedIds.map((id) => {
    const opt = options.find((o) => o.id === id);
    return opt ? opt.label : id;
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-8 text-xs border rounded-md px-2 bg-white text-left min-w-[140px] max-w-[200px] truncate flex items-center justify-between gap-1 hover:border-blue-400"
      >
        <span className="truncate">
          {selectedLabels.length === 0 ? 'Select…' : selectedLabels.join(', ')}
        </span>
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 bg-white border rounded-lg shadow-lg p-2 space-y-1 max-h-52 overflow-y-auto min-w-[180px]">
          {options.length === 0 && (
            <p className="text-xs text-slate-400 px-1">No options loaded</p>
          )}
          {options.map((opt) => (
            <label key={opt.id} className="flex items-center gap-2 cursor-pointer px-1 py-0.5 hover:bg-slate-50 rounded">
              <input
                type="checkbox"
                checked={selectedIds.includes(opt.id)}
                onChange={() => toggle(opt.id)}
                className="w-3 h-3"
              />
              <span className="text-xs">{opt.label}</span>
            </label>
          ))}
          <div className="border-t pt-1 mt-1">
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-blue-600 hover:underline px-1">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConditionRow({ condition, index, onChange, onRemove, stores, drivers }) {
  const needsValue = OPERATOR_NEEDS_VALUE.includes(condition.operator);
  const isEntityField = LIST_FIELDS.includes(condition.field);

  const handleFieldChange = (v) => {
    onChange(index, 'field', v);
    // Clear value when switching field type
    onChange(index, 'value', '');
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-slate-400 w-4">{index === 0 ? 'IF' : 'AND'}</span>
      <Select value={condition.field} onValueChange={handleFieldChange}>
        <SelectTrigger className="h-8 text-xs w-36">
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {FIELD_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={condition.operator} onValueChange={(v) => onChange(index, 'operator', v)}>
        <SelectTrigger className="h-8 text-xs w-36">
          <SelectValue placeholder="Operator" />
        </SelectTrigger>
        <SelectContent>
          {OPERATOR_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {needsValue && (
        isEntityField ? (
          <EntityMultiSelect
            field={condition.field}
            value={condition.value || ''}
            onChange={(v) => onChange(index, 'value', v)}
            stores={stores}
            drivers={drivers}
          />
        ) : (
          <Input
            value={condition.value || ''}
            onChange={(e) => onChange(index, 'value', e.target.value)}
            placeholder="value"
            className="h-8 text-xs w-32"
          />
        )
      )}
      <Button size="sm" variant="ghost" onClick={() => onRemove(index)} className="h-8 w-8 p-0 text-slate-400 hover:text-red-500">
        <Trash2 className="w-3 h-3" />
      </Button>
    </div>
  );
}

// Resolve a comma-separated list of IDs to names using stores/drivers
function resolveValueLabels(field, value, stores, drivers) {
  if (!value) return null;
  if (!LIST_FIELDS.includes(field)) return `"${value}"`;
  const ids = value.split(',').map((v) => v.trim()).filter(Boolean);
  const options = field === 'store_id'
    ? stores.map((s) => ({ id: s.id, label: s.name }))
    : drivers.map((d) => ({ id: d.user_id || d.id, label: d.user_name || d.full_name || d.id }));
  const labels = ids.map((id) => options.find((o) => o.id === id)?.label || id);
  return `"${labels.join(', ')}"`;
}

export default function NotificationRulesPanel({ records, setRecords }) {
  const [editingEvent, setEditingEvent] = useState(null);
  const [draftConditions, setDraftConditions] = useState([]);
  const [draftRecipients, setDraftRecipients] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [stores, setStores] = useState([]);
  const [drivers, setDrivers] = useState([]);

  useEffect(() => {
    // Load stores and active drivers for the multi-selects
    Promise.all([
      base44.entities.Store.filter({ status: 'active' }),
      base44.entities.AppUser.filter({ status: 'active' }),
    ]).then(([storeList, appUserList]) => {
      setStores((storeList || []).sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999)));
      setDrivers((appUserList || []).filter((u) => u?.app_roles?.includes('driver')));
    }).catch(() => {});
  }, []);

  const openEditor = (eventName) => {
    const rec = records[eventName];
    setDraftConditions(rec?.trigger_conditions ? JSON.parse(JSON.stringify(rec.trigger_conditions)) : []);
    setDraftRecipients(rec?.recipients ? [...rec.recipients] : []);
    setEditingEvent(eventName);
  };

  const closeEditor = () => { setEditingEvent(null); setDraftConditions([]); setDraftRecipients([]); };

  const addCondition = () => {
    setDraftConditions((prev) => [...prev, { field: 'store_id', operator: 'in_list', value: '' }]);
  };

  const updateCondition = (index, key, value) => {
    setDraftConditions((prev) => prev.map((c, i) => i === index ? { ...c, [key]: value } : c));
  };

  const removeCondition = (index) => {
    setDraftConditions((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleRecipient = (value) => {
    setDraftRecipients((prev) =>
      prev.includes(value) ? prev.filter((r) => r !== value) : [...prev, value]
    );
  };

  const handleSave = async () => {
    const rec = records[editingEvent];
    if (!rec) return;
    setIsSaving(true);
    try {
      const updates = { trigger_conditions: draftConditions, recipients: draftRecipients };
      const updated = await base44.entities.NotificationTemplate.update(rec.id, updates);
      const merged = { ...rec, ...updates, ...updated };
      setRecords((prev) => ({ ...prev, [editingEvent]: merged }));
      applyTemplateUpdate(merged);
      closeEditor();
    } catch { alert('Failed to save rules'); } finally { setIsSaving(false); }
  };

  return (
    <div className="space-y-2">
      <Card className="mb-3">
        <CardContent className="pb-2 p-3 pt-2 my-6">
          <p className="text-xs text-slate-500">
            Define <strong>when</strong> each notification fires and <strong>who</strong> receives it.
            No conditions = always fires. Multiple conditions = ALL must pass (AND logic).
          </p>
        </CardContent>
      </Card>

      {Object.keys(records).sort().map((eventName) => {
        const rec = records[eventName];
        const label = rec?.label || formatEventLabel(eventName);
        const conditions = rec?.trigger_conditions || [];
        const recipients = rec?.recipients || [];
        const enabled = rec?.enabled ?? true;

        return (
          <div key={eventName} onClick={() => openEditor(eventName)}
            className={`border rounded-lg p-3 transition-colors cursor-pointer ${enabled ? 'bg-white hover:bg-blue-50 hover:border-blue-300' : 'bg-slate-50 opacity-60 hover:bg-slate-100'}`}>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-medium text-slate-900 text-sm">{label}</span>
                  {!enabled && <Badge className="bg-gray-100 text-gray-600 text-xs">Off</Badge>}
                </div>

                {/* Recipients */}
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {recipients.length > 0 ?
                    recipients.map((r) =>
                      <Badge key={r} className="bg-blue-50 text-blue-700 border border-blue-200 text-xs font-normal">
                        {RECIPIENT_OPTIONS.find((o) => o.value === r)?.label.replace(/^[^\s]+ /, '') || r}
                      </Badge>
                    ) :
                    <span className="text-xs text-slate-400 italic">No recipients set</span>
                  }
                </div>

                {/* Conditions summary */}
                {conditions.length === 0 ?
                  <p className="text-xs text-green-600">✓ Always fires</p> :
                  <div className="space-y-0.5">
                    {conditions.map((c, i) =>
                      <p key={i} className="text-xs text-slate-600 font-mono">
                        <span className="text-slate-400">{i === 0 ? 'IF ' : 'AND '}</span>
                        {FIELD_OPTIONS.find((f) => f.value === c.field)?.label || c.field}
                        <span className="text-slate-400"> {c.operator.replace(/_/g, ' ')} </span>
                        {c.value ? <span className="text-orange-600">{resolveValueLabels(c.field, c.value, stores, drivers)}</span> : null}
                      </p>
                    )}
                  </div>
                }
              </div>
            </div>
          </div>
        );
      })}

      {/* Edit Dialog */}
      <Dialog open={!!editingEvent} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Rules for: {records[editingEvent]?.label || formatEventLabel(editingEvent)}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            {/* Recipients */}
            <div>
              <Label className="text-xs text-slate-600 mb-2 block">Who receives this notification</Label>
              <div className="space-y-2">
                {RECIPIENT_OPTIONS.map((opt) =>
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={draftRecipients.includes(opt.value)}
                      onChange={() => toggleRecipient(opt.value)}
                      className="w-4 h-4 rounded border-slate-300" />
                    <span className="text-sm">{opt.label}</span>
                  </label>
                )}
              </div>
            </div>

            {/* Conditions */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs text-slate-600">Trigger Conditions (ALL must pass)</Label>
                <Button size="sm" variant="outline" onClick={addCondition} className="gap-1 text-xs h-7">
                  <Plus className="w-3 h-3" /> Add Condition
                </Button>
              </div>
              {draftConditions.length === 0 ?
                <p className="text-xs text-green-600 bg-green-50 rounded p-2">✓ No conditions — this notification always fires when the event occurs.</p> :
                <div className="space-y-2 bg-slate-50 rounded p-3">
                  {draftConditions.map((cond, i) =>
                    <ConditionRow key={i} condition={cond} index={i}
                      onChange={updateCondition} onRemove={removeCondition}
                      stores={stores} drivers={drivers} />
                  )}
                </div>
              }
            </div>
          </div>
          <DialogFooter className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" onClick={closeEditor}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={isSaving} className="gap-1">
              {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save Rules
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}