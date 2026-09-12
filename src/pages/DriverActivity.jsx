import React, { useState, useEffect } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { getEffectiveUser } from '@/components/utils/auth';
import { userHasRole } from '@/components/utils/userRoles';
import { useAppData } from '@/components/utils/AppDataContext';
import DriverActivityTab from '@/components/admin/DriverActivityTab';

export default function DriverActivity() {
  const { appUsers = [], cities = [], stores = [] } = useAppData();
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const check = async () => {
      try {
        const user = await getEffectiveUser();
        setCurrentUser(user);
      } catch (_) {}
      finally { setLoading(false); }
    };
    check();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        <span className="ml-3 text-lg text-label">Loading...</span>
      </div>
    );
  }

  if (!currentUser || !userHasRole(currentUser, 'admin')) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Card className="p-8 text-center bg-surface border-surface">
          <AlertCircle className="w-12 h-12 mx-auto mb-4 text-red-500" />
          <h2 className="text-xl font-bold mb-2 text-body">Access Denied</h2>
          <p className="text-label">Only admins can access this page.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col" style={{ background: 'var(--bg-slate-50)', height: '100%', overflow: 'hidden' }}>
      <div className="flex-shrink-0 px-2 md:px-3 pt-2 md:pt-3 pb-2" style={{ background: 'var(--bg-slate-50)' }}>
        <h1 className="text-xl md:text-3xl font-bold text-body">Driver Activity</h1>
      </div>
      <div className="flex-1 overflow-y-auto px-2 md:px-3 pb-4">
        <DriverActivityTab appUsers={appUsers} cities={cities} stores={stores} />
      </div>
    </div>
  );
}