import React, { useState, useEffect } from 'react';
import { createPageUrl } from '@/utils';
import { userHasRole } from '@/components/utils/userRoles';
import { useMobileNavigation } from '@/components/navigation/MobileNavigationProvider';
import { getUserAgentInfo } from '@/components/utils/deviceUtils';
import {
  LayoutDashboard,
  Users,
  Package,
  MessageCircle,
  CreditCard,
  DollarSign,
  Settings,
  Menu,
} from 'lucide-react';

export default function MobileBottomNav({ currentUser, currentPageName, onSidebarToggle }) {
  const { activeTab, navigateToTab } = useMobileNavigation();
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const { os, deviceType } = getUserAgentInfo();
    setIsIOS(os === 'iOS' && deviceType === 'Mobile');
  }, []);

  if (!currentUser) return null;

  const isDriver = userHasRole(currentUser, 'driver');
  const isDispatcher = userHasRole(currentUser, 'dispatcher');
  const isAdmin = userHasRole(currentUser, 'admin');

  let navItems = [];

  if (isDriver && !isAdmin) {
    navItems = [
      { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard, tabKey: 'dashboard' },
      { name: 'Routes', page: 'Deliveries', icon: Package, tabKey: 'routes' },
      { name: 'Messages', action: 'messaging', icon: MessageCircle },
      { name: 'Square COD', page: 'SquareManagement', icon: CreditCard, tabKey: 'square' },
      { name: 'Payroll', page: 'DriverPayroll', icon: DollarSign, tabKey: 'payroll' },
      { name: 'Settings', page: 'Settings', icon: Settings, tabKey: 'settings' },
    ];
  } else if (isDispatcher && !isAdmin) {
    navItems = [
      { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard, tabKey: 'dashboard' },
      { name: 'Patients', page: 'Patients', icon: Users, tabKey: 'patients' },
      { name: 'Routes', page: 'Deliveries', icon: Package, tabKey: 'routes' },
      { name: 'Messages', action: 'messaging', icon: MessageCircle },
      { name: 'Settings', page: 'Settings', icon: Settings, tabKey: 'settings' },
    ];
  } else if (isAdmin) {
    navItems = [
      { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard, tabKey: 'dashboard' },
      { name: 'Patients', page: 'Patients', icon: Users, tabKey: 'patients' },
      { name: 'Routes', page: 'Deliveries', icon: Package, tabKey: 'routes' },
      { name: 'Messages', action: 'messaging', icon: MessageCircle },
      { name: 'Square COD', page: 'SquareManagement', icon: CreditCard, tabKey: 'square' },
      { name: 'Payroll', page: 'DriverPayroll', icon: DollarSign, tabKey: 'payroll' },
      { name: 'Settings', page: 'Settings', icon: Settings, tabKey: 'settings' },
    ];
  }

  return (
    <nav
      data-mobile-bottom-nav
      className={`relative z-[150] shrink-0 border-t${isIOS ? ' ios-safe-area-bottom' : ''}`}
      style={{
        background: 'var(--bg-white)',
        borderColor: 'var(--border-slate-200)',
        boxShadow: '0 -2px 10px var(--shadow-color)',
      }}
    >
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={onSidebarToggle}
          className="flex h-11 w-11 items-center justify-center rounded-lg transition-colors shrink-0"
          style={{ color: 'var(--text-slate-500)' }}
          aria-label="Open side panel"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex-1 flex overflow-x-auto custom-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {navItems.map((item) => {
            const isMessagingItem = item.action === 'messaging';
            const isActive = !isMessagingItem && activeTab === item.tabKey;
            const Icon = item.icon;
            const visibleTabs = Math.min(navItems.length, 4);
            const sharedProps = {
              className: 'flex min-h-14 flex-col items-center justify-center px-2 py-2 flex-shrink-0 transition-colors',
              style: {
                minWidth: `calc((100vw - 56px) / ${visibleTabs})`,
                color: isActive ? '#10b981' : 'var(--text-slate-500)',
              },
            };

            if (isMessagingItem) {
              return (
                <button
                  key={item.name}
                  type="button"
                  {...sharedProps}
                  onClick={() => window.dispatchEvent(new CustomEvent('openMessagingPanel'))}
                >
                  <Icon className="w-5 h-5 mb-0.5" style={{ color: 'var(--text-slate-500)' }} />
                  <span className="text-sm font-medium truncate" style={{ color: 'var(--text-slate-500)', maxWidth: '80px' }}>
                    {item.name}
                  </span>
                </button>
              );
            }

            return (
              <button
                key={item.name}
                type="button"
                {...sharedProps}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => navigateToTab(item.tabKey, createPageUrl(item.page))}
              >
                <Icon className="w-5 h-5 mb-0.5" style={{ color: isActive ? '#10b981' : 'var(--text-slate-500)' }} />
                <span className="text-sm font-medium truncate" style={{ color: isActive ? '#10b981' : 'var(--text-slate-500)', maxWidth: '80px' }}>
                  {item.name}
                </span>
                {isActive && <div className="w-1 h-1 rounded-full bg-emerald-500 mt-0.5" />}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}