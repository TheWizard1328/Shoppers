import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { getData } from '@/components/utils/dataManager';
import { GoogleAddressAutocomplete } from '@/components/ui/google-address-autocomplete';
import { locationTracker } from '@/components/utils/locationTracker';
import { userHasRole } from '@/components/utils/userRoles';
import { Calendar, Loader2, Sparkles } from 'lucide-react';

export default function DemoModeDialog({ open, onOpenChange }) {
  const [settings, setSettings] = useState(null);
  const [stores, setStores] = useState([]);
  const [patients, setPatients] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [cities, setCities] = useState([]);
  const [address, setAddress] = useState('');
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generatingWeek, setGeneratingWeek] = useState(false);
  const [weekResult, setWeekResult] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState('HERE_API_KEY');
  const didAutofillRef = useRef(false);

  const isAdmin = currentUser ? userHasRole(currentUser, 'admin') : false;

  const loadData = async () => {
    const me = await base44.auth.me();
    setCurrentUser(me);
    const [settingsRows, storeRows, patientRows, routeRows, cityRows, appSettingsRows] = await Promise.all([
      base44.entities.DemoSettings.filter({ user_id: me.id }),
      base44.entities.DemoStore.list(),
      base44.entities.DemoPatient.list(),
      base44.entities.DemoRoute.list(),
      getData('City'),
      base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' })
    ]);
    const activeSettings = settingsRows[0] || null;
    const activeDemoStoreId = activeSettings?.demo_store_id || null;
    const demoStores = (storeRows || []).filter((item) => item.is_demo && (!activeDemoStoreId || item.id === activeDemoStoreId));
    const demoStoreIds = demoStores.map((item) => item.id);

    setSettings(activeSettings);
    setStores(demoStores);
    setPatients((patientRows || []).filter((item) => item.is_demo && (demoStoreIds.length === 0 || demoStoreIds.includes(item.store_id))));
    setRoutes((routeRows || []).filter((item) => item.is_demo && (demoStoreIds.length === 0 || demoStoreIds.includes(item.store_id))));
    setCities(cityRows || []);
    setSelectedApiKey(appSettingsRows?.[0]?.setting_value?.selected_api_key || 'HERE_API_KEY');
  };

  const autofillNearestAddress = async () => {
    if (didAutofillRef.current) return;

    // Use the tracker's cached position (already ≤15s old, no timeout)
    // Falls back to a one-shot getCurrentPosition if the tracker isn't running.
    const cached = locationTracker.getCachedPosition();
    let latitude, longitude;
    if (cached) {
      latitude = cached.latitude;
      longitude = cached.longitude;
    } else {
      if (!navigator.geolocation) return;
      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 300000
          });
        });
        latitude = position.coords.latitude;
        longitude = position.coords.longitude;
      } catch { return; }
    }
    const searchText = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    const response = await base44.functions.invoke('googlePlacesAutocomplete', {
      input: searchText,
      latitude,
      longitude
    });
    const predictions = response?.data?.predictions || response?.predictions || [];
    const closestMatch = predictions[0];

    if (!closestMatch?.place_id) return;

    const detailsResponse = await base44.functions.invoke('googlePlaceDetails', {
      place_id: closestMatch.place_id
    });
    const details = detailsResponse?.data || detailsResponse;
    const fullAddress = details?.formatted_address || closestMatch.description || '';
    const streetAddress = details?.address || fullAddress.split(',')[0]?.trim() || fullAddress;

    setAddress(streetAddress);
    setSelectedAddress({
      full_address: fullAddress,
      street_address: streetAddress,
      latitude: details?.latitude,
      longitude: details?.longitude,
      place_id: closestMatch.place_id,
      distance: closestMatch.distance ?? null
    });
    didAutofillRef.current = true;
  };

  useEffect(() => {
    if (open) {
      setAddress('');
      setSelectedAddress(null);
      setWeekResult(null);
      didAutofillRef.current = false;
      loadData();
      autofillNearestAddress().catch(() => {});
    }
  }, [open]);

  const activeStore = stores[0] || null;
  const cityCenter = useMemo(() => {
    if (activeStore?.city_id) {
      return cities.find((city) => city.id === activeStore.city_id) || null;
    }
    return cities[0] || null;
  }, [activeStore, cities]);

  const patientCountByStore = useMemo(() => {
    return stores.map((store) => ({
      id: store.id,
      name: store.name,
      count: patients.filter((patient) => patient.store_id === store.id).length
    }));
  }, [stores, patients]);

  const lastSession = useMemo(() => {
    const allDates = [...stores, ...patients, ...routes].map((item) => item.created_date).filter(Boolean).sort().reverse();
    return allDates[0] || null;
  }, [stores, patients, routes]);

  const activateDemo = async () => {
    const me = await base44.auth.me();
    if (settings?.id) {
      await base44.entities.DemoSettings.update(settings.id, { is_demo_mode_active: true });
    } else {
      await base44.entities.DemoSettings.create({ user_id: me.id, is_demo_mode_active: true, demo_store_id: activeStore?.id || null });
    }
    window.dispatchEvent(new CustomEvent('demoModeChanged'));
    onOpenChange(false);
  };

  const disableDemo = async () => {
    await clearExistingDemoData();
    if (settings?.id) {
      await base44.entities.DemoSettings.update(settings.id, { is_demo_mode_active: false, demo_store_id: null });
    }
    window.dispatchEvent(new CustomEvent('demoModeChanged'));
    window.location.reload();
  };

  const clearExistingDemoData = async () => {
    const [storeRows, patientRows, routeRows, appUserRows] = await Promise.all([
      base44.entities.DemoStore.list(),
      base44.entities.DemoPatient.list(),
      base44.entities.DemoRoute.list(),
      base44.entities.DemoAppUser.list()
    ]);

    const activeDemoStoreId = settings?.demo_store_id || null;
    const demoStoresToDelete = (storeRows || []).filter((item) => item.is_demo && (!activeDemoStoreId || item.id === activeDemoStoreId));
    const demoStoreIds = demoStoresToDelete.map((item) => item.id);

    await Promise.all([
      ...(routeRows || []).filter((item) => item.is_demo && (demoStoreIds.length === 0 || demoStoreIds.includes(item.store_id))).map((item) => base44.entities.DemoRoute.delete(item.id)),
      ...(patientRows || []).filter((item) => item.is_demo && (demoStoreIds.length === 0 || demoStoreIds.includes(item.store_id))).map((item) => base44.entities.DemoPatient.delete(item.id)),
      ...(appUserRows || []).filter((item) => item.is_demo).map((item) => base44.entities.DemoAppUser.delete(item.id)),
      ...demoStoresToDelete.map((item) => base44.entities.DemoStore.delete(item.id))
    ]);

    setStores([]);
    setPatients([]);
    setRoutes([]);
  };

  const startNewDemo = async () => {
    if (loading) return;
    setLoading(true);

    const hasSelectedAddress = selectedAddress?.latitude && selectedAddress?.longitude;
    const normalizedSelectedAddress = (selectedAddress?.full_address || selectedAddress?.street_address || address || '').toLowerCase().trim();
    const matchingStore = stores.find((item) => (item.address || '').toLowerCase().trim() === normalizedSelectedAddress);

    if (hasSelectedAddress) {
      await base44.functions.invoke('generateDemoData', {
        address: selectedAddress.full_address || selectedAddress.street_address || address,
        latitude: selectedAddress.latitude,
        longitude: selectedAddress.longitude,
        city_id: cityCenter?.id || null,
        shouldClearExisting: !matchingStore
      });
      window.dispatchEvent(new CustomEvent('triggerOfflineSyncNow'));
      setAddress('');
      setSelectedAddress(null);
      await loadData();
      window.dispatchEvent(new CustomEvent('demoModeChanged'));
      setLoading(false);
      return;
    }

    await clearExistingDemoData();
    window.dispatchEvent(new CustomEvent('demoModeChanged'));
    setLoading(false);
  };

  // Generate a realistic 1-week demo dataset using real driver/store data
  // with cycling routes, InterStore pickups/dropoffs, failures, and returns.
  const generateRealisticWeek = async () => {
    if (generatingWeek) return;
    setGeneratingWeek(true);
    setWeekResult(null);
    try {
      const res = await base44.functions.invoke('generateDemoWeekV2', {
        clear_existing: true
      });
      const data = res?.data || res;
      if (data?.error) {
        setWeekResult({ error: data.error });
        return;
      }
      setWeekResult(data);
      window.dispatchEvent(new CustomEvent('triggerOfflineSyncNow'));
      await loadData();
      window.dispatchEvent(new CustomEvent('demoModeChanged'));
    } catch (error) {
      setWeekResult({ error: error?.message || 'Failed to generate demo week' });
    } finally {
      setGeneratingWeek(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Demo Mode</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2">
            <div className="text-sm">Stores: {stores.length}</div>
            <div className="text-sm">Routes (Deliveries): {routes.length}</div>
            <div className="text-sm">Patients: {patients.length}</div>
            <div className="text-sm">Last session: {lastSession ? new Date(lastSession).toLocaleString() : 'None'}</div>
            <div className="text-sm">Active API key: {selectedApiKey}</div>
            <div className="space-y-1">
              {patientCountByStore.map((store) => (
                <div key={store.id} className="text-sm">{store.name}: {store.count} patients</div>
              ))}
            </div>
          </div>

          {/* Generate Realistic Week — admin only */}
          {isAdmin && (
            <div className="rounded-lg border border-blue-200 dark:border-blue-900 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-500" />
                <span className="text-sm font-medium">Realistic Week Generator</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Generates a full week of demo deliveries using real drivers, stores, cycling routes, InterStore, failures, and returns. Starts next Monday by default.
              </p>
              {weekResult?.error && (
                <p className="text-xs text-red-500 font-medium">⚠️ {weekResult.error}</p>
              )}
              {weekResult?.success && (
                <div className="text-xs space-y-1">
                  <p className="text-green-600 font-medium">✅ Generated week starting {weekResult.week_start}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>Drivers: {weekResult.stats?.drivers}</span>
                    <span>Stores: {weekResult.stats?.stores}</span>
                    <span>Routes: {weekResult.stats?.total_routes_in_db}</span>
                    <span>Patients: {weekResult.stats?.patients}</span>
                    {weekResult.stats?.cycling_markers > 0 && <span>Cycling: {weekResult.stats.cycling_markers}</span>}
                    {weekResult.stats?.interstore > 0 && <span>InterStore: {weekResult.stats.interstore}</span>}
                    {weekResult.stats?.failed > 0 && <span>Failed: {weekResult.stats.failed}</span>}
                    {weekResult.stats?.returns > 0 && <span>Returns: {weekResult.stats.returns}</span>}
                  </div>
                </div>
              )}
              <Button
                onClick={generateRealisticWeek}
                disabled={generatingWeek}
                className="w-full gap-2 bg-blue-600 hover:bg-blue-700 text-white">
                {generatingWeek ? (<><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>) : (<><Calendar className="w-4 h-4" /> Generate Realistic Week</>)}
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-sm font-medium">Demo store address</div>
            <GoogleAddressAutocomplete
              value={address}
              onChange={setAddress}
              onAddressSelect={setSelectedAddress}
              cityCenter={cityCenter}
              placeholder="Enter a demo store address"
            />
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={settings?.is_demo_mode_active ? disableDemo : () => onOpenChange(false)}
            >
              {settings?.is_demo_mode_active ? 'Exit Demo Mode' : 'Cancel'}
            </Button>
            <Button onClick={startNewDemo} disabled={loading}>
              {loading ? 'Creating…' : selectedAddress?.latitude && selectedAddress?.longitude ? 'New Demo' : 'Clear Data'}
            </Button>
            <Button variant="outline" onClick={activateDemo} disabled={!stores.length}>
              Continue
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
