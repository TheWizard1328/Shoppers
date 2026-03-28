import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PhoneInput } from '@/components/ui/phone-input';
import { Textarea } from '@/components/ui/textarea';
import { X } from 'lucide-react';
import { useAppData } from '@/components/utils/AppDataContext';

export default function CompanyForm({ company, stores = [], onSave, onCancel }) {
  const appData = useAppData();
  const setIsFormOverlayOpen = appData?.setIsFormOverlayOpen;
  const [formData, setFormData] = useState({
    name: '',
    status: 'active',
    logo_url: '',
    favicon_url: '',
    primary_color: '#16a34a',
    secondary_color: '#ffffff',
    accent_color: '#0f172a',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
    website_url: '',
    support_email: '',
    support_phone: '',
    store_ids: [],
    timezone: 'America/Edmonton',
    notes: ''
  });

  useEffect(() => {
    if (company) {
      setFormData({
        name: company.name || '',
        status: company.status || 'active',
        logo_url: company.logo_url || '',
        favicon_url: company.favicon_url || '',
        primary_color: company.primary_color || '#16a34a',
        secondary_color: company.secondary_color || '#ffffff',
        accent_color: company.accent_color || '#0f172a',
        contact_name: company.contact_name || '',
        contact_email: company.contact_email || '',
        contact_phone: company.contact_phone || '',
        website_url: company.website_url || '',
        support_email: company.support_email || '',
        support_phone: company.support_phone || '',
        store_ids: company.store_ids || [],
        timezone: company.timezone || 'America/Edmonton',
        notes: company.notes || ''
      });
    }
  }, [company]);

  useEffect(() => {
    if (setIsFormOverlayOpen) {
      setIsFormOverlayOpen(true);
      return () => setIsFormOverlayOpen(false);
    }
  }, [setIsFormOverlayOpen]);

  const sortedStores = useMemo(
    () => [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)),
    [stores]
  );

  const toggleStore = (storeId) => {
    setFormData((prev) => ({
      ...prev,
      store_ids: prev.store_ids.includes(storeId)
        ? prev.store_ids.filter((id) => id !== storeId)
        : [...prev.store_ids, storeId]
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10002] flex items-center justify-center p-4">
      <Card className="w-full max-w-4xl max-h-[90vh] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <CardHeader className="px-6 py-3 flex flex-row items-center justify-between">
          <CardTitle>{company ? 'Edit Company' : 'Add Company'}</CardTitle>
          <Button variant="ghost" size="icon" onClick={onCancel}>
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Company Name *</Label>
                <Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} required />
              </div>
              <div>
                <Label>Status</Label>
                <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="z-[10003]">
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Logo URL</Label>
                <Input value={formData.logo_url} onChange={(e) => setFormData({ ...formData, logo_url: e.target.value })} />
              </div>
              <div>
                <Label>Favicon URL</Label>
                <Input value={formData.favicon_url} onChange={(e) => setFormData({ ...formData, favicon_url: e.target.value })} />
              </div>
              <div>
                <Label>Website</Label>
                <Input value={formData.website_url} onChange={(e) => setFormData({ ...formData, website_url: e.target.value })} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Primary Color</Label>
                <Input type="color" value={formData.primary_color} onChange={(e) => setFormData({ ...formData, primary_color: e.target.value })} className="h-11" />
              </div>
              <div>
                <Label>Secondary Color</Label>
                <Input type="color" value={formData.secondary_color} onChange={(e) => setFormData({ ...formData, secondary_color: e.target.value })} className="h-11" />
              </div>
              <div>
                <Label>Accent Color</Label>
                <Input type="color" value={formData.accent_color} onChange={(e) => setFormData({ ...formData, accent_color: e.target.value })} className="h-11" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Primary Contact</Label>
                <Input value={formData.contact_name} onChange={(e) => setFormData({ ...formData, contact_name: e.target.value })} />
              </div>
              <div>
                <Label>Contact Email</Label>
                <Input type="email" value={formData.contact_email} onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })} />
              </div>
              <div>
                <Label>Contact Phone</Label>
                <PhoneInput value={formData.contact_phone} onChange={(value) => setFormData({ ...formData, contact_phone: value })} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Support Email</Label>
                <Input type="email" value={formData.support_email} onChange={(e) => setFormData({ ...formData, support_email: e.target.value })} />
              </div>
              <div>
                <Label>Support Phone</Label>
                <PhoneInput value={formData.support_phone} onChange={(value) => setFormData({ ...formData, support_phone: value })} />
              </div>
              <div>
                <Label>Timezone</Label>
                <Input value={formData.timezone} onChange={(e) => setFormData({ ...formData, timezone: e.target.value })} />
              </div>
            </div>

            <div>
              <Label>Associated Stores</Label>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 max-h-52 overflow-y-auto border rounded-lg p-3" style={{ borderColor: 'var(--border-slate-200)' }}>
                {sortedStores.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>No stores available yet.</p>
                ) : sortedStores.map((store) => (
                  <label key={store.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.store_ids.includes(store.id)}
                      onChange={() => toggleStore(store.id)}
                    />
                    <span>{store.name}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <Label>Primary Settings / Notes</Label>
              <Textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className="min-h-28" />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700">
                {company ? 'Update Company' : 'Create Company'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}