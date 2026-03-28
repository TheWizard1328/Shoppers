import { useEffect, useState } from 'react';
import { getData } from '@/components/utils/dataManager';

export default function useAdminEntityCounts() {
  const [companyCount, setCompanyCount] = useState(0);

  useEffect(() => {
    let active = true;

    const loadCompanies = async () => {
      try {
        const companies = await getData('Company');
        if (active) {
          setCompanyCount(Array.isArray(companies) ? companies.length : 0);
        }
      } catch {
        if (active) {
          setCompanyCount(0);
        }
      }
    };

    loadCompanies();
    const interval = setInterval(loadCompanies, 30000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return { companyCount };
}