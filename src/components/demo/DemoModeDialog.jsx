import React, { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { GoogleAddressAutocomplete } from '@/components/ui/google-address-autocomplete';

export default function DemoModeDialog({ open, onOpenChange }) {
  const [settings, setSettings] = useState(null);
  const [stores, setStores] = useState([]);
  const [patients, setPatients] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [cities, setCities] = useState([]);
  const [address, setAddress] = useState('');
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadData = async () => {
    const me = await base44.auth.me();
    const [settingsRows, storeRows, patientRows, routeRows, cityRows] = await Promise.all([
      base44.entities.DemoSettings.filter({ user_id: me.id }),
      base44.entities.DemoStore.list(),
      base44.entities.DemoPatient.list(),
      base44.entities.DemoRoute.list(),
      base44.entities.City.list()
    ]);
    setSettings(settingsRows[0] || null);
    setStores((storeRows || []).filter((item) => item.is_demo));
    setPatients((patientRows || []).filter((item) => item.is_demo));
    setRoutes((routeRows || []).filter((item) => item.is_demo));
    setCities(cityRows || []);
  };

  useEffect(() => {
    if (open) {
      setAddress('');
      setSelectedAddress(null);
      loadData();
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
    if (settings?.id) {
      await base44.entities.DemoSettings.update(settings.id, { is_demo_mode_active: false });
    }
    window.dispatchEvent(new CustomEvent('demoModeChanged'));
    onOpenChange(false);
  };

  const startNewDemo = async () => {
    if (loading) return;
    setLoading(true);

    const hasSelectedAddress = selectedAddress?.latitude && selectedAddress?.longitude;

    if (hasSelectedAddress) {
      await Promise.all([
        ...(routes || []).map((item) => base44.entities.DemoRoute.delete(item.id)),
        ...(patients || []).map((item) => base44.entities.DemoPatient.delete(item.id)),
        ...(stores || []).map((item) => base44.entities.DemoStore.delete(item.id))
      ]);

      await base44.functions.invoke('generateDemoData', {
        address: selectedAddress.full_address || selectedAddress.street_address || address,
        latitude: selectedAddress.latitude,
        longitude: selectedAddress.longitude,
        city_id: cityCenter?.id || null
      });
    } else {
      await Promise.all([
        ...(routes || []).map((item) => base44.entities.DemoRoute.delete(item.id)),
        ...(patients || []).map((item) => base44.entities.DemoPatient.delete(item.id)),
        ...(stores || []).map((item) => base44.entities.DemoStore.delete(item.id))
      ]);

      if (settings?.id) {
        await base44.entities.DemoSettings.update(settings.id, {
          demo_store_id: null,
          is_demo_mode_active: false
        });
      }
    }

    setAddress('');
    setSelectedAddress(null);
    await loadData();
    setLoading(false);
    window.dispatchEvent(new CustomEvent('demoModeChanged'));

    if (hasSelectedAddress) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Demo Mode</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2">
            <div className="text-sm">Demo stores: {stores.length}</div>
            <div className="text-sm">Demo routes: {routes.length}</div>
            <div className="text-sm">Last session: {lastSession ? new Date(lastSession).toLocaleString() : 'None'}</div>
            <div className="space-y-1">
              {patientCountByStore.map((store) => (
                <div key={store.id} className="text-sm">{store.name}: {store.count} patients</div>
              ))}
            </div>
          </div>

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
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={startNewDemo} disabled={loading}>
              {loading ? 'Creating…' : selectedAddress?.latitude && selectedAddress?.longitude ? 'New Demo' : 'Clear Data'}
            </Button>
            <Button variant="outline" onClick={activateDemo} disabled={!stores.length}>
              Continue Demo
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}