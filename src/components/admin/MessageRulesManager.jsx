import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Save, X, Edit2, Bell, MessageSquare, RotateCcw, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { notificationRules, applyTemplateUpdate } from '@/components/utils/notificationRules';

const EVENT_LABELS = {
  driver_accepted_all:    'Driver Accepted All',
  driver_accepted_one:    'Driver Accepted One',
  dispatcher_assigned_all:'Dispatcher Assigned All',
  driver_started:         'Driver Started',
  driver_completed:       'Driver Completed',
  driver_failed:          'Driver Failed',
  driver_retry:           'Driver Retry',
  driver_return:          'Driver Return',
};

const EVENT_ORDER = [
  'driver_accepted_all',
  'driver_accepted_one',
  'dispatcher_assigned_all',
  'driver_started',
  'driver_completed',
  'driver_failed',
  'driver_retry',
  'driver_return',
];

const SAMPLE_DATA = {
  driverName: 'John D.',
  patientName: 'Jane Smith',
  storeName: 'Main Pharmacy',
  deliveryList: '\n• Jane Smith\n• Bob Wilson',
};

function buildSampleMessage(template = '') {
  return template
    .replace(/\{\{driverName\}\}/g,   SAMPLE_DATA.driverName)
    .replace(/\{\{patientName\}\}/g,  SAMPLE_DATA.patientName)
    .replace(/\{\{storeName\}\}/g,    SAMPLE_DATA.storeName)
    .replace(/\{\{deliveryList\}\}/g, SAMPLE_DATA.deliveryList);
}

function getHardcodedDefault(eventName) {
  const rule = notificationRules[eventName];
  if (!rule?.buildMessage) return '';
  return rule.buildMessage({
    driverName:   '{{driverName}}',
    patientName:  '{{patientName}}',
    storeName:    '{{storeName}}',
    deliveryList: '{{deliveryList}}',
  });
}

export default function MessageRulesManager() {
  // records: { [event_name]: entity record }
  const [records, setRecords]         = useState({});
  const [isLoading, setIsLoading]     = useState(true);
  const [isSaving, setIsSaving]       = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [editDraft, setEditDraft]     = useState(null);

  useEffect(() => { loadTemplates(); }, []);

  const loadTemplates = async () => {
    setIsLoading(true);
    try {
      const list = await base44.entities.NotificationTemplate.list();
      const map = {};
      (list || []).forEach(r => { if (r?.event_name) map[r.event_name] = r; });
      setRecords(map);
    } catch (e) {
      console.error('Error loading notification templates:', e);
    } finally {
      setIsLoading(false);
    }
  };

  // Quick inline toggle (enabled / in_app_enabled / push_enabled)
  const handleToggle = async (eventName, field) => {
    const rec = records[eventName];
    if (!rec) return;
    const newVal = !rec[field];
    setIsSaving(`${eventName}_${field}`);
    try {
      const updated = await base44.entities.NotificationTemplate.update(rec.id, { [field]: newVal });
      const merged = { ...rec, [field]: newVal, ...updated };
      setRecords(prev => ({ ...prev, [eventName]: merged }));
      applyTemplateUpdate(merged);
    } catch (e) {
      alert('Failed to save change');
    } finally {
      setIsSaving(null);
    }
  };

  const handleEditOpen = (eventName) => {
    const rec = records[eventName];
    setEditDraft({
      message_template: rec?.message_template || getHardcodedDefault(eventName),
      enabled:          rec?.enabled          ?? true,
      in_app_enabled:   rec?.in_app_enabled   ?? true,
      push_enabled:     rec?.push_enabled      ?? false,
    });
    setEditingEvent(eventName);
  };

  const handleEditSave = async () => {
    const rec = records[editingEvent];
    if (!rec) return;
    setIsSaving(editingEvent);
    try {
      const updated = await base44.entities.NotificationTemplate.update(rec.id, editDraft);
      const merged = { ...rec, ...editDraft, ...updated };
      setRecords(prev => ({ ...prev, [editingEvent]: merged }));
      applyTemplateUpdate(merged);
      setEditingEvent(null);
      setEditDraft(null);
    } catch {
      alert('Failed to save rule');
    } finally {
      setIsSaving(null);
    }
  };

  const handleReset = async (eventName) => {
    if (!confirm('Reset this message to its default template?')) return;
    const rec = records[eventName];
    if (!rec) return;
    const defaultTemplate = getHardcodedDefault(eventName);
    const resetFields = {
      message_template: defaultTemplate,
      enabled:          true,
      in_app_enabled:   true,
      push_enabled:     false,
    };
    setIsSaving(eventName);
    try {
      const updated = await base44.entities.NotificationTemplate.update(rec.id, resetFields);
      const merged = { ...rec, ...resetFields, ...updated };
      setRecords(prev => ({ ...prev, [eventName]: merged }));
      applyTemplateUpdate(merged);
    } finally {
      setIsSaving(null);
    }
  };

  if (isLoading) {
    return <div className="flex items-center gap-2 p-6 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" />Loading notification rules...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Variables reference */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-slate-600">Available Template Variables</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 text-xs">
            {['{{driverName}}', '{{patientName}}', '{{storeName}}', '{{deliveryList}}'].map(v => (
              <code key={v} className="bg-slate-100 px-2 py-1 rounded text-slate-700">{v}</code>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Rules table */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Rules</CardTitle>
          <p className="text-sm text-slate-500">Toggle or customize when and how each notification is sent.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {EVENT_ORDER.map(eventName => {
            const rec      = records[eventName];
            const label    = EVENT_LABELS[eventName] || eventName;
            const enabled  = rec?.enabled          ?? true;
            const inApp    = rec?.in_app_enabled   ?? true;
            const push     = rec?.push_enabled      ?? false;
            const template = rec?.message_template || getHardcodedDefault(eventName);
            const isEditing = editingEvent === eventName;

            return (
              <div key={eventName} className={`border rounded-lg p-4 transition-colors ${isEditing ? 'border-blue-300 bg-blue-50' : 'bg-slate-50'}`}>
                {isEditing ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-900">{label}</h3>
                      <Button size="sm" variant="ghost" onClick={() => { setEditingEvent(null); setEditDraft(null); }}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>

                    <div>
                      <Label className="text-xs text-slate-600 mb-1 block">Message Template</Label>
                      <Textarea
                        value={editDraft.message_template}
                        onChange={e => setEditDraft(d => ({ ...d, message_template: e.target.value }))}
                        rows={3}
                        className="text-sm"
                        placeholder="Use {{driverName}}, {{patientName}}, etc."
                      />
                      <p className="text-xs text-slate-400 mt-1">
                        Preview: <em>"{buildSampleMessage(editDraft.message_template)}"</em>
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-6">
                      <div className="flex items-center gap-2">
                        <Switch checked={editDraft.enabled} onCheckedChange={v => setEditDraft(d => ({ ...d, enabled: v }))} />
                        <Label className="text-sm">Enabled</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={editDraft.in_app_enabled} onCheckedChange={v => setEditDraft(d => ({ ...d, in_app_enabled: v }))} />
                        <Label className="text-sm flex items-center gap-1"><MessageSquare className="w-3 h-3" /> In-App</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={editDraft.push_enabled} onCheckedChange={v => setEditDraft(d => ({ ...d, push_enabled: v }))} />
                        <Label className="text-sm flex items-center gap-1"><Bell className="w-3 h-3" /> Push</Label>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleEditSave} disabled={isSaving === eventName} className="gap-1">
                        {isSaving === eventName ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                        Save
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setEditingEvent(null); setEditDraft(null); }}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-medium text-slate-900 text-sm">{label}</span>
                        {!enabled && <Badge className="bg-gray-100 text-gray-600 text-xs">Disabled</Badge>}
                      </div>
                      <p className="text-xs text-slate-500 italic truncate">"{buildSampleMessage(template)}"</p>
                      <div className="flex gap-3 mt-2">
                        <span className={`text-xs flex items-center gap-1 ${inApp ? 'text-blue-600' : 'text-slate-400'}`}>
                          <MessageSquare className="w-3 h-3" /> In-App {inApp ? 'On' : 'Off'}
                        </span>
                        <span className={`text-xs flex items-center gap-1 ${push ? 'text-purple-600' : 'text-slate-400'}`}>
                          <Bell className="w-3 h-3" /> Push {push ? 'On' : 'Off'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Switch
                        checked={enabled}
                        onCheckedChange={() => handleToggle(eventName, 'enabled')}
                        disabled={!!isSaving?.startsWith(eventName)}
                        title="Master toggle"
                      />
                      <Button size="sm" variant="outline" onClick={() => handleEditOpen(eventName)} className="gap-1 text-xs px-2">
                        <Edit2 className="w-3 h-3" /> Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleReset(eventName)} className="text-slate-400 hover:text-red-500 px-2" title="Reset to defaults" disabled={!!isSaving?.startsWith(eventName)}>
                        <RotateCcw className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}