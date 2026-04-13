// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const isCompletedStatus = (delivery) => delivery?.status === 'completed';
const isFailedStatus = (delivery) => delivery?.status === 'failed';
const isCancelledStatus = (delivery) => delivery?.status === 'cancelled';
const isAfterHoursPickupDelivery = (delivery) => delivery?.after_hours_pickup === true;
const isPatientOrTransferDelivery = (delivery) => !!delivery?.patient_id;
const isInterStoreDelivery = (delivery) => {
  const name = String(delivery?.patient_name || '').toUpperCase();
  return name.includes('INTERSTORE') || name.includes('(ISD)') || name.includes('(ISP)');
};
const isRegularPickupDelivery = (delivery) => !isAfterHoursPickupDelivery(delivery) && !isPatientOrTransferDelivery(delivery) && !isInterStoreDelivery(delivery);
const isDriverPayableDelivery = (delivery) => {
  if (!delivery || delivery.no_charge === true) return false;
  if (isAfterHoursPickupDelivery(delivery)) {
    return isCompletedStatus(delivery) || isCancelledStatus(delivery);
  }
  return isCompletedStatus(delivery) || isFailedStatus(delivery);
};
const isAppFeePayableDelivery = (delivery, storePaysFees) => {
  if (!delivery || !storePaysFees || delivery.no_charge === true) return false;
  if (isRegularPickupDelivery(delivery)) return false;
  return isDriverPayableDelivery(delivery);
};

/**
 * Calculate app fees for a driver's payroll based on:
 * 1. Total billable deliveries from ALL stores for the entire month
 * 2. Multiplied by the global "App Fees (Cost per Delivery)" setting
 * 3. Distributed among drivers based on their app_fee_percentage
 * 4. AppOwner gets 100% minus sum of other drivers' percentages
 */
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const { driverId, payPeriodStart, payPeriodEnd } = await req.json();

    if (!driverId || !payPeriodStart || !payPeriodEnd) {
      return new Response(JSON.stringify({ error: 'Missing required parameters' }), { status: 400 });
    }

    // 1. Get all deliveries for the entire period (across all stores)
    const [year, month] = payPeriodStart.split('-');
    const monthStr = `${year}-${month}`;

    const allDeliveries = await base44.entities.Delivery.filter({
      delivery_date: { $regex: `^${monthStr}` }
    });

    // 2. Get app fees per delivery from AppSettings
    const settings = await base44.entities.AppSettings.filter({ 
      setting_key: 'refresh_intervals' 
    });
    
    const appFeesPerDelivery = settings?.[0]?.setting_value?.app_fees_per_delivery || 0;

    const stores = await base44.entities.Store.list('', 5000);
    const sortedHistoryCache = new Map();
    const wasPayingFeesOnDate = (store, dateStr) => {
      if (!store) return false;
      if (!store.app_fee_history || store.app_fee_history.length === 0) {
        return store.pays_app_fees || false;
      }
      if (!sortedHistoryCache.has(store.id)) {
        sortedHistoryCache.set(store.id, [...store.app_fee_history].sort((a, b) => a.effective_date.localeCompare(b.effective_date)));
      }
      const sortedHistory = sortedHistoryCache.get(store.id);
      let payingFees = false;
      for (const entry of sortedHistory) {
        if (entry.effective_date <= dateStr) payingFees = entry.pays_app_fees;
        else break;
      }
      return payingFees;
    };

    const storeMap = new Map((stores || []).map((store) => [store.id, store]));
    const billableDeliveries = allDeliveries.filter((delivery) => {
      const store = delivery?.store_id ? storeMap.get(delivery.store_id) : null;
      const storePaysFees = store ? wasPayingFeesOnDate(store, delivery.delivery_date) : false;
      return isAppFeePayableDelivery(delivery, storePaysFees);
    });

    const totalBillableDeliveries = billableDeliveries.length;

    // 3. Calculate total payable app fees for the month
    const totalPayableAppFees = totalBillableDeliveries * appFeesPerDelivery;

    // 4. Get all payroll records for this month to determine app fee percentages
    const allPayrollForMonth = await base44.entities.Payroll.filter({
      pay_period_start: payPeriodStart,
      pay_period_end: payPeriodEnd
    });

    // Sum up all driver app fee percentages (except AppOwner)
    const appOwnerUser = await base44.auth.me();
    let otherDriversPercentageSum = 0;

    allPayrollForMonth.forEach(payroll => {
      if (payroll.driver_id !== appOwnerUser.id && payroll.app_fee_percentage) {
        otherDriversPercentageSum += payroll.app_fee_percentage;
      }
    });

    // 5. Calculate this driver's app fee amount
    let driverAppFeePercentage = 0;
    const driverPayroll = allPayrollForMonth.find(p => p.driver_id === driverId);

    if (driverPayroll) {
      if (driverId === appOwnerUser.id) {
        // AppOwner gets 100% minus sum of other drivers' percentages
        driverAppFeePercentage = 100 - otherDriversPercentageSum;
      } else {
        // Other drivers get their assigned percentage
        driverAppFeePercentage = driverPayroll.app_fee_percentage || 0;
      }
    } else if (driverId === appOwnerUser.id) {
      // If AppOwner has no payroll record yet, they get 100% minus others
      driverAppFeePercentage = 100 - otherDriversPercentageSum;
    }

    // Calculate the actual amount
    const driverAppFeeAmount = (totalPayableAppFees * driverAppFeePercentage) / 100;

    return new Response(JSON.stringify({
      success: true,
      calculation: {
        totalBillableDeliveries,
        appFeesPerDelivery,
        totalPayableAppFees,
        driverAppFeePercentage,
        driverAppFeeAmount: Math.round(driverAppFeeAmount * 100) / 100, // Round to 2 decimals
        monthKey: monthStr
      }
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error calculating app fees:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      success: false 
    }), { status: 500 });
  }
});