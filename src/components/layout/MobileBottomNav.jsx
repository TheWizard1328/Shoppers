import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { userHasRole } from '@/components/utils/userRoles';
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

const PAGE_SCROLL_POSITIONS = {};

export default function MobileBottomNav({ currentUser, currentPageName, onSidebarToggle }) {
  const scrollRef = React.useRef(null);

  if (!currentUser) return null;

  const isDriver = userHasRole(currentUser, 'driver');
  const isDispatcher = userHasRole(currentUser, 'dispatcher');
  const isAdmin = userHasRole(currentUser, 'admin');

  let navItems = [];

  if (isDriver && !isAdmin) {
    navItems = [
      { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard },
      { name: 'Routes', page: 'Deliveries', icon: Package },
      { name: 'Messages', action: 'messaging', icon: MessageCircle },
      { name: 'Square COD', page: 'SquareManagement', icon: CreditCard },
      { name: 'Payroll', page: 'DriverPayroll', icon: DollarSign },
      { name: 'Settings', page: 'DeviceSettings', icon: Settings },
    ];
  } else if (isDispatcher && !isAdmin) {
    navItems = [
      { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard },
      { name: 'Patients', page: 'Patients', icon: Users },
      { name: 'Routes', page: 'Deliveries', icon: Package },
      { name: 'Messages', action: 'messaging', icon: MessageCircle },
      { name: 'Settings', page: 'DeviceSettings', icon: Settings },
    ];
  } else if (isAdmin) {
    navItems = [
      { name: 'Dashboard', page: 'Dashboard', icon: LayoutDashboard },
      { name: 'Patients', page: 'Patients', icon: Users },
      { name: 'Routes', page: 'Deliveries', icon: Package },
      { name: 'Messages', action: 'messaging', icon: MessageCircle },
      { name: 'Square COD', page: 'SquareManagement', icon: CreditCard },
      { name: 'Payroll', page: 'DriverPayroll', icon: DollarSign },
      { name: 'Settings', page: 'DeviceSettings', icon: Settings },
    ];
  }

  React.useEffect(() => {
    return () => {
      const mainContent = document.querySelector('main') || document.querySelector('[data-page-content]');
      if (mainContent && currentPageName) {
        PAGE_SCROLL_POSITIONS[currentPageName] = mainContent.scrollTop;
      }
    };
  }, [currentPageName]);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      const mainContent = document.querySelector('main') || document.querySelector('[data-page-content]');
      if (mainContent && PAGE_SCROLL_POSITIONS[currentPageName]) {
        mainContent.scrollTop = PAGE_SCROLL_POSITIONS[currentPageName];
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [currentPageName]);



  return (
    <nav
      data-mobile-bottom-nav
      className="fixed bottom-0 left-0 right-0 z-[150] border-t"
      style={{
        background: 'var(--bg-white)',
        borderColor: 'var(--border-slate-200)',
        boxShadow: '0 -2px 10px var(--shadow-color)',
        paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))',
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

        <div
          ref={scrollRef}
          className="flex-1 flex overflow-x-auto custom-scrollbar"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {navItems.map((item) => {
            const isMessagingItem = item.action === 'messaging';
            const isActive = !isMessagingItem && currentPageName === item.page;
            const Icon = item.icon;
            const visibleTabs = Math.min(navItems.length, 4);
            const sharedProps = {
              className: 'flex flex-col items-center justify-center py-2 px-2 flex-shrink-0 transition-colors',
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
                  <span
                    className="text-xs font-medium truncate"
                    style={{ color: 'var(--text-slate-500)', maxWidth: '80px' }}
                  >
                    {item.name}
                  </span>
                </button>
              );
            }

            return (
              <Link
                key={item.name}
                to={createPageUrl(item.page)}
                {...sharedProps}
                onClick={() => {
                  const mainContent = document.querySelector('main') || document.querySelector('[data-page-content]');
                  if (mainContent && currentPageName) {
                    PAGE_SCROLL_POSITIONS[currentPageName] = mainContent.scrollTop;
                  }
                }}
              >
                <Icon
                  className="w-5 h-5 mb-0.5"
                  style={{ color: isActive ? '#10b981' : 'var(--text-slate-500)' }}
                />
                <span
                  className="text-xs font-medium truncate"
                  style={{ color: isActive ? '#10b981' : 'var(--text-slate-500)', maxWidth: '80px' }}
                >
                  {item.name}
                </span>
                {isActive && <div className="w-1 h-1 rounded-full bg-emerald-500 mt-0.5" />}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}