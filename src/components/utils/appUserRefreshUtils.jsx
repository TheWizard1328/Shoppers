const normalizeArray = (value) => (
  Array.isArray(value)
    ? value.filter((item) => item !== undefined && item !== null).map(String).sort()
    : []
);

const isSameArray = (left, right) => {
  const normalizedLeft = normalizeArray(left);
  const normalizedRight = normalizeArray(right);

  if (normalizedLeft.length !== normalizedRight.length) return false;

  return normalizedLeft.every((item, index) => item === normalizedRight[index]);
};

export const shouldRefreshUserFromAppUser = (previousAppUser, nextAppUser) => {
  if (!nextAppUser) return false;
  if (!previousAppUser) return true;

  if (previousAppUser.status !== nextAppUser.status) return true;
  if (previousAppUser.driver_status !== nextAppUser.driver_status) return true;
  if (previousAppUser.user_name !== nextAppUser.user_name) return true;
  if (previousAppUser.location_tracking_enabled !== nextAppUser.location_tracking_enabled) return true;
  if (!isSameArray(previousAppUser.app_roles, nextAppUser.app_roles)) return true;
  if (!isSameArray(previousAppUser.store_ids, nextAppUser.store_ids)) return true;
  if (!isSameArray(previousAppUser.city_ids, nextAppUser.city_ids)) return true;
  if (!isSameArray(previousAppUser.square_location_ids, nextAppUser.square_location_ids)) return true;

  return false;
};