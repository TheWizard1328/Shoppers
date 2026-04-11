import React, { useState, useEffect, useCallback } from "react";
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { UserPlus, Plus, Search, Edit, GripVertical, X, RefreshCw } from "lucide-react";
import { MultiSelect } from "../components/ui/multi-select";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { useAutoRefresh } from '../components/utils/useAutoRefresh';
import { sortUsers, sortStores } from '../components/utils/sorting';
import { Label } from "@/components/ui/label";
import { AnimatePresence, motion } from "framer-motion";

// New imports for role utilities
import { userHasRole, getUserRoles, getPrimaryRole, formatRoles } from '../components/utils/userRoles';
// New imports for ID utilities
import { generateSystemUserId, validateSystemUserId, formatSystemUserId } from '../components/utils/userIdGenerator';

// UserForm Component is removed. Its logic will be inlined into UsersPage.

// UserCard Component
const UserCard = ({ user, stores, onEdit }) => {
  return (
    <Card className="bg-white shadow-sm hover:shadow-md transition-shadow">
      <CardContent className="p-4 flex items-center gap-4">
        <GripVertical className="w-5 h-5 text-slate-400 cursor-grab" />
        <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center font-bold text-slate-600 flex-shrink-0">
          {user.full_name ? user.full_name.charAt(0) : '?'}
        </div>
        <div className="flex-1">
          {/* Roles - Above username */}
          <div className="flex items-center gap-2 mb-1">
            {getUserRoles(user).map((role) => (
              <Badge
                key={role}
                variant="outline"
                className={`capitalize text-xs ${
                  role === 'admin' ? 'bg-purple-100 text-purple-800 border-purple-200' :
                  role === 'dispatcher' ? 'bg-blue-100 text-blue-800 border-blue-200' :
                  'bg-emerald-100 text-emerald-800 border-emerald-200'
                }`}
              >
                {role}
              </Badge>
            ))}
          </div>

          {/* Username and System ID - Same line */}
          <div className="flex items-center justify-between mb-1">
            <div>
              <p className="font-semibold text-slate-800">{user.full_name}</p>
              <p className="text-sm text-slate-500">{user.email}</p>
            </div>
            {user.system_user_id && (
              <Badge variant="outline" className="text-xs font-mono">
                {user.system_user_id}
              </Badge>
            )}
          </div>

          {/* Store Assignments - Below username */}
          {(user.store_ids && user.store_ids.length > 0) && (
            <div className="flex flex-wrap gap-2 mt-2">
              {user.store_ids.map(id => {
                const store = stores.find(s => s.id === id);
                return store ? (
                  <Badge key={id} variant="outline" className="text-xs bg-slate-50">
                    {store.name}
                  </Badge>
                ) : null;
              })}
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => onEdit(user)}>
          <Edit className="w-4 h-4" />
        </Button>
      </CardContent>
    </Card>
  );
};


export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [stores, setStores] = useState([]);
  const [cities, setCities] = useState([]);
  const [editingUser, setEditingUser] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    full_name: "",
    email: "",
    alias_name: "",
    system_user_id: "",
    app_roles: ["driver"],
    phone: "",
    city_id: "",
    store_ids: [],
    sort_order: 0,
    status: "active",
    location_tracking_enabled: true,
  });

  const sortedStores = sortStores(stores || []);
  const storeOptions = sortedStores.map(s => ({ value: s.id, label: s.name }));

  const loadData = useCallback(async () => {
    if (users.length === 0 || isLoading) {
      setIsLoading(true);
    }
    try {
      const [usersData, storesData, citiesData] = await Promise.all([
        base44.entities.User.list('sort_order'),
        base44.entities.Store.list(),
        base44.entities.City.list()
      ]);
      setUsers(sortUsers(usersData || []));
      setStores(storesData || []);
      setCities(citiesData || []);
    } catch (error) {
      console.error("Failed to load data:", error);
    } finally {
      if (isLoading || users.length === 0) {
        setIsLoading(false);
      }
    }
  }, [isLoading, users.length]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!editingUser && formData.city_id && !formData.system_user_id) {
      const selectedCity = cities.find(c => c.id === formData.city_id);
      if (selectedCity && selectedCity.name) {
        try {
          const existingSystemUserIds = users.map(u => u.system_user_id).filter(Boolean);
          const newId = generateSystemUserId(selectedCity.name, existingSystemUserIds);
          setFormData(prev => ({ ...prev, system_user_id: newId }));
        } catch (error) {
          console.error('Failed to generate system user ID:', error);
        }
      }
    }
  }, [formData.city_id, formData.system_user_id, editingUser, cities, users]);

  // useAutoRefresh(loadData, 30000);

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    
    if (formData.app_roles.length === 0) {
      alert("Please select at least one role");
      setIsSaving(false);
      return;
    }
    
    if (formData.app_roles.includes('dispatcher') && formData.store_ids.length === 0) {
      alert("Dispatchers must have at least one assigned store");
      setIsSaving(false);
      return;
    }

    if (!validateSystemUserId(formData.system_user_id)) {
      alert("System User ID must be 5 characters: 2 uppercase letters + 3 alphanumeric characters");
      setIsSaving(false);
      return;
    }

    try {
      const dataToSave = {
        ...formData,
        system_user_id: formatSystemUserId(formData.system_user_id),
        app_role: getPrimaryRole(formData.app_roles),
        store_ids: Array.isArray(formData.store_ids) ? formData.store_ids : [],
      };

      if (editingUser) {
        await base44.entities.User.update(editingUser.id, dataToSave);
      } else {
        await base44.auth.updateMe(dataToSave);
      }
      setShowForm(false);
      setEditingUser(null);
      loadData();
    } catch (error) {
      console.error("Failed to save user:", error);
      alert("Error saving user. See console for details.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (user) => {
    setEditingUser(user);
    setFormData({
      full_name: user.full_name || "",
      email: user.email || "",
      alias_name: user.alias_name || "",
      system_user_id: user.system_user_id || "",
      app_roles: getUserRoles(user),
      phone: user.phone || "",
      city_id: user.city_id || "",
      store_ids: user.store_ids || [],
      sort_order: user.sort_order || 0,
      status: user.status || "active",
      location_tracking_enabled: user.location_tracking_enabled !== undefined ? user.location_tracking_enabled : true,
    });
    setShowForm(true);
  };

  const handleAddUserClick = () => {
    setEditingUser(null);
    setFormData({
      full_name: "",
      email: "",
      alias_name: "",
      system_user_id: "",
      app_roles: ["driver"],
      phone: "",
      city_id: "",
      store_ids: [],
      sort_order: 0,
      status: "active",
      location_tracking_enabled: true,
    });
    setShowForm(true);
  };

  const onDragEnd = async (result) => {
    const { destination, source } = result;
    if (!destination) return;
    if (destination.index === source.index) return;

    const reorderedUsers = Array.from(users);
    const [removed] = reorderedUsers.splice(source.index, 1);
    reorderedUsers.splice(destination.index, 0, removed);

    setUsers(reorderedUsers);

    try {
      const updatePromises = reorderedUsers.map((user, index) =>
        base44.entities.User.update(user.id, { sort_order: index })
      );
      await Promise.all(updatePromises);
    } catch (error) {
      console.error("Failed to update user order:", error);
      alert("Error saving new user order. Please refresh.");
      loadData();
    }
  };

  const filteredUsers = users.filter(user =>
    (user.full_name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (user.email || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    formatRoles(getUserRoles(user)).toLowerCase().includes(searchTerm.toLowerCase()) ||
    (user.system_user_id || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="h-screen flex flex-col bg-slate-50 p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-slate-900">User Management</h1>
        <Button onClick={handleAddUserClick} className="flex items-center gap-2">
          <UserPlus className="w-4 h-4" />
          Add User
        </Button>
      </div>

      <div className="mb-6">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search users by name, email, role, or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 bg-white"
          />
        </div>
      </div>

      {isLoading && users.length === 0 ? (
        <p>Loading users...</p>
      ) : (
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="users-list">
            {(provided) => (
              <div
                {...provided.droppableProps}
                ref={provided.innerRef}
                className="flex-1 overflow-y-auto space-y-3"
              >
                {filteredUsers.length === 0 && !isLoading ? (
                  <p className="text-center text-slate-500 mt-8">No users found matching your search criteria.</p>
                ) : (
                  filteredUsers.map((user, index) => (
                    <Draggable key={user.id} draggableId={user.id} index={index}>
                      {(provided) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                        >
                          <UserCard user={user} stores={stores} onEdit={handleEdit} />
                        </div>
                      )}
                    </Draggable>
                  ))
                )}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      )}

      {/* User Form Modal */}
      <AnimatePresence>
        {showForm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            onClick={() => {
              setShowForm(false);
              setEditingUser(null);
            }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-900">
                  {editingUser ? 'Edit User' : 'Add User'}
                </h2>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setShowForm(false);
                    setEditingUser(null);
                  }}
                >
                  <X className="w-5 h-5" />
                </Button>
              </div>

              <form onSubmit={handleFormSubmit} className="p-6 space-y-6">
                {/* Full Name & Email */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="full_name">Full Name *</Label>
                    <Input
                      id="full_name"
                      value={formData.full_name || ''}
                      onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                      required
                      placeholder="John Doe"
                    />
                  </div>
                  <div>
                    <Label htmlFor="email">Email *</Label>
                    <Input
                      id="email"
                      type="email"
                      value={formData.email || ''}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      required
                      placeholder="john@example.com"
                    />
                  </div>
                </div>

                {/* Display Name & Phone */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="alias_name">Display Name (Optional)</Label>
                    <Input
                      id="alias_name"
                      value={formData.alias_name || ''}
                      onChange={(e) => setFormData({ ...formData, alias_name: e.target.value })}
                      placeholder="Bob"
                    />
                    <p className="text-xs text-slate-500 mt-1">Short name shown in the app</p>
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone</Label>
                    <Input
                      id="phone"
                      type="tel"
                      value={formData.phone || ''}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      placeholder="780-123-4567"
                    />
                  </div>
                </div>

                {/* City & System User ID */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="city_id">City *</Label>
                    <Select
                      value={formData.city_id || ''}
                      onValueChange={(value) => setFormData({ ...formData, city_id: value })}
                      required
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select city..." />
                      </SelectTrigger>
                      <SelectContent>
                        {cities.map((city) => (
                          <SelectItem key={city.id} value={city.id}>
                            {city.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="system_user_id">System User ID *</Label>
                    <Input
                      id="system_user_id"
                      value={formData.system_user_id || ''}
                      onChange={(e) => setFormData({ ...formData, system_user_id: formatSystemUserId(e.target.value) })}
                      placeholder="EDa2X"
                      maxLength={5}
                      pattern="^[A-Z]{2}[A-Za-z0-9]{3}$"
                      title="Must be 5 chars: 2 uppercase letters + 3 alphanumeric"
                      className={formData.system_user_id && !validateSystemUserId(formData.system_user_id) ? 'border-red-500' : ''}
                    />
                    {formData.system_user_id && !validateSystemUserId(formData.system_user_id) && (
                      <p className="text-xs text-red-500 mt-1">
                        Must be 5 chars: 2 uppercase letters + 3 alphanumeric
                      </p>
                    )}
                    <p className="text-xs text-slate-500 mt-1">Must be 5 chars: 2 uppercase letters + 3 alphanumeric</p>
                  </div>
                </div>

                {/* Roles */}
                <div>
                  <Label>Roles *</Label>
                  <div className="space-y-2 mt-2">
                    {['admin', 'dispatcher', 'driver'].map((role) => (
                      <div key={role} className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          id={`role-${role}`}
                          checked={formData.app_roles?.includes(role) || false}
                          onChange={(e) => {
                            const currentRoles = formData.app_roles || [];
                            if (e.target.checked) {
                              setFormData({ ...formData, app_roles: [...currentRoles.filter(r => r !== role), role] });
                            } else {
                              setFormData({ ...formData, app_roles: currentRoles.filter(r => r !== role) });
                            }
                          }}
                          className="w-4 h-4 text-emerald-600 border-gray-300 rounded focus:ring-emerald-500"
                        />
                        <Label htmlFor={`role-${role}`} className="font-normal capitalize cursor-pointer">{role}</Label>
                      </div>
                    ))}
                  </div>
                  {formData.app_roles.length === 0 && (
                    <p className="text-sm text-red-500 mt-1">Please select at least one role</p>
                  )}
                </div>

                {/* Store Assignment (for dispatchers) */}
                {formData.app_roles?.includes('dispatcher') && (
                  <div>
                    <Label>Assigned Stores *</Label>
                    <MultiSelect
                      options={storeOptions}
                      value={formData.store_ids || []}
                      onChange={(value) => setFormData({ ...formData, store_ids: value })}
                      placeholder="Select stores..."
                    />
                    <p className="text-xs text-slate-500 mt-1">Dispatchers can only see patients/deliveries for their assigned stores</p>
                  </div>
                )}

                {/* Status & Sort Order */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="status">Status</Label>
                    <Select
                      value={formData.status || 'active'}
                      onValueChange={(value) => setFormData({ ...formData, status: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="inactive">Inactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="sort_order">Sort Order</Label>
                    <Input
                      id="sort_order"
                      type="number"
                      value={formData.sort_order ?? ''}
                      onChange={(e) => setFormData({ ...formData, sort_order: e.target.value ? parseInt(e.target.value) : 0 })}
                      placeholder="0"
                    />
                    <p className="text-xs text-slate-500 mt-1">Lower numbers appear first</p>
                  </div>
                </div>

                {/* Location Tracking Toggle (for drivers) */}
                {formData.app_roles?.includes('driver') && (
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="location_tracking"
                      checked={formData.location_tracking_enabled ?? true}
                      onChange={(e) => setFormData({ ...formData, location_tracking_enabled: e.target.checked })}
                      className="w-4 h-4 text-emerald-600 border-gray-300 rounded focus:ring-emerald-500"
                    />
                    <Label htmlFor="location_tracking" className="font-normal cursor-pointer">
                      Enable Location Tracking (Drivers only)
                    </Label>
                  </div>
                )}

                {/* Form Actions */}
                <div className="flex justify-end gap-3 pt-4 border-t">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowForm(false);
                      setEditingUser(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSaving}>
                    {isSaving ? (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      editingUser ? 'Update User' : 'Create User'
                    )}
                  </Button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}