/**
 * MessageRuleBuilder — IF / THEN rule builder for the MessageRule entity
 *
 * Users create notification rules with:
 *   IF: trigger event + conditions (field/operator/value)
 *   THEN: channels (in_app/push) + message template + recipients
 *   Advanced: priority, stop_on_match, cooldown, shadow_mode
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Loader2, Plus, Trash2, Save, X, GripVertical, Bell, BellRing,
  Eye, EyeOff, Zap, Clock, Copy, ChevronDown, ChevronRight
} from 'lucide-react';
import { loadEnabledRules, clearRuleCache, dispatchMessageRules } from '@/components/utils/messageRuleEngine';
import { applyTemplateUpdate } from '@/components/utils/notificationRules';
import { toast } from 'sonner';

// ── Event options ─────────────────────────────────────────────────────────

const EVENT_OPTIONS = [
  { value: 'driver_accepted',         label: 'Driver Accepted',              group: 'Assignment' },
  { value: 'dispatcher_assigned_all',  label: 'Dispatcher Assigned All',      group: 'Assignment' },
  { value: 'driver_started',           label: 'Driver Started Delivery',      group: 'Delivery Status' },
  { value: 'driver_completed',         label: 'Driver Completed Delivery',    group: 'Delivery Status' },
  { value: 'driver_failed',            label: 'Driver Failed Delivery',       group: 'Delivery Status' },
  { value: 'driver_retry',             label: 'Driver Retried Delivery',      group: 'Delivery Status' },
  { value: 'driver_return',            label: 'Driver Returned Delivery',     group: 'Delivery Status' },
  { value: 'app_update_available',     label: 'App Update Available',         group: 'System' },
  { value: 'admin_broadcast',          label: 'Admin Broadcast',              group: 'System' },
  { value: 'doc_access_requested',     label: 'Document Access Requested',    group: 'Documents' },
  { value: 'doc_access_approved',     label: 'Document Access Approved',     group: 'Documents' },
];

// ── Condition field options ───────────────────────────────────────────────

const FIELD_OPTIONS = [
  { value: 'store_id',         label: 'Store',              type: 'entity' },
  { value: 'driver_id',        label: 'Driver',              type: 'entity' },
  { value: 'delivery_status',  label: 'Delivery Status',     type: 'text' },
  { value: 'signature_needed', label: 'Signature Required',  type: 'bool' },
  { value: 'first_delivery',   label: 'First Delivery',       type: 'bool' },
  { value: 'fridge_item',      label: 'Fridge Item',          type: 'bool' },
  { value: 'oversized',        label: 'Oversized',            type: 'bool' },
  { value: 'cod_total_amount_required', label: 'COD Amount', type: 'number' },
  { value: 'no_charge',        label: 'No Charge',            type: 'bool' },
  { value: 'user_role',        label: 'User Role',            type: 'text' },
  { value: 'page_context',     label: 'Page/Screen',          type: 'text' },
];

const OPERATOR_OPTIONS = [
  { value: 'equals',       label: 'equals' },
  { value: 'not_equals',   label: 'is not' },
  { value: 'greater_than', label: 'greater than' },
  { value: 'less_than',    label: 'less than' },
  { value: 'is_true',      label: 'is true' },
  { value: 'is_false',     label: 'is false' },
  { value: 'in_list',      label: 'is in list' },
  { value: 'not_in_list',  label: 'is not in list' },
];

const OPERATOR_NEEDS_VALUE = ['equals', 'not_equals', 'greater_than', 'less_than', 'in_list', 'not_in_list'];
const ENTITY_FIELDS = ['store_id', 'driver_id'];

// ── Recipient options ──────────────────────────────────────────────────────

const RECIPIENT_OPTIONS = [
  { value: 'role:admin',        label: '🔧 All Admins' },
  { value: 'role:dispatcher',  label: '📋 All Dispatchers' },
  { value: 'role:driver',       label: '🚗 All Drivers' },
  { value: 'relation:driver',   label: '🎯 Assigned Driver' },
  { value: 'relation:dispatchers', label: '🏪 Store Dispatchers' },
  { value: 'relation:appowner', label: '👑 App Owner' },
];

const CHANNEL_OPTIONS = [
  { value: 'in_app', label: 'In-App', icon: Bell },
  { value: 'push',   label: 'Push',   icon: BellRing },
];

// ── Template variable suggestions ───────────────────────────────────────────

const TEMPLATE_VARIABLES = [
  '{{driverName}}', '{{patientName}}', '{{storeName}}', '{{deliveryCount}}',
  '{{deliveryList}}', '{{status}}', '{{timestamp}}', '{{eventName}}',
];

// ── Entity multi-select ─────────────────────────────────────────────────────

function EntityMultiSelect({ field, value, onChange, stores, drivers }) {
  const [open, setOpen] = useState(false);

  const options = field === 'store_id'
    ? stores.map((s) => ({ id: s.id, label: s.name }))
    : drivers.map((d) => ({ id: d.user_id || d.id, label: d.user_name || d.full_name || d.id }));

  const selectedIds = value ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];

  const toggle = (id) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
    onChange(next.join(','));
  };

  const selectedLabels = selectedIds.map((id) => options.find((o) => o.id === id)?.label || id);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-8 text-xs border rounded-md px-2 bg-card text-left min-w-[140px] max-w-[200px] truncate flex items-center justify-between gap-1 hover:border-blue-400"
      >
        <span className="truncate">{selectedLabels.length === 0 ? 'Select…' : selectedLabels.join(', ')}</span>
        <ChevronDown className="w-3 h-3 text-muted-foreground" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 bg-popover border rounded-lg shadow-lg p-2 space-y-1 max-h-52 overflow-y-auto min-w-[180px]">
            {options.length === 0 && <p className="text-xs text-muted-foreground px-1">No options loaded</p>}
            {options.map((opt) => (
              <label key={opt.id} className="flex items-center gap-2 cursor-pointer px-1 py-0.5 hover:bg-accent rounded">
                <input type="checkbox" checked={selectedIds.includes(opt.id)} onChange={() => toggle(opt.id)} className="w-3 h-3" />
                <span className="text-xs">{opt.label}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Condition row ───────────────────────────────────────────────────────────

function ConditionRow({ condition, index, onChange, onRemove, stores, drivers }) {
  const needsValue = OPERATOR_NEEDS_VALUE.includes(condition.operator);
  const isEntityField = ENTITY_FIELDS.includes(condition.field);
  const fieldOpt = FIELD_OPTIONS.find((f) => f.value === condition.field);
  const isBoolField = fieldOpt?.type === 'bool';

  // Auto-fix operator when switching to bool field
  const handleFieldChange = (v) => {
    const newField = FIELD_OPTIONS.find((f) => f.value === v);
    if (newField?.type === 'bool') {
      onChange(index, 'operator', 'is_true');
    } else if (condition.operator === 'is_true' || condition.operator === 'is_false') {
      onChange(index, 'operator', 'equals');
    }
    onChange(index, 'field', v);
    onChange(index, 'value', '');
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs font-semibold text-muted-foreground w-8">
        {index === 0 ? 'IF' : 'AND'}
      </span>
      <Select value={condition.field} onValueChange={handleFieldChange}>
        <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="Field" /></SelectTrigger>
        <SelectContent>
          {FIELD_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={condition.operator} onValueChange={(v) => onChange(index, 'operator', v)}>
        <SelectTrigger className="h-8 text-xs w-32"><SelectValue placeholder="Op" /></SelectTrigger>
        <SelectContent>
          {OPERATOR_OPTIONS.filter((o) => {
            if (isBoolField) return ['is_true', 'is_false'].includes(o.value);
            if (fieldOpt?.type === 'number') return ['equals', 'not_equals', 'greater_than', 'less_than'].includes(o.value);
            return !['is_true', 'is_false'].includes(o.value);
          }).map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {needsValue && !isBoolField && (
        isEntityField ? (
          <EntityMultiSelect field={condition.field} value={condition.value || ''} onChange={(v) => onChange(index, 'value', v)} stores={stores} drivers={drivers} />
        ) : (
          <Input value={condition.value || ''} onChange={(e) => onChange(index, 'value', e.target.value)} placeholder="value" className="h-8 text-xs w-32" />
        )
      )}
      <Button size="sm" variant="ghost" onClick={() => onRemove(index)} className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive">
        <Trash2 className="w-3 h-3" />
      </Button>
    </div>
  );
}

// ── Rule editor dialog ──────────────────────────────────────────────────────

function RuleEditor({ open, onClose, onSave, initialRule, stores, drivers }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && initialRule) {
      setDraft(JSON.parse(JSON.stringify(initialRule)));
    } else if (open) {
      setDraft({
        event_name: '',
        rule_label: '',
        priority: 10,
        enabled: true,
        conditions: [],
        channels: ['in_app'],
        message_template: '',
        recipients: [],
        stop_on_match: true,
        cooldown_seconds: 0,
        shadow_mode: false,
      });
    }
  }, [open, initialRule]);

  if (!open || !draft) return null;

  const addCondition = () => {
    setDraft((d) => ({ ...d, conditions: [...(d.conditions || []), { field: 'store_id', operator: 'in_list', value: '' }] }));
  };

  const updateCondition = (idx, key, val) => {
    setDraft((d) => ({ ...d, conditions: d.conditions.map((c, i) => i === idx ? { ...c, [key]: val } : c) }));
  };

  const removeCondition = (idx) => {
    setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, i) => i !== idx) }));
  };

  const toggleRecipient = (val) => {
    setDraft((d) => ({
      ...d,
      recipients: d.recipients.includes(val) ? d.recipients.filter((r) => r !== val) : [...d.recipients, val]
    }));
  };

  const toggleChannel = (val) => {
    setDraft((d) => ({
      ...d,
      channels: d.channels.includes(val) ? d.channels.filter((c) => c !== val) : [...d.channels, val]
    }));
  };

  const insertVariable = (varStr) => {
    setDraft((d) => ({ ...d, message_template: (d.message_template || '') + varStr }));
  };

  const handleSave = async () => {
    if (!draft.event_name) { toast.error('Please select an event'); return; }
    if (!draft.rule_label?.trim()) { toast.error('Please enter a rule name'); return; }
    if (draft.channels.length === 0) { toast.error('Select at least one channel'); return; }
    if (draft.recipients.length === 0) { toast.error('Select at least one recipient'); return; }
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialRule ? 'Edit Rule' : 'Create New Message Rule'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* ── Basic info ──────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Rule Name</Label>
              <Input value={draft.rule_label} onChange={(e) => setDraft({ ...draft, rule_label: e.target.value })} placeholder="e.g. Notify Main Pharmacy driver" className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Trigger Event</Label>
              <Select value={draft.event_name} onValueChange={(v) => setDraft({ ...draft, event_name: v })}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select event…" /></SelectTrigger>
                <SelectContent>
                  {[...new Set(EVENT_OPTIONS.map((e) => e.group))].map((group) => (
                    <div key={group}>
                      <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">{group}</div>
                      {EVENT_OPTIONS.filter((e) => e.group === group).map((e) => (
                        <SelectItem key={e.value} value={e.value} className="text-sm">{e.label}</SelectItem>
                      ))}
                    </div>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── IF section ──────────────────────────────────────────── */}
          <div className="rounded-lg border bg-card p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold">IF</span>
                <span className="text-xs text-muted-foreground">— conditions that must be true (AND logic)</span>
              </div>
              <Button size="sm" variant="outline" onClick={addCondition} className="h-7 text-xs gap-1">
                <Plus className="w-3 h-3" /> Add Condition
              </Button>
            </div>
            {(!draft.conditions || draft.conditions.length === 0) ? (
              <p className="text-xs text-muted-foreground italic py-1">No conditions — this rule always fires for this event</p>
            ) : (
              draft.conditions.map((cond, i) => (
                <ConditionRow key={i} condition={cond} index={i} onChange={updateCondition} onRemove={removeCondition} stores={stores} drivers={drivers} />
              ))
            )}
          </div>

          {/* ── THEN section ───────────────────────────────────────── */}
          <div className="rounded-lg border bg-card p-3 space-y-3">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold">THEN</span>
              <span className="text-xs text-muted-foreground">— what to do when conditions pass</span>
            </div>

            {/* Channels */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Send via</Label>
              <div className="flex gap-2">
                {CHANNEL_OPTIONS.map((ch) => {
                  const Icon = ch.icon;
                  const active = draft.channels.includes(ch.value);
                  return (
                    <button
                      key={ch.value}
                      type="button"
                      onClick={() => toggleChannel(ch.value)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                        active ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-input hover:bg-accent'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" /> {ch.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Message template */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Message Template</Label>
              <Textarea
                value={draft.message_template}
                onChange={(e) => setDraft({ ...draft, message_template: e.target.value })}
                placeholder="Enter message… use {{driverName}}, {{patientName}}, etc."
                className="text-sm min-h-[60px]"
              />
              <div className="flex flex-wrap gap-1 mt-1.5">
                {TEMPLATE_VARIABLES.map((v) => (
                  <button key={v} type="button" onClick={() => insertVariable(v)}
                    className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-accent border">
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* Recipients */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Send to</Label>
              <div className="flex flex-wrap gap-2">
                {RECIPIENT_OPTIONS.map((r) => {
                  const active = draft.recipients.includes(r.value);
                  return (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => toggleRecipient(r.value)}
                      className={`px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                        active ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-input hover:bg-accent'
                      }`}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── Advanced settings ──────────────────────────────────── */}
          <div className="rounded-lg border bg-card p-3 space-y-3">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold">Advanced</span>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Priority</Label>
                <Input type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: parseInt(e.target.value) || 10 })} className="h-8 text-sm" />
                <p className="text-xs text-muted-foreground mt-0.5">Lower = evaluated first</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Cooldown (sec)</Label>
                <Input type="number" value={draft.cooldown_seconds} onChange={(e) => setDraft({ ...draft, cooldown_seconds: parseInt(e.target.value) || 0 })} className="h-8 text-sm" />
                <p className="text-xs text-muted-foreground mt-0.5">Min time between fires</p>
              </div>
              <div className="flex flex-col justify-end gap-2 pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Switch checked={draft.stop_on_match} onCheckedChange={(v) => setDraft({ ...draft, stop_on_match: v })} />
                  <span className="text-xs">Stop on match</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Switch checked={draft.shadow_mode} onCheckedChange={(v) => setDraft({ ...draft, shadow_mode: v })} />
                  <span className="text-xs flex items-center gap-1">
                    {draft.shadow_mode ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    Shadow mode
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {initialRule ? 'Update' : 'Create'} Rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rule card ────────────────────────────────────────────────────────────────

function RuleCard({ rule, onEdit, onDelete, onToggle, onDuplicate, stores, drivers }) {
  const eventLabel = EVENT_OPTIONS.find((e) => e.value === rule.event_name)?.label || rule.event_name;
  const [expanded, setExpanded] = useState(false);

  const recipientLabels = (rule.recipients || []).map((r) => {
    const opt = RECIPIENT_OPTIONS.find((o) => o.value === r);
    if (opt) return opt.label;
    if (r.startsWith('user:')) return `User: ${r.slice(5)}`;
    return r;
  });

  const condSummary = (rule.conditions || []).length === 0
    ? 'Always fires'
    : (rule.conditions || []).map((c) => {
        const field = FIELD_OPTIONS.find((f) => f.value === c.field)?.label || c.field;
        const op = OPERATOR_OPTIONS.find((o) => o.value === c.operator)?.label || c.operator;
        let val = c.value;
        if (ENTITY_FIELDS.includes(c.field) && val) {
          const ids = val.split(',').map((v) => v.trim());
          const opts = c.field === 'store_id'
            ? stores.map((s) => ({ id: s.id, label: s.name }))
            : drivers.map((d) => ({ id: d.user_id || d.id, label: d.user_name || d.id }));
          val = ids.map((id) => opts.find((o) => o.id === id)?.label || id).join(', ');
        }
        return `${field} ${op}${val ? ` ${val}` : ''}`;
      }).join(' AND ');

  return (
    <div className={`rounded-lg border bg-card p-3 transition-all ${!rule.enabled ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">{rule.rule_label}</span>
            <Badge variant="outline" className="text-xs shrink-0">{eventLabel}</Badge>
            {rule.shadow_mode && <Badge variant="outline" className="text-xs shrink-0 bg-amber-50 border-amber-300 text-amber-700"><Eye className="w-2.5 h-2.5 mr-1" />Shadow</Badge>}
            {rule.cooldown_seconds > 0 && <Badge variant="outline" className="text-xs shrink-0"><Clock className="w-2.5 h-2.5 mr-1" />{rule.cooldown_seconds}s</Badge>}
            <Badge variant="outline" className="text-xs shrink-0">#{rule.priority || 10}</Badge>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            <span className="font-medium">IF:</span> {condSummary}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            <span className="font-medium">THEN:</span> {(rule.channels || []).join(' + ')} → {recipientLabels.join(', ')}
          </div>
          {expanded && (
            <div className="mt-2 pt-2 border-t text-xs text-muted-foreground">
              <div><span className="font-medium">Message:</span> <span className="italic">"{rule.message_template || '(empty)'}"</span></div>
              <div className="mt-1"><span className="font-medium">Stop on match:</span> {rule.stop_on_match ? 'Yes' : 'No'}</div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Switch checked={rule.enabled} onCheckedChange={() => onToggle(rule)} />
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setExpanded((e) => !e)}>
            {expanded ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => onEdit(rule)}>
            <Zap className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => onDuplicate(rule)}>
            <Copy className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => onDelete(rule)}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function MessageRuleBuilder() {
  const [rules, setRules] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [stores, setStores] = useState([]);
  const [drivers, setDrivers] = useState([]);

  const loadRules = useCallback(async () => {
    setIsLoading(true);
    try {
      const all = await base44.entities.MessageRule.list('priority', 200);
      setRules(all || []);
    } catch (e) {
      console.error('[MessageRuleBuilder] Load failed:', e);
      toast.error('Failed to load message rules');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
    Promise.all([
      base44.entities.Store.filter({ status: 'active' }),
      base44.entities.AppUser.filter({ status: 'active' }),
    ]).then(([storeList, appUserList]) => {
      setStores((storeList || []).sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999)));
      setDrivers((appUserList || []).filter((u) => u?.app_roles?.includes('driver')));
    }).catch(() => {});

    // Live subscription
    let unsub = () => {};
    try {
      unsub = base44.entities.MessageRule.subscribe((event) => {
        loadRules();
      });
    } catch {}
    return () => { try { unsub(); } catch {} };
  }, [loadRules]);

  const handleSave = async (draft) => {
    try {
      if (draft.id) {
        const updated = await base44.entities.MessageRule.update(draft.id, draft);
        setRules((prev) => prev.map((r) => r.id === draft.id ? { ...r, ...draft, ...updated } : r));
        toast.success('Rule updated');
      } else {
        const created = await base44.entities.MessageRule.create(draft);
        setRules((prev) => [...prev, created]);
        toast.success('Rule created');
      }
      clearRuleCache();
      setShowEditor(false);
      setEditingRule(null);
    } catch (e) {
      console.error('[MessageRuleBuilder] Save failed:', e);
      toast.error('Failed to save rule: ' + (e?.message || e));
    }
  };

  const handleToggle = async (rule) => {
    try {
      const updated = await base44.entities.MessageRule.update(rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: !rule.enabled, ...updated } : r));
      clearRuleCache();
    } catch { toast.error('Failed to toggle rule'); }
  };

  const handleDelete = async (rule) => {
    if (!confirm(`Delete rule "${rule.rule_label}"?`)) return;
    try {
      await base44.entities.MessageRule.delete(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      clearRuleCache();
      toast.success('Rule deleted');
    } catch { toast.error('Failed to delete rule'); }
  };

  const handleDuplicate = async (rule) => {
    const copy = { ...rule, id: undefined, rule_label: `${rule.rule_label} (copy)`, priority: (rule.priority || 10) + 1, enabled: false };
    delete copy.id; delete copy.created_date; delete copy.updated_date;
    try {
      const created = await base44.entities.MessageRule.create(copy);
      setRules((prev) => [...prev, created]);
      clearRuleCache();
      toast.success('Rule duplicated (disabled by default)');
    } catch { toast.error('Failed to duplicate rule'); }
  };

  // Group rules by event for display
  const rulesByEvent = useMemo(() => {
    const grouped = {};
    rules.forEach((r) => {
      const key = r.event_name || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(r);
    });
    return grouped;
  }, [rules]);

  const sortedEvents = Object.keys(rulesByEvent).sort((a, b) => {
    const aIdx = EVENT_OPTIONS.findIndex((e) => e.value === a);
    const bIdx = EVENT_OPTIONS.findIndex((e) => e.value === b);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  if (isLoading) {
    return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Loading message rules…</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm">Message Rules (IF / THEN)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Build conditional notification rules. Old "Messages" tab still works as fallback — rules here take priority.
          </p>
        </div>
        <Button size="sm" onClick={() => { setEditingRule(null); setShowEditor(true); }} className="gap-1.5">
          <Plus className="w-4 h-4" /> New Rule
        </Button>
      </div>

      {/* Empty state */}
      {rules.length === 0 && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
          <BellRing className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm font-medium">No message rules yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create your first IF / THEN rule to start sending conditional notifications.</p>
          <Button size="sm" className="mt-3 gap-1.5" onClick={() => { setEditingRule(null); setShowEditor(true); }}>
            <Plus className="w-4 h-4" /> Create First Rule
          </Button>
        </div>
      )}

      {/* Rules grouped by event */}
      {sortedEvents.map((eventKey) => (
        <div key={eventKey} className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
              {EVENT_OPTIONS.find((e) => e.value === eventKey)?.label || eventKey}
            </h4>
            <Badge variant="outline" className="text-xs">{rulesByEvent[eventKey].length}</Badge>
          </div>
          {rulesByEvent[eventKey].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999)).map((rule) => (
            <RuleCard key={rule.id} rule={rule} onEdit={(r) => { setEditingRule(r); setShowEditor(true); }}
              onDelete={handleDelete} onToggle={handleToggle} onDuplicate={handleDuplicate} stores={stores} drivers={drivers} />
          ))}
        </div>
      ))}

      <RuleEditor open={showEditor} onClose={() => { setShowEditor(false); setEditingRule(null); }}
        onSave={handleSave} initialRule={editingRule} stores={stores} drivers={drivers} />
    </div>
  );
}
