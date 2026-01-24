import React, { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { getStatusBadge, getPaymentMethodBadge } from './badgeHelpers';

export default function CODItemDetailModal({ item, locationConfigs, stores, transactions = [], drivers = [], deliveries = [], onClose }) {
  // Parse Square item name to extract delivery date
  const parseSquareItemName = (itemName) => {
    if (!itemName) return null;
    try {
      const dateMatch = itemName.match(/^(\d{2})\/(\d{2})/);
      if (!dateMatch) return null;
      
      const month = dateMatch[1];
      const day = dateMatch[2];
      const currentYear = new Date().getFullYear();
      return `${currentYear}-${month}-${day}`;
    } catch (error) {
      return null;
    }
  };

  // Extract store abbreviation from Square item name (e.g., "(BD)" for Bonnie Doon)
  const getStoreAbbreviation = (itemName) => {
    if (!itemName) return null;
    const match = itemName.match(/\(([A-Z]{2})\)/);
    return match ? match[1] : null;
  };

  const storeAbbrev = getStoreAbbreviation(item.name);
  const storeByAbbreviation = useMemo(() => {
    if (!storeAbbrev || !stores.length) return null;
    return stores.find(s => s.abbreviation === storeAbbrev);
  }, [storeAbbrev, stores]);

  const itemTransactions = useMemo(() => {
    return transactions.filter(t => 
      t.square_catalog_object_id === item.id || t.item_name === item.name
    ).sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
  }, [transactions, item.id, item.name]);

  const locationConfig = locationConfigs.find(c => c.square_location_id === item.location_id);
  const store = stores.find(s => s.square_location_config_id === locationConfig?.id);

  // Get matching delivery for this Square item to extract driver and date
  const matchingDelivery = useMemo(() => {
    const deliveryDate = parseSquareItemName(item.name);
    if (!deliveryDate || !deliveries.length) return null;
    
    // Find any delivery matching the date and store
    return deliveries.find(d => d.delivery_date === deliveryDate && d.store_id === store?.id);
  }, [item.name, store?.id, deliveries]);

  const totalCollected = useMemo(() => {
    return itemTransactions
      .filter(t => t.type === 'collection' && t.status === 'completed')
      .reduce((sum, t) => sum + (t.amount || 0), 0);
  }, [itemTransactions]);

  const remainingAmount = (item.price_dollars || 0) - totalCollected;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-[9999] flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b p-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold text-slate-900">COD Item Details</h2>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <CardContent className="p-6 space-y-6">
          {/* Item Info */}
          <div className="bg-slate-50 rounded-lg p-4">
            <h3 className="font-semibold text-slate-900 mb-3">{item.name}</h3>
            {item.description && (
              <p className="text-sm text-slate-600 mb-3">{item.description}</p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-slate-500 font-medium">Amount Due</p>
                <p className="text-2xl font-bold text-emerald-600">${(item.price_dollars || 0).toFixed(2)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 font-medium">Catalog ID</p>
                <p className="text-sm font-mono text-slate-700 truncate">{item.id}</p>
              </div>
            </div>
          </div>

          {/* Transaction History */}
          <div>
              <h3 className="font-semibold text-slate-900 mb-3">
                Transaction History ({itemTransactions.length})
              </h3>
            {itemTransactions.length === 0 ? (
              <p className="text-center text-slate-500 py-6">No transactions yet</p>
              ) : (
                <div className="space-y-3">
                  {itemTransactions.map(t => (
                    <Card key={t.id} className="bg-slate-50 border-0">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">${(t.amount || 0).toFixed(2)}</p>
                            <p className="text-xs text-slate-500">
                              {new Date(t.created_date).toLocaleString()}
                            </p>
                          </div>
                          <div className="flex gap-2 items-center">
                            {getStatusBadge(t.status)}
                            {t.payment_method && getPaymentMethodBadge(t.payment_method)}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-xs mt-3">
                          <div>
                            <p className="text-slate-500">Driver</p>
                            <p className="font-medium text-slate-700">
                              {matchingDelivery?.driver_name || 'N/A'}
                            </p>
                          </div>
                          <div>
                            <p className="text-slate-500">Date</p>
                            <p className="font-medium text-slate-700">
                              {matchingDelivery?.delivery_date ? new Date(matchingDelivery.delivery_date).toLocaleDateString() : ''}
                            </p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Item Metadata */}
          <div className="bg-slate-50 rounded-lg p-4">
            <p className="text-xs text-slate-500 font-medium mb-3">Additional Info</p>
            <div className="space-y-2 text-xs text-slate-600">
              <div className="flex justify-between">
                <span>Created</span>
                <span>{item.created_date ? new Date(item.created_date).toLocaleString() : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span>Updated</span>
                <span>{item.updated_at ? new Date(item.updated_at).toLocaleString() : 'N/A'}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}