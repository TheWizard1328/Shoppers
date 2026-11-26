import { createPageUrl } from '@/utils';
import { Building, Building2, BarChart3, Truck, Users2, FileText, CreditCard, MapPinned, ReceiptText, CalendarDays, ShieldAlert } from 'lucide-react';
import { isAppOwner } from '@/components/utils/userRoles';

export default function getAdminNavigationItems({
  currentUser,
  entityCounts,
  onlineCounts,
  stores,
  drivers,
  users,
  adminImportEnabled
}) {
  const isAdmin = !!currentUser?.app_roles?.includes('admin');

  const items = [
    {
      title: 'Companies',
      pageName: 'Companies',
      url: createPageUrl('Companies'),
      icon: Building2
    },
    {
      title: 'Cities',
      pageName: 'Cities',
      count: entityCounts.cities,
      url: createPageUrl('Cities'),
      icon: MapPinned
    },
    {
      title: 'Users',
      pageName: 'AppUsers',
      count: isAdmin ? `${onlineCounts.totalActiveUsersCount}/${users.length}` : entityCounts.users,
      url: createPageUrl('AppUsers'),
      icon: Users2
    }
  ];

  if (currentUser && (isAppOwner(currentUser) || isAdmin)) {
    items.push(
      {
        // OWNER REQUEST (Nov 26 2026): crash detection settings moved out of
        // Admin Utilities > Alerts into their own link, just above Stat Holidays.
        title: 'Crash Detection',
        pageName: 'CrashDetectionSettings',
        url: createPageUrl('CrashDetectionSettings'),
        icon: ShieldAlert
      },
      {
        title: 'Stat Holidays',
        pageName: 'StatHolidays',
        url: createPageUrl('StatHolidays'),
        icon: CalendarDays
      },
      {
        title: 'Admin Metrics',
        pageName: 'AdminMetrics',
        url: createPageUrl('AdminMetrics'),
        icon: BarChart3
      },
      {
        title: 'Store Invoices',
        pageName: 'StoreInvoices',
        url: createPageUrl('StoreInvoices'),
        icon: ReceiptText
      }
    );
  }

  if (currentUser && isAppOwner(currentUser) && adminImportEnabled) {
    items.push({
      title: 'Admin Utilities',
      pageName: 'AdminUtilities',
      url: createPageUrl('AdminUtilities'),
      icon: BarChart3
    });
  }


  return items;
}