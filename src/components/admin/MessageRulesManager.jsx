import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Save, X, Edit2, Bell, MessageSquare, RotateCcw, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { NOTIFICATION_EVENTS, notificationRules } from '@/components/utils/notificationRules';

const SETTING_KEY = 'push_notification_rules';

const EVENT_LABELS = {
  [NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ALL]:    'Driver Accepted All',
  [NOTIFICATION_EVENTS.DRIVER_ACCEPTED_ONE]:    'Driver Accepted One',
  [NOTIFICATION_EVENTS.DISPATCHER_ASSIGNED_ALL]:'Dispatcher Assigned All',
  [NOTIFICATION_EVENTS.DRIVER_STARTED]:         'Driver Started',
  [NOTIFICATION_EVENTS.DRIVER_COMPLETED]:       'Driver Completed',
  [NOTIFICATION_EVENTS.DRIVER_FAILED]:          'Driver Failed',
  [NOTIFICATION_EVENTS.DRIVER_RETRY]:           'Driver Retry',
  [NOTIFICATION_EVENTS.DRIVER_RETURN]:          'Driver Return',
};

const SAMPLE_DATA = {
  driverName: 'John D.',
  patientName: 'Jane Smith',
  storeName: 'Main Pharmacy',
  deliveryList: '\n• Jane Smith\n• Bob Wilson',
};

function buildSampleMessage(template) {
  return template
    .replace(/\{\{driverName\}\}/g, SAMPLE_DATA.driverName)
    .replace(/\{\{patientName\}\}/g, SAMPLE_DATA.patientName)
    .replace(/\{\{storeName\}\}/g, SAMPLE_DATA.storeName)
    .replace(/\{\{deliveryList\}\}/g, SAMPLE_DATA.deliveryList);
}

// Build the default template string from the hardcoded buildMessage fn
function getDefaultTemplate(eventName) {
  const rule = notificationRules[eventName];
  if (!rule?.buildMessage) return '';
  return rule.buildMessage({
    driverName: '{{driverName}}',
    patientName: '{{patientName}}',
    storeName: '{{storeName}}',
    deliveryList: '{{deliveryList}}',
  });
}

export default function MessageRulesManager() {
  const [overrides, setOverrides] = useState({});  // { [eventName]: { enabled, inApp, push, messageTemplate } }
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(null);  // eventName being saved
  const [editingEvent, setEditingEvent] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [settingId, setSettingId] = useState(null);

  useEffect(() => { loadOverrides(); }, []);

  const loadOverrides = async () => {
    try {
      const settings = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY });
      if (settings?.length > 0) {
        setSettingId(settings[0].id);
        setOverrides(settings[0].setting_value?.rules || {});
      }
    } catch (error) {
      console.error('Error loading notification overrides:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const persistOverrides = async (newOverrides) => {
    const payload = { setting_key: SETTING_KEY, setting_value: { rules: newOverrides }, description: 'Push notification rule overrides per event' };
    if (settingId) {
      await base44.entities.AppSettings.update(settingId, { setting_value: { rules: newOverrides } });
    } else {
      const created = await base44.entities.AppSettings.create(payload);
      setSettingId(created.id);
    }
    setOverrides(newOverrides);
  };

  // Quick-toggle enabled/inApp/push without opening editor
  const handleToggle = async (eventName, field) => {
    const defaultRule = notificationRules[eventName];
    const current = overrides[eventName] || {};
    const currentValue = field in current ? current[field] : defaultRule?.[field] ?? true;
    const newOverrides = {
      ...overrides,
      [eventName]: { ...current, [field]: !currentValue },
    };
    setIsSaving(eventName + '_' + field);
    try {
      await persistOverrides(newOverrides);
    } finally {
      setIsSaving(null);
    }
  };

  const handleEditOpen = (eventName) => {
    const defaultRule = notificationRules[eventName];
    const override = overrides[eventName] || {};
    setEditDraft({
      enabled: 'enabled' in override ? override.enabled : (defaultRule?.enabled ?? true),
      inApp:   'inApp'   in override ? override.inApp   : (defaultRule?.inApp   ?? true),
      push:    'push'    in override ? override.push     : false,
      messageTemplate: override.messageTemplate || getDefaultTemplate(eventName),
    });
    setEditingEvent(eventName);
  };

  const handleEditSave = async () => {
    const newOverrides = { ...overrides, [editingEvent]: { ...editDraft } };
    setIsSaving(editingEvent);
    try {
      await persistOverrides(newOverrides);
      setEditingEvent(null);
      setEditDraft(null);
    } catch {
      alert('Failed to save rule');
    } finally {
      setIsSaving(null);
    }
  };

  const handleReset = async (eventName) => {
    if (!confirm('Reset this rule to its default settings?')) return;
    const newOverrides = { ...overrides };
    delete newOverrides[eventName];
    setIsSaving(eventName);
    try {
      await persistOverrides(newOverrides);
    } finally {
      setIsSaving(null);
    }
  };

  const getEffectiveValue = (eventName, field) => {
    const defaultRule = notificationRules[eventName];
    const override = overrides[eventName] || {};
    if (field in override) return override[field];
    if (field === 'push') return false;
    return defaultRule?.[field] ?? true;
  };

  const hasOverride = (eventName) => !!overrides[eventName];

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
          {Object.values(NOTIFICATION_EVENTS).map(eventName => {
            const label = EVENT_LABELS[eventName] || eventName;
            const enabled = getEffectiveValue(eventName, 'enabled');
            const inApp  = getEffectiveValue(eventName, 'inApp');
            const push   = getEffectiveValue(eventName, 'push');
            const template = overrides[eventName]?.messageTemplate || getDefaultTemplate(eventName);
            const isEditing = editingEvent === eventName;
            const isModified = hasOverride(eventName);

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
                        value={editDraft.messageTemplate}
                        onChange={e => setEditDraft(d => ({ ...d, messageTemplate: e.target.value }))}
                        rows={3}
                        className="text-sm"
                        placeholder="Use {{driverName}}, {{patientName}}, etc."
                      />
                      <p className="text-xs text-slate-400 mt-1">
                        Preview: <em>"{buildSampleMessage(editDraft.messageTemplate)}"</em>
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-6">
                      <div className="flex items-center gap-2">
                        <Switch checked={editDraft.enabled} onCheckedChange={v => setEditDraft(d => ({ ...d, enabled: v }))} />
                        <Label className="text-sm">Enabled</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={editDraft.inApp} onCheckedChange={v => setEditDraft(d => ({ ...d, inApp: v }))} />
                        <Label className="text-sm flex items-center gap-1"><MessageSquare className="w-3 h-3" /> In-App</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={editDraft.push} onCheckedChange={v => setEditDraft(d => ({ ...d, push: v }))} />
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
                        {isModified && <Badge variant="outline" className="text-xs border-amber-400 text-amber-700 bg-amber-50">Modified</Badge>}
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
                      {/* Quick enabled toggle */}
                      <div className="flex items-center gap-1">
                        <Switch
                          checked={enabled}
                          onCheckedChange={() => handleToggle(eventName, 'enabled')}
                          disabled={isSaving?.startsWith(eventName)}
                        />
                      </div>
                      <Button size="sm" variant="outline" onClick={() => handleEditOpen(eventName)} className="gap-1 text-xs px-2">
                        <Edit2 className="w-3 h-3" /> Edit
                      </Button>
                      {isModified && (
                        <Button size="sm" variant="ghost" onClick={() => handleReset(eventName)} className="text-slate-400 hover:text-red-500 px-2" title="Reset to defaults">
                          <RotateCcw className="w-3 h-3" />
                        </Button>
                      )}
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