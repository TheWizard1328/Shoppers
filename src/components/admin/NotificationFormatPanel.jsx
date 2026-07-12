import React, { useState, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Save, Bell, MessageSquare, RotateCcw, Loader2, FlaskConical, CheckCircle, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { notificationRules, applyTemplateUpdate } from '@/components/utils/notificationRules';

const formatEventLabel = (eventName) =>
  eventName ? eventName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : '';

const TEMPLATE_VARIABLES = [
  '{{driverName}}', '{{patientName}}', '{{storeName}}', '{{deliveryList}}', '{{pendingCount}}', '{{periodLabel}}',
];

const SAMPLE_DATA = {
  driverName: 'John D.', patientName: 'Jane Smith', storeName: 'Main Pharmacy',
  deliveryList: '\n• Jane Smith\n• Bob Wilson', pendingCount: '3', periodLabel: 'June 1–15',
};

function buildSampleMessage(template = '') {
  return Object.entries(SAMPLE_DATA).reduce(
    (msg, [key, val]) => msg.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val),
    template
  );
}

function getHardcodedDefault(eventName) {
  const rule = notificationRules[eventName];
  if (!rule?.buildMessage) return '';
  return rule.buildMessage({
    driverName: '{{driverName}}', patientName: '{{patientName}}',
    storeName: '{{storeName}}', deliveryList: '{{deliveryList}}',
  });
}

export default function NotificationFormatPanel({ records, setRecords, currentUser }) {
  const [isSaving, setIsSaving] = useState(null);
  const [isTesting, setIsTesting] = useState(null);
  const [testSuccess, setTestSuccess] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const textareaRef = useRef(null);

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
    } catch { alert('Failed to save change'); }
    finally { setIsSaving(null); }
  };

  const handleCardClick = (eventName) => {
    const rec = records[eventName];
    setEditDraft({
      label: rec?.label || formatEventLabel(eventName),
      message_template: rec?.message_template || getHardcodedDefault(eventName),
      enabled: rec?.enabled ?? true,
      in_app_enabled: rec?.in_app_enabled ?? true,
      push_enabled: rec?.push_enabled ?? false,
    });
    setEditingEvent(eventName);
    setTestSuccess(null);
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
    } catch { alert('Failed to save rule'); }
    finally { setIsSaving(null); }
  };

  const handleReset = async () => {
    if (!editingEvent || !confirm('Reset this message to its default template?')) return;
    const rec = records[editingEvent];
    if (!rec) return;
    const resetFields = {
      label: formatEventLabel(editingEvent),
      message_template: getHardcodedDefault(editingEvent),
      enabled: true, in_app_enabled: true, push_enabled: false,
    };
    setIsSaving(editingEvent);
    try {
      const updated = await base44.entities.NotificationTemplate.update(rec.id, resetFields);
      const merged = { ...rec, ...resetFields, ...updated };
      setRecords(prev => ({ ...prev, [editingEvent]: merged }));
      applyTemplateUpdate(merged);
      setEditDraft(resetFields);
    } finally { setIsSaving(null); }
  };

  const insertVariable = (variable) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newVal = editDraft.message_template.slice(0, start) + variable + editDraft.message_template.slice(end);
    setEditDraft(d => ({ ...d, message_template: newVal }));
    requestAnimationFrame(() => {
      textarea.focus();
      const pos = start + variable.length;
      textarea.setSelectionRange(pos, pos);
    });
  };

  const sendTestMessage = async (eventName, templateOverride = null) => {
    if (!currentUser?.id) { alert('Could not determine current user.'); return; }
    const rec = records[eventName];
    const template = templateOverride ?? rec?.message_template ?? getHardcodedDefault(eventName);
    const preview = buildSampleMessage(template);
    if (!preview) { alert('No message to test.'); return; }
    setIsTesting(eventName);
    setTestSuccess(null);
    try {
      const eventLabel = records[eventName]?.label || formatEventLabel(eventName);
      await base44.entities.Message.create({
        sender_id: currentUser.id, sender_name: 'System Test',
        receiver_id: currentUser.id, receiver_name: currentUser.full_name || 'You',
        conversation_id: [currentUser.id, 'system_test'].join('_'),
        content: `[TEST — ${eventLabel}]\n${preview}`, read: false,
      });
      await base44.functions.invoke('sendPushNotification', {
        user_id: currentUser.id, title: `[TEST] ${eventLabel}`, body: preview, url: '/',
      });
      setTestSuccess(eventName);
      setTimeout(() => setTestSuccess(null), 3000);
    } catch (e) { alert('Test failed: ' + (e?.message || e)); }
    finally { setIsTesting(null); }
  };

  const closeDialog = () => { setEditingEvent(null); setEditDraft(null); setTestSuccess(null); };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-slate-600">Template Variables</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 text-xs">
            {TEMPLATE_VARIABLES.map(v => (
              <code key={v} className="bg-slate-100 px-2 py-1 rounded text-slate-700">{v}</code>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {Object.keys(records).sort().map(eventName => {
          const rec = records[eventName];
          const label = rec?.label || formatEventLabel(eventName);
          const enabled = rec?.enabled ?? true;
          const inApp = rec?.in_app_enabled ?? true;
          const push = rec?.push_enabled ?? false;
          const template = rec?.message_template || getHardcodedDefault(eventName);
          const isTestingThis = isTesting === eventName;
          const testOk = testSuccess === eventName;

          return (
            <div key={eventName} onClick={() => handleCardClick(eventName)}
              className="border rounded-lg p-3 bg-slate-50 hover:bg-slate-100 hover:border-blue-300 cursor-pointer transition-colors">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900 text-sm">{label}</span>
                  {!enabled && <Badge className="bg-gray-100 text-gray-600 text-xs">Off</Badge>}
                </div>
                <Button size="sm" variant="outline" disabled={isTestingThis}
                  onClick={e => { e.stopPropagation(); sendTestMessage(eventName); }}
                  className={`gap-1 text-xs px-2 h-7 ${testOk ? 'border-green-500 text-green-600' : 'text-slate-500'}`}>
                  {isTestingThis ? <Loader2 className="w-3 h-3 animate-spin" /> : testOk ? <CheckCircle className="w-3 h-3" /> : <FlaskConical className="w-3 h-3" />}
                  {testOk ? 'Sent!' : 'Test'}
                </Button>
              </div>
              <p className="text-xs text-slate-500 italic truncate mb-2">"{buildSampleMessage(template)}"</p>
              <div className="flex items-center gap-4" onClick={e => e.stopPropagation()}>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Switch checked={enabled} onCheckedChange={() => handleToggle(eventName, 'enabled')} disabled={!!isSaving} onClick={e => e.stopPropagation()} />
                  <span className={`text-xs ${enabled ? 'text-slate-700' : 'text-slate-400'}`}>On/Off</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Switch checked={inApp} onCheckedChange={() => handleToggle(eventName, 'in_app_enabled')} disabled={!!isSaving} onClick={e => e.stopPropagation()} />
                  <span className={`text-xs flex items-center gap-1 ${inApp ? 'text-blue-600' : 'text-slate-400'}`}><MessageSquare className="w-3 h-3" /> In-App</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Switch checked={push} onCheckedChange={() => handleToggle(eventName, 'push_enabled')} disabled={!!isSaving} onClick={e => e.stopPropagation()} />
                  <span className={`text-xs flex items-center gap-1 ${push ? 'text-purple-600' : 'text-slate-400'}`}><Bell className="w-3 h-3" /> Push</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={!!editingEvent} onOpenChange={open => { if (!open) closeDialog(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editDraft?.label || formatEventLabel(editingEvent)}</DialogTitle>
          </DialogHeader>
          {editDraft && (
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-xs text-slate-600 mb-1 block">Title / Label</Label>
                <Input value={editDraft.label} onChange={e => setEditDraft(d => ({ ...d, label: e.target.value }))} className="text-sm" />
              </div>
              <div>
                <Label className="text-xs text-slate-600 mb-1 block">Message Template</Label>
                <Textarea ref={textareaRef} value={editDraft.message_template}
                  onChange={e => setEditDraft(d => ({ ...d, message_template: e.target.value }))}
                  rows={4} className="text-sm" />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {TEMPLATE_VARIABLES.map(v => (
                    <button key={v} type="button" onClick={() => insertVariable(v)}
                      className="bg-slate-100 hover:bg-blue-100 hover:text-blue-700 text-slate-600 text-xs px-2 py-0.5 rounded border border-slate-200 hover:border-blue-300 transition-colors cursor-pointer font-mono">
                      {v}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-400 mt-2">Preview: <em>"{buildSampleMessage(editDraft.message_template)}"</em></p>
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
          <DialogFooter className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={handleReset} disabled={!!isSaving} className="text-slate-400 hover:text-orange-500 gap-1">
                <RotateCcw className="w-3 h-3" /> Reset
              </Button>
              <Button size="sm" variant="outline" disabled={!!isTesting}
                onClick={() => sendTestMessage(editingEvent, editDraft?.message_template)}
                className={`gap-1 ${testSuccess === editingEvent ? 'border-green-500 text-green-600' : 'text-slate-600'}`}>
                {isTesting === editingEvent ? <Loader2 className="w-3 h-3 animate-spin" /> : testSuccess === editingEvent ? <CheckCircle className="w-3 h-3" /> : <FlaskConical className="w-3 h-3" />}
                {testSuccess === editingEvent ? 'Sent!' : 'Test'}
              </Button>
            </div>
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