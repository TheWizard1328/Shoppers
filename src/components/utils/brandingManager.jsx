import { base44 } from '@/api/base44Client';

const DEFAULT_BRANDING = {
  name: 'RxDeliver',
  logo_url: '',
  favicon_url: '',
  primary_color: '#000000',
  secondary_color: '#FFFFFF',
  accent_color: '#0066CC'
};

let cachedBranding = null;
let _fallbackAttempted = false; // Prevent repeated API calls after a fallback
const BRANDING_LS_KEY = 'rxdeliver_cached_branding';

export function clearBrandingCache() { cachedBranding = null; _fallbackAttempted = false; try { localStorage.removeItem(BRANDING_LS_KEY); } catch {} }

/**
 * Load branding from localStorage cache — used for instant render on boot
 * before the API call completes. Critical after Android recreate() where
 * JS memory is wiped but localStorage persists.
 */
export function getCachedBranding() {
  if (cachedBranding) return cachedBranding;
  try {
    const raw = localStorage.getItem(BRANDING_LS_KEY);
    if (raw) {
      cachedBranding = JSON.parse(raw);
      return cachedBranding;
    }
  } catch {}
  return null;
}

/**
 * Fetch company branding from the API.
 * Returns { ...branding, _fallback: true } when the API call fails or no
 * company is found, so the caller can use the fallback as a signal to
 * trigger a forced data reload.
 */
export async function getCompanyBranding(companyId) {
  if (!companyId) return { ...DEFAULT_BRANDING, _fallback: true };
  if (cachedBranding) return cachedBranding;

  // If we already tried and failed (same page load), don't retry — return fallback.
  // This prevents repeated API calls on every re-render or retry path.
  if (_fallbackAttempted) return { ...DEFAULT_BRANDING, _fallback: true };

  try {
    // Try filter by id first
    let company = await base44.entities.Company.filter({ id: companyId });

    // If filter returned nothing, try listing all companies and finding by id.
    // Some Base44 SDK versions don't support filtering by the system `id` field.
    if (!company || company.length === 0) {
      console.warn('[Branding] Company.filter({id}) returned empty \u2014 trying Company.list() fallback');
      const allCompanies = await base44.entities.Company.list();
      company = allCompanies?.filter(c => c.id === companyId) || [];
    }

    if (company && company.length > 0) {
      cachedBranding = {
        name: company[0].name || DEFAULT_BRANDING.name,
        logo_url: company[0].logo_url || DEFAULT_BRANDING.logo_url,
        favicon_url: company[0].favicon_url || DEFAULT_BRANDING.favicon_url,
        primary_color: company[0].primary_color || DEFAULT_BRANDING.primary_color,
        secondary_color: company[0].secondary_color || DEFAULT_BRANDING.secondary_color,
        accent_color: company[0].accent_color || DEFAULT_BRANDING.accent_color
      };
      try { localStorage.setItem(BRANDING_LS_KEY, JSON.stringify(cachedBranding)); } catch {}
      return cachedBranding;
    }
  } catch (error) {
    console.warn('⚠️ [Branding] Failed to fetch company branding:', error?.message);
  }

  // Fallback — mark as attempted so we don't retry on the same page load
  _fallbackAttempted = true;
  return { ...DEFAULT_BRANDING, _fallback: true };
}

export function applyBrandingStyles(branding) {
  const root = document.documentElement;
  root.style.setProperty('--primary-color', branding.primary_color);
  root.style.setProperty('--secondary-color', branding.secondary_color);
  root.style.setProperty('--accent-color', branding.accent_color);

  if (branding.favicon_url) {
    let favicon = document.querySelector("link[rel='icon']");
    if (!favicon) {
      favicon = document.createElement('link');
      favicon.rel = 'icon';
      document.head.appendChild(favicon);
    }
    favicon.href = branding.favicon_url;
  }
}
