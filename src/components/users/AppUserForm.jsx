import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { X } from 'lucide-react';
import { MultiSelect } from '@/components/ui/multi-select';
import { PhoneInput } from '@/components/ui/phone-input';
import { useAppData } from '../utils/AppDataContext';

export default function AppUserForm({ appUser, authUsers, stores, cities, onSave, onCancel }) {
  const { setIsFormOverlayOpen } = useAppData();

  const [formData, setFormData] = useState({
    user_id: '',
    app_roles: ['driver'],
    user_name: '',
    status: 'active',
    phone: '',
    city_id: '',
    city_ids: [],
    store_ids: [],
    sort_order: 0,
    home_latitude: null,
    home_longitude: null
  });

  useEffect(() => {
    if (appUser) {
      // Handle migration from city_id to city_ids
      let cityIds = appUser.city_ids || [];
      if (cityIds.length === 0 && appUser.city_id) {
        cityIds = [appUser.city_id];
      }

      setFormData({
        user_id: appUser.user_id || '',
        app_roles: appUser.app_roles || ['driver'],
        user_name: appUser.user_name || '',
        status: appUser.status || 'active',
        phone: appUser.phone || '',
        city_id: appUser.city_id || '',
        city_ids: cityIds,
        store_ids: appUser.store_ids || [],
        sort_order: appUser.sort_order || 0,
        home_latitude: appUser.home_latitude || null,
        home_longitude: appUser.home_longitude || null
      });
    } else {
      // Reset form data when appUser is null (adding new user)
      setFormData({
        user_id: '',
        app_roles: ['driver'],
        user_name: '',
        status: 'active',
        phone: '',
        city_id: '',
        city_ids: [],
        store_ids: [],
        sort_order: 0,
        home_latitude: null,
        home_longitude: null
      });
    }
  }, [appUser]);

  // Prevent background scrolling when form is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, []);

  useEffect(() => {
    setIsFormOverlayOpen(true);
    return () => {
      setIsFormOverlayOpen(false);
    };
  }, [setIsFormOverlayOpen]);

  const handleSubmit = (e) => {
    e.preventDefault();
    // Set city_id to first city for backward compatibility
    const dataToSave = {
      ...formData,
      city_id: formData.city_ids?.[0] || ''
    };
    onSave(dataToSave);
  };

  const handleRoleToggle = (role) => {
    const currentRoles = formData.app_roles || [];
    if (currentRoles.includes(role)) {
      setFormData({ ...formData, app_roles: currentRoles.filter((r) => r !== role) });
    } else {
      setFormData({ ...formData, app_roles: [...currentRoles, role] });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10002] flex items-center justify-center p-4">
      <Card className="w-full max-w-md max-h-[90vh] overflow-y-auto">
        <CardHeader className="px-6 py-2 space-y-1.5 flex flex-row items-center justify-between">
          <CardTitle>{appUser ? 'Edit User' : 'Add New User'}</CardTitle>
          <Button variant="ghost" size="icon" onClick={onCancel}>
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent className="p-2 px-3 py-3 z-[10003]">
          <form onSubmit={handleSubmit} className="space-y-1">
            {/* User Email Selection */}
            <div>
              <Label htmlFor="user_id">User Email *</Label>
              <Select
                value={formData.user_id}
                onValueChange={(value) => setFormData((prev) => ({ ...prev, user_id: value }))}
                required>

                <SelectTrigger id="user_id" className="border-slate-300">
                  <SelectValue placeholder="Select user by email..." />
                </SelectTrigger>
                <SelectContent>
                  {authUsers.map((user) =>
                  <SelectItem key={user.id} value={user.id}>
                      {user.email} - {user.full_name}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Display Name and App Roles on same row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="user_name">Display Name *</Label>
                <Input
                  id="user_name"
                  value={formData.user_name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, user_name: e.target.value }))}
                  placeholder="Display name for the app"
                  required
                  className="border-slate-300 h-9" />
              </div>

              <div>
                <Label>App Roles</Label>
                <div className="flex gap-1">
                  {['admin', 'dispatcher', 'driver'].map((role) =>
                  <Button
                    key={role}
                    type="button"
                    size="sm"
                    variant={formData.app_roles?.includes(role) ? 'default' : 'outline'}
                    onClick={() => handleRoleToggle(role)}
                    className="text-xs px-2 h-9">
                      {role}
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Status and Phone on same row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Status</Label>
                <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Phone Input */}
              <div>
                <Label htmlFor="phone">Phone Number</Label>
                <PhoneInput
                  id="phone"
                  value={formData.phone}
                  onChange={(value) => setFormData((prev) => ({ ...prev, phone: value }))}
                  placeholder="Phone number"
                  className="h-9" />
              </div>
            </div>

            {/* Cities Assignment */}
            <div>
              <Label>Assigned Cities</Label>
              <MultiSelect
                options={[...cities].
                sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)).
                map((c) => ({ label: c.name, value: c.id }))}
                value={formData.city_ids || []}
                onChange={(values) => setFormData((prev) => ({ ...prev, city_ids: values }))}
                placeholder="Select cities..." />

            </div>

            {/* Sort Order */}
            <div className="w-1/2">
              <Label>Sort Order</Label>
              <Input
                type="number"
                value={formData.sort_order}
                onChange={(e) => setFormData({ ...formData, sort_order: parseInt(e.target.value) || 0 })} />

            </div>

            {/* Home GPS Coordinates on same row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Home Latitude</Label>
                <Input
                  type="number"
                  step="any"
                  value={formData.home_latitude || ''}
                  onChange={(e) => setFormData({ ...formData, home_latitude: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder="e.g. 53.5461" />

              </div>

              <div>
                <Label>Home Longitude</Label>
                <Input
                  type="number"
                  step="any"
                  value={formData.home_longitude || ''}
                  onChange={(e) => setFormData({ ...formData, home_longitude: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder="e.g. -113.4938" />

              </div>
            </div>

            {/* Assigned Stores for Dispatchers */}
            {formData.app_roles?.includes('dispatcher') &&
            <div>
                <Label>Assigned Stores (for Dispatchers)</Label>
                <MultiSelect
                options={[...stores].
                sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)).
                map((s) => ({ label: s.name, value: s.id }))}
                value={formData.store_ids || []}
                onChange={(values) => setFormData((prev) => ({ ...prev, store_ids: values }))}
                placeholder="Select stores..." />

              </div>
            }

            <div className="py-2 flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" className="bg-emerald-500 hover:bg-emerald-600">
                {appUser ? 'Update' : 'Create'} User
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>);

}