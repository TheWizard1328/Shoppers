import React, { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import StoreCard from "../components/stores/StoreCard";
import StoreForm from "../components/stores/StoreForm";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { getData, invalidate } from "../components/utils/dataManager";
import { createStoreLocal, updateStoreLocal, deleteStoreLocal } from "../components/utils/offlineMutations";
import { offlineDB } from "../components/utils/offlineDatabase";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { sortStores } from "../components/utils/sorting";
import { mergeUsersWithAppUsers } from "../components/utils/driverUtils";
import { userHasRole } from "../components/utils/userRoles";
import { useUser } from "../components/utils/UserContext";
import { useAppData } from "../components/utils/AppDataContext";
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';
import StoreOnlineStatusBanner from '../components/stores/StoreOnlineStatusBanner';

export default function StoresPage() {
  const { currentUser } = useUser();
  const { 
    stores: contextStores = [], 
    cities: contextCities = [], 
    users: contextUsers = [],
    appUsers: contextAppUsers = [],
    isDataLoaded: contextDataLoaded 
  } = useAppData();
  const [stores, setStores] = useState(() => contextStores.length ? sortStores(contextStores) : []);
  const [cities, setCities] = useState(() => contextCities.length ? contextCities : []);

  // Hydrate stores from offline IndexedDB on mount — runs before AppDataContext syncs
  useEffect(() => {
    if (stores.length > 0) return; // already seeded from context
    (async () => {
      try {
        const { offlineDB } = await import('../components/utils/offlineDatabase');
        const offlineStores = await offlineDB.getAll(offlineDB.STORES.STORES);
        if ((offlineStores || []).length > 0) setStores(sortStores(offlineStores));
      } catch (_) { /* non-critical */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [drivers, setDrivers] = useState(() => {
    if (!contextUsers.length) return [];
    return contextUsers
      .filter(u => u && u.status === 'active' && (userHasRole(u, 'driver') || userHasRole(u, 'dispatcher') || userHasRole(u, 'admin')))
      .sort((a, b) => {
        const orderA = a.sort_order ?? Infinity;
        const orderB = b.sort_order ?? Infinity;
        if (orderA !== orderB) return orderA - orderB;
        return (a.user_name || a.full_name || '').localeCompare(b.user_name || b.full_name || '');
      });
  });
  const [allUsers, setAllUsers] = useState(() => contextUsers.length ? contextUsers : []);
  const [showForm, setShowForm] = useState(false);
  const [editingStore, setEditingStore] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const skipNextContextSync = React.useRef(false);

  useEffect(() => {
    loadData();

    const handleOfflineRecordReplaced = (event) => {
      const { entity, oldId, record } = event.detail || {};
      if (entity !== 'Store' || !oldId || !record) return;
      setStores(prev => sortStores(prev.map(store => store.id === oldId ? record : store)));
    };

    window.addEventListener('offlineMutationRecordReplaced', handleOfflineRecordReplaced);

    // Listen for store updates from StoreCard (app fees checkbox, etc.)
    // CRITICAL: Always merge surgically — never fetch/replace. A full reload on every
    // store update would clear unmatched stores from React state, causing all devices to
    // lose stores that don't match the current city/date filter in AppDataContext.
    const handleStoreUpdated = async (event) => {
      const { storeId, updatedStore } = event.detail || {};
      if (!storeId || !updatedStore) return;
      setStores(prev => sortStores(prev.map(store => store.id === storeId ? { ...store, ...updatedStore } : store)));
    };
    window.addEventListener('storeUpdated', handleStoreUpdated);
    return () => {
      window.removeEventListener('offlineMutationRecordReplaced', handleOfflineRecordReplaced);
      window.removeEventListener('storeUpdated', handleStoreUpdated);
    };
  }, []);

  // WebSocket real-time subscription for Store entity changes
  useEffect(() => {
    const unsubscribe = base44.entities.Store.subscribe((event) => {
      console.log(`📡 [Stores] WebSocket: Store ${event.id} ${event.type}`);
      if (event.type === 'create') {
        setStores(prev => sortStores([...prev.filter(s => s.id !== event.id), event.data]));
        if (event.data) {
          offlineDB.bulkSave(offlineDB.STORES.STORES, [event.data]).catch(() => {});
        }
      } else if (event.type === 'update') {
        setStores(prev => sortStores(prev.map(s => s.id === event.id ? { ...s, ...event.data } : s)));
        if (event.data) {
          offlineDB.bulkSave(offlineDB.STORES.STORES, [event.data]).catch(() => {});
        }
      } else if (event.type === 'delete') {
        setStores(prev => prev.filter(s => s.id !== event.id));
        offlineDB.deleteRecord(offlineDB.STORES.STORES, event.id).catch(() => {});
      }
    });
    return unsubscribe;
  }, []);

  // Sync context data for real-time updates - OPTIMIZED to prevent unnecessary re-renders
  // CRITICAL: Always MERGE context stores into local state — never replace. Context stores
  // may be city-filtered (from Layout's AppDataContext). Replacing local stores with a
  // filtered subset would wipe out stores from other cities on ALL devices simultaneously.
  useEffect(() => {
    if (contextDataLoaded) {
      if (contextStores.length > 0 && stores.length > 0) {
        // Skip one sync cycle after a local save to avoid overwriting our optimistic state
        if (skipNextContextSync.current) {
          skipNextContextSync.current = false;
        } else {
          // MERGE: only apply stores from context that are updates to existing local stores
          // or new stores (created elsewhere). Never remove stores that context doesn't have.
          const contextMap = new Map(contextStores.map(s => [s.id, s]));
          const merged = stores.map(s => contextMap.has(s.id) ? { ...s, ...contextMap.get(s.id) } : s);
          // Add any stores from context that are completely new
          contextStores.forEach(cs => {
            if (!merged.some(m => m.id === cs.id)) merged.push(cs);
          });
          const sortedStores = sortStores(merged);
          if (JSON.stringify(sortedStores) !== JSON.stringify(stores)) {
            console.log("🔄 [Stores] Merging updated stores from AppDataContext");
            setStores(sortedStores);
          }
        }
      } else if (contextStores.length > 0 && stores.length === 0) {
        // Only if stores is empty, accept context stores as initial seed
        const sortedStores = sortStores(contextStores);
        if (JSON.stringify(sortedStores) !== JSON.stringify(stores)) {
          console.log("🔄 [Stores] Seeding stores from AppDataContext");
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
          (userHasRole(user, 'driver') || userHasRole(user, 'dispatcher') || userHasRole(user, 'admin'))
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

      // Filter to only active drivers/dispatchers/admins
      const activeDrivers = mergedUsers.filter(user =>
        user &&
        user.status === 'active' &&
        (userHasRole(user, 'driver') || userHasRole(user, 'dispatcher') || userHasRole(user, 'admin'))
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
      let savedStore;
      if (editingStore) {
        savedStore = await updateStoreLocal(editingStore.id, storeData);
        setStores(prev => sortStores(prev.map(s => s.id === editingStore.id ? savedStore : s)));
      } else {
        savedStore = await createStoreLocal(storeData);
        setStores(prev => sortStores([...prev, savedStore]));
      }

      // Close form first to prevent re-render issues
      setShowForm(false);
      setEditingStore(null);

      // Skip the next context sync so our optimistic local state isn't overwritten
      skipNextContextSync.current = true;

      // Dispatch a targeted store update event so Layout merges just this store
      // without triggering a full data reload (which invalidate('Store') would cause).
      window.dispatchEvent(new CustomEvent('storeUpdated', {
        detail: { storeId: savedStore?.id, updatedStore: savedStore }
      }));
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
      await deleteStoreLocal(storeId);
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
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>
      {/* Static header */}
      <div className="flex-shrink-0 px-6 pt-6 pb-4 max-w-7xl w-full mx-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <SmartRefreshIndicator inline={true} />
            <div>
              <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Stores</h1>
              <p className="mt-1" style={{ color: 'var(--text-slate-600)' }}>
                Manage your pharmacy store locations and schedules
              </p>
            </div>
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

        {/* Online Status Banner */}
        <StoreOnlineStatusBanner stores={stores} appUsers={contextAppUsers} />
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="max-w-8xl mx-auto">
          {stores.length > 0 ? (
            <div className="grid gap-5 justify-center" style={{ gridTemplateColumns: 'repeat(auto-fit, 400px)' }}>
              {stores.map((store) => (
                <StoreCard
                  key={store.id}
                  store={store}
                  onEdit={handleEditStore}
                  onDelete={handleDeleteStore}
                  onSave={handleSaveStore}
                  currentUser={currentUser}
                  drivers={drivers}
                  isLimitedView={currentUser && !userHasRole(currentUser, 'admin')}
                  hideEditDelete={currentUser && userHasRole(currentUser, 'dispatcher')}
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
        </div>
      </div>

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
  );
}