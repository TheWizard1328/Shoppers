import { useEffect } from 'react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { toast } from 'sonner';

/**
 * React to a manual online/offline data-source toggle (Layout's
 * dataSourceChanged event): reload the selected date's deliveries from the
 * chosen source, write them back to offline DB (when online), and refresh
 * stats + notify the user. Extracted from Dashboard.jsx.
 */
export function useDataSourceChangedEffect({ selectedDate, deliveries, updateDeliveriesLocally, setIsEntityUpdating }) {
  useEffect(() => {
    const handleDataSourceChange = async (event) => {
      const { source } = event.detail || {};
      setIsEntityUpdating(true);
      try {
        const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
        let freshDeliveries = [];
        if (source === 'online') {
          freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
          offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(() => {});
        } else {
          freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
          if (!freshDeliveries || freshDeliveries.length === 0) {
            freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
          }
        }
        const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
        const allDeliveries = [...otherDateDeliveries, ...freshDeliveries];
        updateDeliveriesLocally(allDeliveries, true);
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryDate: selectedDateStr, triggeredBy: 'dataSourceChange', deliveryCount: freshDeliveries.length } }));
        toast.success(`Loaded from ${source === 'online' ? 'Online' : 'Offline'} source`, { description: `${freshDeliveries.length} deliveries for ${format(selectedDate, 'MMM dd')}` });
      } catch (error) {
        console.error('❌ [Data Source Change] Failed:', error);
        toast.error('Failed to reload data', { description: error.message });
      } finally {
        setIsEntityUpdating(false);
      }
    };
    window.addEventListener('dataSourceChanged', handleDataSourceChange);
    return () => window.removeEventListener('dataSourceChanged', handleDataSourceChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, updateDeliveriesLocally, deliveries]);
}