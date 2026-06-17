import { createPageUrl } from '@/utils';
import { Building, Building2, BarChart3, Truck, Users2, FileText, CreditCard, MapPinned, ReceiptText } from 'lucide-react';
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

  if (currentUser && (isAppOwner(currentUser) || isAdmin) && adminImportEnabled) {
    items.push({
      title: 'Admin Utilities',
      pageName: 'AdminUtilities',
      url: createPageUrl('AdminUtilities'),
      icon: BarChart3
    });
  }

  if (currentUser && isAppOwner(currentUser)) {
    items.push(
      {
        title: 'Square Locations',
        pageName: 'SquareLocationConfigs',
        url: createPageUrl('SquareLocationConfigs'),
        icon: CreditCard
      },
      {
        title: 'Square COD Audit',
        pageName: 'SquareSyncAudit',
        url: createPageUrl('SquareSyncAudit'),
        icon: FileText
      }
    );
  }

  return items;
}