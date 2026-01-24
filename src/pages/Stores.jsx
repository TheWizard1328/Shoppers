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
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';

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

    // Listen for store updates from StoreCard (app fees checkbox, etc.)
    const handleStoreUpdated = async (event) => {
      const { storeId } = event.detail || {};
      if (storeId) {
        // Fetch fresh store data
        const freshStores = await getData('Store', null, null, true);
        setStores(sortStores(freshStores || []));
      }
    };
    window.addEventListener('storeUpdated', handleStoreUpdated);
    return () => window.removeEventListener('storeUpdated', handleStoreUpdated);
  }, []);

  // Sync context data for real-time updates - OPTIMIZED to prevent unnecessary re-renders
  useEffect(() => {
    if (contextDataLoaded) {
      // CRITICAL: Only update state if data actually changed (prevent re-renders)
      if (contextStores.length > 0 && contextStores !== stores) {
        const sortedStores = sortStores(contextStores);
        // Deep compare to avoid re-renders when data is identical
        if (JSON.stringify(sortedStores) !== JSON.stringify(stores)) {
          console.log("🔄 [Stores] Syncing stores from AppDataContext");
          setStores(sortedStores);
        }
      }
      if (contextCities.length > 0 && JSON.stringify(contextCities) !== JSON.stringify(cities)) {
        console.log("🔄 [Stores] Syncing cities from AppDataContext");
        setCities(contextCities);
      }
      if (contextUsers.length > 0 && contextUsers !== allUsers) {
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
        
        // Only update if data changed
        if (JSON.stringify(sortedDrivers) !== JSON.stringify(drivers)) {
          console.log("🔄 [Stores] Syncing drivers from AppDataContext");
          setDrivers(sortedDrivers);
        }
        if (JSON.stringify(contextUsers) !== JSON.stringify(allUsers)) {
          setAllUsers(contextUsers);
        }
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
        // Update local state immediately
        setStores(prev => prev.map(s => s.id === editingStore.id ? { ...s, ...storeData, updated_date: new Date().toISOString() } : s));
      } else {
        const newStore = await base44.entities.Store.create(storeData);
        // Add to local state immediately
        setStores(prev => [...prev, newStore]);
      }

      // Close form first to prevent re-render issues
      setShowForm(false);
      setEditingStore(null);

      // Then invalidate cache for background sync
      invalidate('Store');
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
      // Update local state immediately
      setStores(prev => prev.filter(s => s.id !== storeId));
      invalidate('Store');
    } catch (error) {
      console.error("Error deleting store:", error);
      alert("Failed to delete store. Please try again.");
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p style={{ color: 'var(--text-slate-600)' }}>Loading stores...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <SmartRefreshIndicator inline={true} />
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Stores</h1>
            <p className="mt-1" style={{ color: 'var(--text-slate-600)' }}>
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
            {stores.filter(s => s && s.status === 'active').map((store) => (
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
            <p className="mb-4" style={{ color: 'var(--text-slate-500)' }}>No stores found</p>
            {currentUser && userHasRole(currentUser, 'admin') && (
              <Button onClick={handleAddStore} variant="outline" style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
                <Plus className="w-4 h-4 mr-2" />
                Add Your First Store
              </Button>
            )}
          </div>
        )}

        <Dialog open={showForm} onOpenChange={setShowForm}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
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