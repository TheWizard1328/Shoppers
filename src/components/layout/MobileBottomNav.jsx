import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { LayoutDashboard, Users, Package, Settings } from 'lucide-react';

export default function MobileBottomNav({ currentPageName }) {
  const navItems = [
    {
      name: 'Dashboard',
      icon: LayoutDashboard,
      url: createPageUrl('Dashboard'),
      pageName: 'Dashboard'
    },
    {
      name: 'Patients',
      icon: Users,
      url: createPageUrl('Patients'),
      pageName: 'Patients'
    },
    {
      name: 'Routes',
      icon: Package,
      url: createPageUrl('Deliveries'),
      pageName: 'Deliveries'
    },
    {
      name: 'Settings',
      icon: Settings,
      url: createPageUrl('DeviceSettings'),
      pageName: 'DeviceSettings'
    }
  ];

  return (
    <div 
      className="fixed bottom-0 left-0 right-0 z-[1000] border-t safe-bottom"
      style={{ 
        background: 'var(--bg-white)', 
        borderColor: 'var(--border-slate-200)',
        paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))'
      }}
    >
      <nav className="flex items-center justify-around px-2 py-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentPageName === item.pageName;
          
          return (
            <Link
              key={item.name}
              to={item.url}
              className={`flex flex-col items-center justify-center gap-1 px-3 py-1.5 rounded-lg transition-colors select-none ${
                isActive 
                  ? 'text-emerald-600' 
                  : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'fill-emerald-100' : ''}`} />
              <span className="text-[10px] font-medium">{item.name}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}