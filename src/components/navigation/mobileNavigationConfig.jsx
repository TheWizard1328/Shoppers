const normalizePath = (path = '') => path.toLowerCase();

export const MOBILE_TAB_CONFIG = {
  dashboard: {
    rootPath: '/dashboard',
    matches: ['/', '/dashboard'],
  },
  patients: {
    rootPath: '/patients',
    matches: ['/patients'],
  },
  routes: {
    rootPath: '/deliveries',
    matches: ['/deliveries'],
  },
  scheduling: {
    rootPath: '/driverschedulecalendar',
    matches: ['/driverschedulecalendar'],
  },
  square: {
    rootPath: '/squaremanagement',
    matches: ['/squaremanagement'],
  },
  payroll: {
    rootPath: '/driverpayroll',
    matches: ['/driverpayroll'],
  },
  settings: {
    rootPath: '/settings',
    matches: ['/settings', '/devicesettings'],
  },
};

export function getTabKeyForPath(path = '') {
  const normalizedPath = normalizePath(path);

  return Object.entries(MOBILE_TAB_CONFIG).find(([, config]) =>
    config.matches.some((match) => normalizedPath === match || normalizedPath.startsWith(`${match}/`))
  )?.[0] || null;
}