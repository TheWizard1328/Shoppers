import { base44 } from '@/api/base44Client';

const DEFAULT_BRANDING = {
  logo_url: '',
  favicon_url: '',
  primary_color: '#000000',
  secondary_color: '#FFFFFF',
  accent_color: '#0066CC'
};

export async function getCompanyBranding(companyId) {
  if (!companyId) return DEFAULT_BRANDING;

  const company = await base44.entities.Company.filter(
    { id: companyId },
    '-updated_date',
    1
  );

  if (company && company.length > 0) {
    return {
      logo_url: company[0].logo_url || DEFAULT_BRANDING.logo_url,
      favicon_url: company[0].favicon_url || DEFAULT_BRANDING.favicon_url,
      primary_color: company[0].primary_color || DEFAULT_BRANDING.primary_color,
      secondary_color: company[0].secondary_color || DEFAULT_BRANDING.secondary_color,
      accent_color: company[0].accent_color || DEFAULT_BRANDING.accent_color
    };
  }

  return DEFAULT_BRANDING;
}

export function applyBrandingStyles(branding) {
  const root = document.documentElement;
  root.style.setProperty('--primary-color', branding.primary_color);
  root.style.setProperty('--secondary-color', branding.secondary_color);
  root.style.setProperty('--accent-color', branding.accent_color);

  // Update favicon if provided
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

export function getBrandingColor(colorType, branding) {
  const colorMap = {
    'primary': branding.primary_color,
    'secondary': branding.secondary_color,
    'accent': branding.accent_color
  };
  return colorMap[colorType] || DEFAULT_BRANDING[`${colorType}_color`];
}