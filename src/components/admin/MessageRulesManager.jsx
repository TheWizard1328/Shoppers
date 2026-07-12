import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Save, Bell, MessageSquare, RotateCcw, Loader2 } from 'lucide-react';
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
  const [records, setRecords]         = useState({});
  const [isLoading, setIsLoading]     = useState(true);
  const [isSaving, setIsSaving]       = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [editDraft, setEditDraft]     = useState(null);

  useEffect(() => {
    loadTemplates();

    const unsubscribe = base44.entities.NotificationTemplate.subscribe((event) => {
      if (!event?.data?.event_name) return;
      setRecords(prev => {
        if (event.type === 'delete') {
          const next = { ...prev };
          delete next[event.data.event_name];
          return next;
        }
        return { ...prev, [event.data.event_name]: { ...(prev[event.data.event_name] || {}), ...event.data } };
      });
    });

    return () => { try { unsubscribe(); } catch {} };
  }, []);

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

  const handleToggle = async (eventName, field, e) => {
    e?.stopPropagation();
    const rec = records[eventName];
    if (!rec) return;
    const newVal = !rec[field];
    setIsSaving(`${eventName}_${field}`);
    try {
      const updated = await base44.entities.NotificationTemplate.update(rec.id, { [field]: newVal });
      const merged = { ...rec, [field]: newVal, ...updated };
      setRecords(prev => ({ ...prev, [eventName]: merged }));
      applyTemplateUpdate(merged);
    } catch {
      alert('Failed to save change');
    } finally {
      setIsSaving(null);
    }
  };

  const handleCardClick = (eventName) => {
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

  const handleReset = async (e) => {
    e?.stopPropagation();
    if (!editingEvent) return;
    if (!confirm('Reset this message to its default template?')) return;
    const rec = records[editingEvent];
    if (!rec) return;
    const resetFields = {
      message_template: getHardcodedDefault(editingEvent),
      enabled:          true,
      in_app_enabled:   true,
      push_enabled:     false,
    };
    setIsSaving(editingEvent);
    try {
      const updated = await base44.entities.NotificationTemplate.update(rec.id, resetFields);
      const merged = { ...rec, ...resetFields, ...updated };
      setRecords(prev => ({ ...prev, [editingEvent]: merged }));
      applyTemplateUpdate(merged);
      setEditDraft(resetFields);
    } finally {
      setIsSaving(null);
    }
  };

  const closeDialog = () => {
    setEditingEvent(null);
    setEditDraft(null);
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

      {/* Rules list */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Rules</CardTitle>
          <p className="text-sm text-slate-500">Click a card to edit. Use toggles to quickly enable/disable channels.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {EVENT_ORDER.map(eventName => {
            const rec      = records[eventName];
            const label    = EVENT_LABELS[eventName] || eventName;
            const enabled  = rec?.enabled          ?? true;
            const inApp    = rec?.in_app_enabled   ?? true;
            const push     = rec?.push_enabled      ?? false;
            const template = rec?.message_template || getHardcodedDefault(eventName);

            return (
              <div
                key={eventName}
                onClick={() => handleCardClick(eventName)}
                className="border rounded-lg p-4 bg-slate-50 hover:bg-slate-100 hover:border-blue-300 cursor-pointer transition-colors"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900 text-sm">{label}</span>
                    {!enabled && <Badge className="bg-gray-100 text-gray-600 text-xs">Disabled</Badge>}
                  </div>
                  <p className="text-xs text-slate-500 italic truncate">"{buildSampleMessage(template)}"</p>

                  <div className="flex items-center gap-4" onClick={e => e.stopPropagation()}>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <Switch checked={enabled} onCheckedChange={(_, e) => handleToggle(eventName, 'enabled', e)} disabled={!!isSaving} onClick={e => e.stopPropagation()} />
                      <span className={`text-xs ${enabled ? 'text-slate-700' : 'text-slate-400'}`}>On/Off</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <Switch checked={inApp} onCheckedChange={(_, e) => handleToggle(eventName, 'in_app_enabled', e)} disabled={!!isSaving} onClick={e => e.stopPropagation()} />
                      <span className={`text-xs flex items-center gap-1 ${inApp ? 'text-blue-600' : 'text-slate-400'}`}>
                        <MessageSquare className="w-3 h-3" /> In-App
                      </span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <Switch checked={push} onCheckedChange={(_, e) => handleToggle(eventName, 'push_enabled', e)} disabled={!!isSaving} onClick={e => e.stopPropagation()} />
                      <span className={`text-xs flex items-center gap-1 ${push ? 'text-purple-600' : 'text-slate-400'}`}>
                        <Bell className="w-3 h-3" /> Push
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingEvent} onOpenChange={open => { if (!open) closeDialog(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{EVENT_LABELS[editingEvent] || editingEvent}</DialogTitle>
          </DialogHeader>

          {editDraft && (
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-xs text-slate-600 mb-1 block">Message Template</Label>
                <Textarea
                  value={editDraft.message_template}
                  onChange={e => setEditDraft(d => ({ ...d, message_template: e.target.value }))}
                  rows={4}
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
            </div>
          )}

          <DialogFooter className="flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={handleReset} disabled={!!isSaving} className="text-slate-400 hover:text-red-500 gap-1">
              <RotateCcw className="w-3 h-3" /> Reset to default
            </Button>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={closeDialog}>Cancel</Button>
              <Button size="sm" onClick={handleEditSave} disabled={!!isSaving} className="gap-1">
                {isSaving === editingEvent ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}