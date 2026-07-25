import { useMemo } from 'react';
import { format } from 'date-fns';

const addMinutesToTime = (timeString, minutesToAdd) => {
  if (!timeString) return null;
  const [hours, minutes] = timeString.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes)) return timeString;
  const total = hours * 60 + minutes + minutesToAdd;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
};

const estimateDriveTimeMinutes = (lat1, lng1, lat2, lng2) => {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 10;
  const toRad = (v) => v * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(5, Math.min(Math.round(R * c / 30 * 60), 60));
};

const EXCLUSION_REGEX = new RegExp(['\\(Old', '\\(Wrong', '\\(Deceased', 'DMR', 'RFD', 'RTN', 'Return', '\\(ISP\\)', '\\(ISD\\)', 'InterStore'].join('|'), 'i');

const getFrequencyPriority = (patient) => {
  const n = (patient.notes || '').toLowerCase();
  if (n.includes('daily')) return 1;
  if (n.includes('weekly') && !n.includes('bi-weekly') && !n.includes('weekly x4')) return 2;
  if (n.includes('bi-weekly')) return 3;
  if (n.includes('weekly x4')) return 4;
  if (n.includes('monthly')) return 5;
  return 6;
};

export function useProjectedRoutes({ activeDriver, activeDriverDeliveries, stores, effectivePatients, allPatients, selectedDate }) {
  return useMemo(() => {
    if (!activeDriver || activeDriverDeliveries.length > 0) {
      return { pickups: [], deliveries: [], stopOrderMap: {} };
    }

    const dateObj = selectedDate instanceof Date ? selectedDate : new Date(selectedDate);
    const dateString = !isNaN(dateObj.getTime()) ? format(dateObj, 'yyyy-MM-dd') : String(selectedDate || '');
    if (!dateString) return { pickups: [], deliveries: [], stopOrderMap: {} };

    const day = dateObj.getDay();
    const isSaturday = day === 6;
    const isSunday = day === 0;

    const driverName = activeDriver.user_name || activeDriver.full_name || '';
    if (!driverName) return { pickups: [], deliveries: [], stopOrderMap: {} };

    const patientsSource = (Array.isArray(effectivePatients) && effectivePatients.length ? effectivePatients : allPatients) || [];

    const matchesDriver = (store, field) =>
      store[field] === activeDriver.id || store[field] === activeDriver.appUserId || store[field] === driverName;

    const relevantStores = (stores || []).filter((store) => {
      if (isSaturday) return matchesDriver(store, 'driver_saturday_am_id') && store.saturday_am_enabled || matchesDriver(store, 'driver_saturday_pm_id') && store.saturday_pm_enabled;
      if (isSunday) return matchesDriver(store, 'sunday_am_driver_id') && store.sunday_am_enabled || matchesDriver(store, 'sunday_pm_driver_id') && store.sunday_pm_enabled;
      return matchesDriver(store, 'weekday_am_driver_id') && store.weekday_am_enabled || matchesDriver(store, 'weekday_pm_driver_id') && store.weekday_pm_enabled;
    }).sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999));

    const pickups = [];
    const flatDeliveries = [];
    const stopOrderMap = {};
    let segmentIndex = 0;

    relevantStores.forEach((store) => {
      const timeSlots = [];
      if (isSaturday) {
        if (store.saturday_am_enabled && matchesDriver(store, 'driver_saturday_am_id')) timeSlots.push({ period: 'am', start: store.saturday_am_start, end: store.saturday_am_end });
        if (store.saturday_pm_enabled && matchesDriver(store, 'driver_saturday_pm_id')) timeSlots.push({ period: 'pm', start: store.saturday_pm_start, end: store.saturday_pm_end });
      } else if (isSunday) {
        if (store.sunday_am_enabled && matchesDriver(store, 'sunday_am_driver_id')) timeSlots.push({ period: 'am', start: store.sunday_am_start, end: store.sunday_am_end });
        if (store.sunday_pm_enabled && matchesDriver(store, 'sunday_pm_driver_id')) timeSlots.push({ period: 'pm', start: store.sunday_pm_start, end: store.sunday_pm_end });
      } else {
        if (store.weekday_am_enabled && matchesDriver(store, 'weekday_am_driver_id')) timeSlots.push({ period: 'am', start: store.weekday_am_start, end: store.weekday_am_end });
        if (store.weekday_pm_enabled && matchesDriver(store, 'weekday_pm_driver_id')) timeSlots.push({ period: 'pm', start: store.weekday_pm_start, end: store.weekday_pm_end });
      }

      timeSlots.forEach(({ period, start, end }) => {
        if (!start) return;
        segmentIndex += 1;
        const isAM = period === 'am';
        const storeAbbr = store.abbreviation || 'ST';
        const baseSegment = segmentIndex * 100;

        const storePatients = patientsSource
          .filter((p) => p?.status === 'active' && p.store_id === store.id)
          .filter((p) => {
            if (EXCLUSION_REGEX.test(`${p.full_name || ''} ${p.address || ''} ${p.notes || ''}`)) return false;
            return isAM ? !(p.notes || '').toLowerCase().includes('pm delivery') : !(p.notes || '').toLowerCase().includes('am delivery');
          })
          .map((p) => ({
            id: `projected-delivery-${p.id}-${dateString}-${period}-${store.id}`,
            patient_id: p.id, patient_name: p.full_name, store_id: p.store_id,
            driver_name: driverName, delivery_date: dateString, delivery_address: p.address,
            delivery_instructions: p.notes, latitude: p.latitude, longitude: p.longitude,
            delivery_time_start: p.time_window_start || null, delivery_time_end: p.time_window_end || null,
            status: 'projected', isProjected: true, isPickup: false, phone: p.phone,
            tracking_number: 'temp', frequencyPriority: getFrequencyPriority(p),
            distance_from_store: p.distance_from_store || 0
          }))
          .sort((a, b) => {
            if (a.frequencyPriority !== b.frequencyPriority) return a.frequencyPriority - b.frequencyPriority;
            const tA = a.delivery_time_start || '00:00', tB = b.delivery_time_start || '00:00';
            if (tA !== tB) return tA.localeCompare(tB);
            if (a.distance_from_store !== b.distance_from_store) return a.distance_from_store - b.distance_from_store;
            return a.patient_name.localeCompare(b.patient_name);
          });

        const pickupCard = {
          id: `projected-pickup-${store.id}-${dateString}-${period}-${segmentIndex}`,
          patient_id: null, store_id: store.id, delivery_date: dateString,
          delivery_time_start: start, delivery_time_end: end || addMinutesToTime(start, 60),
          status: 'projected', driver_name: driverName,
          tracking_number: `${storeAbbr}PU${String(segmentIndex).padStart(2, '0')}`,
          delivery_notes: 'Projected Pickup', delivery_address: store.address,
          isProjected: true, isPickup: true, sortTime: start,
          latitude: store.latitude, longitude: store.longitude,
          full_name: `${store.name} ${period.toUpperCase()} Pickup`,
          alias_name: store.abbreviation, color: store.color, projected_deliveries: [], phone: store.phone
        };

        let currentTime = pickupCard.delivery_time_end;
        let lastLat = store.latitude, lastLng = store.longitude;

        storePatients.forEach((d, idx) => {
          const drive = estimateDriveTimeMinutes(lastLat, lastLng, d.latitude, d.longitude);
          currentTime = addMinutesToTime(currentTime, drive);
          if (d.delivery_time_start && currentTime && d.delivery_time_start > currentTime) currentTime = d.delivery_time_start;
          d.delivery_time_start = currentTime;
          d.delivery_time_end = addMinutesToTime(currentTime, 15);
          d.sortTime = currentTime;
          d.tracking_number = `${storeAbbr}${String(baseSegment + idx + 1).padStart(3, '0')}`;
          lastLat = d.latitude; lastLng = d.longitude;
          pickupCard.projected_deliveries.push(d);
          flatDeliveries.push(d);
        });

        pickups.push(pickupCard);
        flatDeliveries.push(pickupCard);
      });
    });

    flatDeliveries.sort((a, b) => {
      const tA = a.sortTime || a.delivery_time_start || '00:00';
      const tB = b.sortTime || b.delivery_time_start || '00:00';
      if (tA !== tB) return tA.localeCompare(tB);
      return (a.tracking_number || '').localeCompare(b.tracking_number || '');
    });
    flatDeliveries.forEach((s, i) => { stopOrderMap[s.id] = i + 1; });
    pickups.sort((a, b) => (a.sortTime || '00:00').localeCompare(b.sortTime || '00:00'));

    return { pickups, deliveries: flatDeliveries, stopOrderMap };
  }, [activeDriver, activeDriverDeliveries.length, stores, effectivePatients, allPatients, selectedDate]);
}