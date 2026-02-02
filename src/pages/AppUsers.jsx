import React, { useState, useEffect } from 'react';
import { User } from '@/entities/User';
import { AppUser } from '@/entities/AppUser';
import { Store } from '@/entities/Store';
import { City } from '@/entities/City';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { getEffectiveUser } from '../components/utils/auth';
import AppUserForm from '../components/users/AppUserForm';
import { sortUsers } from '../components/utils/sorting';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { formatPhoneNumber } from '../components/utils/phoneFormatter';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';

export default function AppUsers() {
  const [appUsers, setAppUsers] = useState([]);
  const [authUsers, setAuthUsers] = useState([]);
  const [stores, setStores] = useState([]);
  const [cities, setCities] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingAppUser, setEditingAppUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const user = await getEffectiveUser();
      setCurrentUser(user);

      const [appUsersData, authUsersData, storesData, citiesData] = await Promise.all([
        AppUser.list(),
        User.list(),
        Store.list(),
        City.list()
      ]);

      setAppUsers(appUsersData || []);
      setAuthUsers(authUsersData || []);
      setStores(storesData || []);
      setCities(citiesData || []);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async (appUserData) => {
    try {
      if (editingAppUser) {
        await AppUser.update(editingAppUser.id, appUserData);
        // Update local state immediately
        setAppUsers(prev => prev.map(u => u.id === editingAppUser.id ? { ...u, ...appUserData, updated_date: new Date().toISOString() } : u));
      } else {
        const newAppUser = await AppUser.create(appUserData);
        // Add to local state immediately
        setAppUsers(prev => [...prev, newAppUser]);
      }
      setShowForm(false);
      setEditingAppUser(null);
    } catch (error) {
      console.error('Error saving app user:', error);
      alert(`Failed to save user: ${error.message}`);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this user? This will not delete their login credentials.')) {
      try {
        await AppUser.delete(id);
        // Update local state immediately
        setAppUsers(prev => prev.filter(u => u.id !== id));
      } catch (error) {
        console.error('Error deleting app user:', error);
        alert('Failed to delete user.');
      }
    }
  };

  const handleEdit = (appUser) => {
    setEditingAppUser(appUser);
    setShowForm(true);
  };

  // Merge AppUser with auth User data for display
  const mergedUsers = appUsers.map(appUser => {
    const authUser = authUsers.find(u => u.id === appUser.user_id);
    return {
      ...appUser,
      email: authUser?.email || 'Unknown',
      full_name: authUser?.full_name || 'Unknown',
      platform_role: authUser?.role || 'user'
    };
  });

  const filteredUsers = sortUsers(mergedUsers.filter(user =>
    user.user_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.email?.toLowerCase().includes(searchQuery.toLowerCase())
  ));

  const getRoleBadgeColor = (roles) => {
    if (roles?.includes('admin')) return 'bg-purple-100 text-purple-800';
    if (roles?.includes('dispatcher')) return 'bg-blue-100 text-blue-800';
    return 'bg-emerald-100 text-emerald-800';
  };

  const getStatusBadgeColor = (status) => {
    return status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-800';
  };

  const getUserStatusIndicator = (user) => {
    const status = user.driver_status || 'off_duty';
    
    if (status === 'online' || status === 'on_duty') {
      // Check if stale (no location update in 5+ minutes)
      if (!user.location_updated_at) return '#f97316'; // orange (stale)
      const now = Date.now();
      const lastUpdate = new Date(user.location_updated_at).getTime();
      const isStale = (now - lastUpdate) > 5 * 60 * 1000;
      return isStale ? '#f97316' : '#10b981'; // orange (stale) : green (online)
    }
    
    return '#cbd5e1'; // grey (offline)
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p>Loading users...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* Fixed Header */}
      <div className="flex-shrink-0 p-6 pb-0">
        <div className="max-w-7xl mx-auto space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <SmartRefreshIndicator inline={true} />
              <h1 className="text-3xl font-bold text-slate-900">App Users</h1>
              <p className="text-slate-600 mt-1">Manage application-specific user data and roles</p>
            </div>
            <Button onClick={() => { setEditingAppUser(null); setShowForm(true); }} className="bg-emerald-500 hover:bg-emerald-600">
              <Plus className="w-4 h-4 mr-2" />
              Add User
            </Button>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search by name or email..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
            </CardHeader>
          </Card>

          {/* Fixed Table Headers */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-white border-b">
                    <tr>
                      <th className="text-left p-3 font-semibold text-slate-700">User Name</th>
                      <th className="text-left p-3 font-semibold text-slate-700">Full Name</th>
                      <th className="text-left p-3 font-semibold text-slate-700">Email</th>
                      <th className="text-left p-3 font-semibold text-slate-700">App Roles</th>
                      <th className="text-left p-3 font-semibold text-slate-700">Status</th>
                      <th className="text-left p-3 font-semibold text-slate-700">Phone</th>
                      <th className="text-right p-3 font-semibold text-slate-700">Actions</th>
                    </tr>
                  </thead>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Scrollable Content - Table Body Only */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="max-w-7xl mx-auto">
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <tbody>
                    {filteredUsers.map(user => (
                      <tr 
                        key={user.id} 
                        className="border-b hover:bg-slate-50 cursor-pointer transition-colors"
                        onClick={() => handleEdit(user)}
                      >
                        <td className="p-3 font-medium">
                          <div className="flex items-center gap-2">
                            <div
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              style={{ backgroundColor: getUserStatusIndicator(user) }}
                            />
                            {getDriverDisplayName(user)}
                          </div>
                        </td>
                        <td className="p-3 text-slate-600">{user.full_name}</td>
                        <td className="p-3 text-slate-600">{user.email}</td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1">
                            {(user.app_roles || []).map(role => (
                              <Badge key={role} className={getRoleBadgeColor(user.app_roles)}>
                                {role}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="p-3">
                          <Badge className={getStatusBadgeColor(user.status)}>
                            {user.status || 'active'}
                          </Badge>
                        </td>
                        {/* Modified Phone column to use formatPhoneNumber and tel: link */}
                        <td className="p-3">
                          {user.phone ? (
                            <a
                              href={`tel:${user.phone}`}
                              className="text-blue-600 hover:underline"
                            >
                              {formatPhoneNumber(user.phone)}
                            </a>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        {/* End of Modified Phone column */}
                        <td className="p-3">
                          <div className="flex justify-end gap-2">
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEdit(user);
                              }}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(user.id);
                              }}
                              className="text-red-600 hover:text-red-700"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {showForm && (
        <AppUserForm
          appUser={editingAppUser}
          authUsers={authUsers}
          stores={stores}
          cities={cities}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingAppUser(null); }}
        />
      )}
    </div>
  );
}