import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, Save, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';

export default function MessageRulesManager() {
  const [rules, setRules] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [showNewForm, setShowNewForm] = useState(false);

  useEffect(() => {
    loadRules();
  }, []);

  const loadRules = async () => {
    try {
      const settings = await base44.entities.AppSettings.filter({ 
        setting_key: 'message_notification_rules' 
      });
      
      if (settings && settings.length > 0) {
        setRules(settings[0].setting_value?.rules || []);
      }
    } catch (error) {
      console.error('Error loading rules:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const saveRules = async (updatedRules) => {
    setIsSaving(true);
    try {
      const existingSettings = await base44.entities.AppSettings.filter({ 
        setting_key: 'message_notification_rules' 
      });

      if (existingSettings && existingSettings.length > 0) {
        await base44.entities.AppSettings.update(existingSettings[0].id, {
          setting_value: { rules: updatedRules }
        });
      } else {
        await base44.entities.AppSettings.create({
          setting_key: 'message_notification_rules',
          setting_value: { rules: updatedRules },
          description: 'Message notification rules configuration'
        });
      }

      setRules(updatedRules);
      setEditingRule(null);
      setShowNewForm(false);
    } catch (error) {
      console.error('Error saving rules:', error);
      alert('Failed to save rules');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddRule = () => {
    setEditingRule({
      event: '',
      enabled: true,
      inApp: true,
      recipients: 'dispatchers',
      messageTemplate: ''
    });
    setShowNewForm(true);
  };

  const handleSaveRule = async () => {
    if (!editingRule?.event || !editingRule?.messageTemplate) {
      alert('Event name and message template are required');
      return;
    }

    const updatedRules = showNewForm
      ? [...rules, editingRule]
      : rules.map(r => r.event === editingRule.event ? editingRule : r);

    await saveRules(updatedRules);
  };

  const handleDeleteRule = async (event) => {
    if (!confirm('Are you sure you want to delete this rule?')) return;
    
    const updatedRules = rules.filter(r => r.event !== event);
    await saveRules(updatedRules);
  };

  const handleEditRule = (rule) => {
    setEditingRule({ ...rule });
    setShowNewForm(false);
  };

  if (isLoading) {
    return <div className="p-4">Loading rules...</div>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Message Notification Rules</CardTitle>
            <Button onClick={handleAddRule} size="sm" className="gap-2">
              <Plus className="w-4 h-4" />
              Add Rule
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rules.length === 0 && !showNewForm && (
            <p className="text-slate-500 text-sm">No custom rules defined. Using default rules.</p>
          )}

          <div className="space-y-3">
            {rules.map((rule) => (
              <div key={rule.event} className="border rounded-lg p-4 bg-slate-50">
                {editingRule?.event === rule.event && !showNewForm ? (
                  <RuleForm
                    rule={editingRule}
                    onChange={setEditingRule}
                    onSave={handleSaveRule}
                    onCancel={() => setEditingRule(null)}
                    isSaving={isSaving}
                  />
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <h3 className="font-semibold text-slate-900">{rule.event}</h3>
                          {rule.enabled ? (
                            <Badge className="bg-green-100 text-green-800">Enabled</Badge>
                          ) : (
                            <Badge className="bg-gray-100 text-gray-800">Disabled</Badge>
                          )}
                          <Badge variant="outline">{rule.recipients}</Badge>
                        </div>
                        <p className="text-sm text-slate-600 italic">"{rule.messageTemplate}"</p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => handleEditRule(rule)}
                          size="sm"
                          variant="outline"
                        >
                          Edit
                        </Button>
                        <Button
                          onClick={() => handleDeleteRule(rule.event)}
                          size="sm"
                          variant="destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {showNewForm && (
              <div className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50">
                <h3 className="font-semibold text-slate-900 mb-3">New Rule</h3>
                <RuleForm
                  rule={editingRule}
                  onChange={setEditingRule}
                  onSave={handleSaveRule}
                  onCancel={() => {
                    setShowNewForm(false);
                    setEditingRule(null);
                  }}
                  isSaving={isSaving}
                />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Available Variables</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-xs space-y-1 text-slate-600">
            <p><code className="bg-slate-100 px-1 rounded">{'{{driverName}}'}</code> - Driver's name</p>
            <p><code className="bg-slate-100 px-1 rounded">{'{{patientName}}'}</code> - Patient's name</p>
            <p><code className="bg-slate-100 px-1 rounded">{'{{storeName}}'}</code> - Store name</p>
            <p><code className="bg-slate-100 px-1 rounded">{'{{deliveryList}}'}</code> - List of deliveries</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RuleForm({ rule, onChange, onSave, onCancel, isSaving }) {
  return (
    <div className="space-y-3">
      <div>
        <Label>Event Name</Label>
        <Input
          value={rule.event}
          onChange={(e) => onChange({ ...rule, event: e.target.value })}
          placeholder="e.g., driver_completed"
        />
      </div>

      <div>
        <Label>Message Template</Label>
        <Textarea
          value={rule.messageTemplate}
          onChange={(e) => onChange({ ...rule, messageTemplate: e.target.value })}
          placeholder="e.g., {{driverName}} has completed delivery for {{patientName}}."
          rows={3}
        />
      </div>

      <div>
        <Label>Recipients</Label>
        <select
          value={rule.recipients}
          onChange={(e) => onChange({ ...rule, recipients: e.target.value })}
          className="w-full px-3 py-2 border rounded-md"
        >
          <option value="dispatchers">Dispatchers</option>
          <option value="driver">Driver</option>
          <option value="both">Both</option>
        </select>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          checked={rule.enabled}
          onCheckedChange={(checked) => onChange({ ...rule, enabled: checked })}
        />
        <Label>Enabled</Label>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          checked={rule.inApp}
          onCheckedChange={(checked) => onChange({ ...rule, inApp: checked })}
        />
        <Label>In-App Messages</Label>
      </div>

      <div className="flex gap-2 pt-2">
        <Button onClick={onSave} disabled={isSaving} className="gap-2">
          <Save className="w-4 h-4" />
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
        <Button onClick={onCancel} variant="outline" disabled={isSaving}>
          <X className="w-4 h-4" />
          Cancel
        </Button>
      </div>
    </div>
  );
}