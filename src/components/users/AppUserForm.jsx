import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { X, Calendar, Trash2 } from 'lucide-react';
import { MultiSelect } from '@/components/ui/multi-select';
import { PhoneInput } from '@/components/ui/phone-input';
import { useAppData } from '../utils/AppDataContext';
import { format } from 'date-fns';

export default function AppUserForm({ appUser, authUsers, stores, cities, onSave, onCancel }) {
  const { setIsFormOverlayOpen } = useAppData();

  const [formData, setFormData] = useState({
    user_id: '',
    app_roles: ['driver'],
    user_name: '',
    status: 'active',
    driver_status: 'off_duty',
    phone: '',
    city_id: '',
    city_ids: [],
    store_ids: [],
    sort_order: 0,
    home_latitude: null,
    home_longitude: null,
    pay_rate_history: []
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
        driver_status: appUser.driver_status || 'off_duty',
        phone: appUser.phone || '',
        city_id: appUser.city_id || '',
        city_ids: cityIds,
        store_ids: appUser.store_ids || [],
        sort_order: appUser.sort_order || 0,
        home_latitude: appUser.home_latitude || null,
        home_longitude: appUser.home_longitude || null,
        pay_rate_history: appUser.pay_rate_history || []
      });
    } else {
      // Reset form data when appUser is null (adding new user)
      setFormData({
        user_id: '',
        app_roles: ['driver'],
        user_name: '',
        status: 'active',
        driver_status: 'off_duty',
        phone: '',
        city_id: '',
        city_ids: [],
        store_ids: [],
        sort_order: 0,
        home_latitude: null,
        home_longitude: null,
        pay_rate_history: []
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
    e.stopPropagation();
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
        <CardContent className="p-2 px-3 py-3">
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
                <SelectContent className="z-[10003]">
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
                  <SelectContent className="z-[10003]">
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

            {/* Sort Order and User Status on same row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Sort Order</Label>
                <Input
                  type="number"
                  value={formData.sort_order}
                  onChange={(e) => setFormData({ ...formData, sort_order: parseInt(e.target.value) || 0 })}
                  className="h-9" />
              </div>

              <div>
                <Label>User Status</Label>
                <Select 
                  value={formData.driver_status} 
                  onValueChange={(value) => setFormData({ ...formData, driver_status: value })}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[10003]">
                    <SelectItem value="online">Online</SelectItem>
                    <SelectItem value="on_duty">On Duty</SelectItem>
                    <SelectItem value="on_break">On Break</SelectItem>
                    <SelectItem value="off_duty">Off Duty</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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

            {/* Pay Rate History */}
            {formData.pay_rate_history && formData.pay_rate_history.length > 0 && (
              <div className="pt-2 border-t">
                <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 block flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  Pay Rate History
                </Label>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {formData.pay_rate_history
                    .sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date))
                    .map((entry, idx) => (
                      <div key={idx} className="text-xs p-2 bg-slate-50 rounded flex justify-between items-center gap-2">
                        <span className="font-medium text-slate-700">
                          {format(new Date(entry.effective_date), 'MMM dd, yyyy')}
                        </span>
                        <div className="text-slate-600 text-[10px] flex items-center gap-1.5">
                          <span>${(entry.pay_rate_per_delivery || 0).toFixed(2)}</span>
                          <span>/</span>
                          <span>${(entry.extra_km_rate || 0).toFixed(2)}/km</span>
                          {entry.extra_km_limit != null && (
                            <>
                              <span>/</span>
                              <span>Limit: {entry.extra_km_limit}km</span>
                            </>
                          )}
                          {entry.oversized_item_rate != null && (
                            <>
                              <span>/</span>
                              <span>OS: ${entry.oversized_item_rate.toFixed(2)}</span>
                            </>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setFormData(prev => ({
                              ...prev,
                              pay_rate_history: prev.pay_rate_history.filter((_, i) => i !== idx)
                            }));
                          }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                </div>
              </div>
            )}

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