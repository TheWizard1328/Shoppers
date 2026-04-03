import { sortUsers } from "../utils/sorting";
import { getDriverNameForStorage } from "../utils/driverUtils";
import { resolvePatientDriverAssignment } from "./deliveryPatientSelectionHelpers";
import { buildSelectedPatientFormData } from "./deliveryPatientSelectionHelpers";

export const getCityDriversForDeliveryForm = ({ appUsers = [], selectedCityId }) => {
  const cityDrivers = (appUsers || []).filter((user) => {
    if (!user) return false;
    if (!Array.isArray(user.app_roles) || !user.app_roles.includes('driver')) return false;
    if (!(user.user_name || user.full_name || user.email)) return false;

    const userCityIds = Array.isArray(user.city_ids) ? user.city_ids : [];

    if (!selectedCityId || selectedCityId === 'all') return true;

    return user.city_id === selectedCityId || userCityIds.includes(selectedCityId);
  });

  return sortUsers(cityDrivers);
};

export const getDefaultDriverForStoreDate = ({ stores = [], allDrivers = [], storeId, deliveryDate }) => {
  if (!storeId || !deliveryDate) return null;

  const store = (stores || []).find((item) => item && item.id === storeId);
  if (!store) return null;

  const selectedDate = new Date(deliveryDate + 'T00:00:00');
  const dayOfWeek = selectedDate.getDay();
  const driverIdField = dayOfWeek === 6
    ? 'saturday_am_driver_id'
    : dayOfWeek === 0
      ? 'sunday_am_driver_id'
      : 'weekday_am_driver_id';

  const defaultDriverId = store[driverIdField];
  if (!defaultDriverId) return null;

  return (allDrivers || []).find((driver) => driver && driver.id === defaultDriverId) || null;
};

export const resolvePatientDriverSelection = ({
  patient,
  stores = [],
  allDrivers = [],
  deliveryDate,
  allDeliveries = [],
  formData
}) => {
  const patientStore = (stores || []).find((store) => store && store.id === patient?.store_id);
  const defaultDriver = getDefaultDriverForStoreDate({
    stores,
    allDrivers,
    storeId: patient?.store_id,
    deliveryDate
  });

  const assignment = resolvePatientDriverAssignment({
    patient,
    patientStore,
    deliveryDate,
    drivers: allDrivers,
    allDeliveries,
    getDriverNameForStorage
  });

  const resolvedDriverId = defaultDriver?.id || assignment.autoSelectedDriverId || '';
  const resolvedDriverName = defaultDriver
    ? getDriverNameForStorage(defaultDriver)
    : (assignment.autoSelectedDriverName || '');

  return {
    patientStore,
    deliveryAMPM: assignment.deliveryAMPM,
    resolvedDriverId,
    resolvedDriverName,
    shouldForceDriverSelection: !resolvedDriverId,
    updatedFormData: buildSelectedPatientFormData({
      formData,
      patient,
      deliveryAMPM: assignment.deliveryAMPM,
      autoSelectedDriverId: resolvedDriverId,
      autoSelectedDriverName: resolvedDriverName
    })
  };
};