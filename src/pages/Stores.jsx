import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import StoreCard from "../components/stores/StoreCard";
import StoreForm from "../components/stores/StoreForm";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { getData, invalidate } from "../components/utils/dataManager";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { sortStores } from "../components/utils/sorting";
import { mergeUsersWithAppUsers } from "../components/utils/driverUtils";
import { userHasRole } from "../components/utils/userRoles";
import { useUser } from "../components/utils/UserContext";
import { useAppData } from "../components/utils/AppDataContext";

export default function StoresPage() {
  const { currentUser } = useUser();
  const { 
    stores: contextStores = [], 
    cities: contextCities = [], 
    users: contextUsers = [], 
    isDataLoaded: contextDataLoaded 
  } = useAppData();
  const [stores, setStores] = useState([]);
  const [cities, setCities] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingStore, setEditingStore] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  // Sync context data for real-time updates
  useEffect(() => {
    if (contextDataLoaded) {
      console.log("🔄 [Stores] Syncing data from AppDataContext");
      if (contextStores.length > 0) {
        const sortedStores = sortStores(contextStores);
        setStores(sortedStores);
      }
      if (contextCities.length > 0) {
        setCities(contextCities);
      }
      if (contextUsers.length > 0) {
        const activeDrivers = contextUsers.filter(user =>
          user &&
          user.status === 'active' &&
          (userHasRole(user, 'driver') || userHasRole(user, 'admin'))
        );
        const sortedDrivers = activeDrivers.sort((a, b) => {
          const orderA = a.sort_order ?? Infinity;
          const orderB = b.sort_order ?? Infinity;
          if (orderA !== orderB) return orderA - orderB;
          const nameA = a.user_name || a.full_name || '';
          const nameB = b.user_name || b.full_name || '';
          return nameA.localeCompare(nameB);
        });
        setDrivers(sortedDrivers);
        setAllUsers(contextUsers);
      }
    }
  }, [contextDataLoaded, contextStores, contextCities, contextUsers]);

  const loadData = async () => {
    try {
      setIsLoading(true);

      // Fetch stores and cities
      const [storesData, citiesData, authUsers, appUsers] = await Promise.all([
        getData('Store'),
        getData('City'),
        getData('User'),
        getData('AppUser')
      ]);

      // Merge users
      const mergedUsers = mergeUsersWithAppUsers(authUsers || [], appUsers || []);

      // Filter to only active drivers/admins
      const activeDrivers = mergedUsers.filter(user =>
        user &&
        user.status === 'active' &&
        (userHasRole(user, 'driver') || userHasRole(user, 'admin'))
      );

      // Sort stores and drivers
      const sortedStores = sortStores(storesData || []);
      const sortedDrivers = activeDrivers.sort((a, b) => {
        const orderA = a.sort_order ?? Infinity;
        const orderB = b.sort_order ?? Infinity;
        if (orderA !== orderB) return orderA - orderB;
        const nameA = a.user_name || a.full_name || '';
        const nameB = b.user_name || b.full_name || '';
        return nameA.localeCompare(nameB);
      });

      setStores(sortedStores);
      setCities(citiesData || []);
      setDrivers(sortedDrivers);
      setAllUsers(mergedUsers);
    } catch (error) {
      console.error("Error loading data:", error);
      alert("Failed to load stores. Please refresh the page.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddStore = () => {
    setEditingStore(null);
    setShowForm(true);
  };

  const handleEditStore = (store) => {
    setEditingStore(store);
    setShowForm(true);
  };

  const handleSaveStore = async (storeData) => {
    try {
      if (editingStore) {
        await base44.entities.Store.update(editingStore.id, storeData);
      } else {
        await base44.entities.Store.create(storeData);
      }

      // Close form first to prevent re-render issues
      setShowForm(false);
      setEditingStore(null);

      // Then reload data
      invalidate('Store');
      await loadData();
    } catch (error) {
      console.error("Error saving store:", error);
      throw error;
    }
  };

  const handleDeleteStore = async (storeId) => {
    if (!confirm("Are you sure you want to delete this store? This action cannot be undone.")) {
      return;
    }

    try {
      await base44.entities.Store.delete(storeId);
      invalidate('Store');
      await loadData();
    } catch (error) {
      console.error("Error deleting store:", error);
      alert("Failed to delete store. Please try again.");
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-slate-600">Loading stores...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Stores</h1>
            <p className="text-slate-600 mt-1">
              Manage your pharmacy store locations and schedules
            </p>
          </div>
          {currentUser && userHasRole(currentUser, 'admin') && (
            <Button
              onClick={handleAddStore}
              className="bg-emerald-500 hover:bg-emerald-600"
            >
              <Plus className="w-5 h-5 mr-2" />
              Add Store
            </Button>
          )}
        </div>

        {stores.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {stores.map((store) => (
              <StoreCard
                key={store.id}
                store={store}
                onEdit={handleEditStore}
                onDelete={handleDeleteStore}
                onSave={handleSaveStore}
                currentUser={currentUser}
                drivers={drivers}
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-slate-500 mb-4">No stores found</p>
            {currentUser && userHasRole(currentUser, 'admin') && (
              <Button onClick={handleAddStore} variant="outline">
                <Plus className="w-4 h-4 mr-2" />
                Add Your First Store
              </Button>
            )}
          </div>
        )}

        <Dialog open={showForm} onOpenChange={setShowForm}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <StoreForm
              store={editingStore}
              onSave={handleSaveStore}
              onCancel={() => {
                setShowForm(false);
                setEditingStore(null);
              }}
              cities={cities}
              drivers={drivers}
              allUsers={allUsers}
            />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}