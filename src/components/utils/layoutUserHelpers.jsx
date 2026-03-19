export const createMergedUser = (authUser, appUser) => {
  if (!authUser && !appUser) {
    return null;
  }

  if (!authUser && appUser) {
    return {
      id: appUser.user_id,
      user_id: appUser.user_id,
      email: null,
      full_name: appUser.user_name || 'Unknown User',
      user_name: appUser.user_name || 'Unknown User',
      display_name: appUser.user_name || 'Unknown User',
      app_roles: Array.isArray(appUser.app_roles) ? appUser.app_roles : [],
      status: appUser.status || 'inactive',
      driver_status: appUser.driver_status,
      city_id: appUser.city_id,
      store_ids: appUser.store_ids,
      sort_order: appUser.sort_order,
      phone: appUser.phone,
      home_latitude: appUser.home_latitude,
      home_longitude: appUser.home_longitude,
      current_latitude: appUser.current_latitude,
      current_longitude: appUser.current_longitude,
      location_updated_at: appUser.location_updated_at,
      location_tracking_enabled: appUser.location_tracking_enabled
    };
  }

  let merged = {
    ...authUser,
    id: authUser.id,
    user_name: authUser.full_name,
    display_name: authUser.full_name,
    app_roles: [],
    status: 'inactive'
  };

  if (appUser) {
    merged = {
      ...merged,
      ...appUser,
      id: authUser.id,
      user_name: appUser.user_name !== undefined && appUser.user_name !== null ? appUser.user_name : merged.user_name,
      display_name: appUser.user_name !== undefined && appUser.user_name !== null ? appUser.user_name : merged.display_name,
      app_roles: Array.isArray(appUser.app_roles) ? appUser.app_roles : merged.app_roles,
      status: appUser.status !== undefined && appUser.status !== null ? appUser.status : merged.status
    };
  }

  return merged;
};

export const buildBrandingFromCompany = (company) => ({
  logo_url: company?.logo_url || '',
  favicon_url: company?.favicon_url || '',
  primary_color: company?.primary_color || '#000000',
  secondary_color: company?.secondary_color || '#FFFFFF',
  accent_color: company?.accent_color || '#0066CC'
});