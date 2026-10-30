// Domain migration status — shared color/label logic for the Devices panel
// (owner request Oct 29 2026).
//
// Every device stamps the host it is running on (flat `host` field, mirrored in
// device_info.host). This turns those host strings into ONE status per device
// and ONE roll-up per user, so the "View devices for" list and the device cards
// can be highlighted consistently:
//
//   green  — every device the user has is on the new domain
//   yellow — more than one device and at least one of them is NOT on the new
//            domain (partial migration)
//   red    — none of their (known) devices are on the new domain
//   blue   — preview/sandbox
//   neutral— no domain recorded yet (unknown)
//
// "New domain" = anything on or under wizardworxx.com, so every app subdomain
// (rxdeliver.wizardworxx.com, …) counts without hard-coding one host.

export const NEW_DOMAIN_SUFFIX = 'wizardworxx.com';

export const classifyDeviceHost = (host) => {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return 'unknown';
  if (/preview|sandbox/.test(h)) return 'preview';
  if (h === NEW_DOMAIN_SUFFIX || h.endsWith(`.${NEW_DOMAIN_SUFFIX}`)) return 'new';
  return 'old';
};

export const summarizeUserDevices = (devices = []) => {
  const kinds = (Array.isArray(devices) ? devices : [])
    .map((d) => classifyDeviceHost(d?.host || d?.device_info?.host));
  if (!kinds.length) return 'unknown';
  if (kinds.every((k) => k === 'unknown')) return 'unknown';
  const onNew = kinds.filter((k) => k === 'new').length;
  const onPreview = kinds.filter((k) => k === 'preview').length;
  if (onNew === kinds.length) return 'new';
  if (onNew > 0) return 'mixed';
  if (onPreview > 0) return 'preview';
  return 'old';
};

export const DOMAIN_STATUS = {
  new: {
    label: 'New domain',
    shortLabel: 'New',
    longLabel: 'All devices on the new domain',
    dot: 'bg-emerald-500',
    rowText: 'text-emerald-700 dark:text-emerald-300',
    rowBg: 'data-[highlighted]:bg-emerald-50 dark:data-[highlighted]:bg-emerald-500/10',
    chip: 'bg-emerald-100 text-emerald-800 border border-emerald-300/70 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-700/60',
    card: 'border-emerald-400/70 dark:border-emerald-500/60 bg-emerald-50/70 dark:bg-emerald-500/[0.07]',
    ring: 'ring-emerald-500/30',
  },
  mixed: {
    label: 'Mixed',
    shortLabel: 'Mixed',
    longLabel: 'More than one device, at least one NOT on the new domain',
    dot: 'bg-amber-500',
    rowText: 'text-amber-700 dark:text-amber-300',
    rowBg: 'data-[highlighted]:bg-amber-50 dark:data-[highlighted]:bg-amber-500/10',
    chip: 'bg-amber-100 text-amber-900 border border-amber-300/70 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-700/60',
    card: 'border-amber-400/70 dark:border-amber-500/60 bg-amber-50/70 dark:bg-amber-500/[0.07]',
    ring: 'ring-amber-500/30',
  },
  old: {
    label: 'Old domain',
    shortLabel: 'Old',
    longLabel: 'No device on the new domain',
    dot: 'bg-red-500',
    rowText: 'text-red-700 dark:text-red-300',
    rowBg: 'data-[highlighted]:bg-red-50 dark:data-[highlighted]:bg-red-500/10',
    chip: 'bg-red-100 text-red-800 border border-red-300/70 dark:bg-red-900/40 dark:text-red-200 dark:border-red-700/60',
    card: 'border-red-400/70 dark:border-red-500/60 bg-red-50/70 dark:bg-red-500/[0.07]',
    ring: 'ring-red-500/30',
  },
  preview: {
    label: 'Preview',
    shortLabel: 'Preview',
    longLabel: 'Running a preview/sandbox host',
    dot: 'bg-blue-500',
    rowText: 'text-blue-700 dark:text-blue-300',
    rowBg: 'data-[highlighted]:bg-blue-50 dark:data-[highlighted]:bg-blue-500/10',
    chip: 'bg-blue-100 text-blue-800 border border-blue-300/70 dark:bg-blue-900/40 dark:text-blue-200 dark:border-blue-700/60',
    card: 'border-blue-400/70 dark:border-blue-500/60 bg-blue-50/70 dark:bg-blue-500/[0.07]',
    ring: 'ring-blue-500/30',
  },
  unknown: {
    label: 'Unknown',
    shortLabel: 'Unknown',
    longLabel: 'No domain recorded yet',
    dot: 'bg-slate-400',
    rowText: 'text-soft',
    rowBg: '',
    chip: 'bg-slate-100 text-slate-700 border border-slate-300/70 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-600/60',
    card: 'border-surface bg-surface',
    ring: '',
  },
};

export const domainStatus = (kind) => DOMAIN_STATUS[kind] || DOMAIN_STATUS.unknown;
