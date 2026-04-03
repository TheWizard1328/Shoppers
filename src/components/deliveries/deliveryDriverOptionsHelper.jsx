import { sortUsers } from "../utils/sorting";

export const getCityDriversForDeliveryForm = ({ appUsers = [], selectedCityId }) => {
  const cityDrivers = (appUsers || []).filter((user) => {
    if (!user) return false;
    if (!Array.isArray(user.app_roles) || !user.app_roles.includes('driver')) return false;
    if (!(user.user_name || user.full_name || user.email)) return false;

    const userCityIds = Array.isArray(user.city_ids) ? user.city_ids : [];

    if (!selectedCityId || selectedCityId === 'all') {
      return true;
    }

    return user.city_id === selectedCityId || userCityIds.includes(selectedCityId);
  });

  return sortUsers(cityDrivers);
};