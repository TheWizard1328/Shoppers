import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

    // Filter to only completed deliveries (billable)
    const billableDeliveries = allDeliveries.filter(d => 
      d && d.status === 'completed' && !d.no_charge
    );

    const totalBillableDeliveries = billableDeliveries.length;

    // 2. Get app fees per delivery from AppSettings
    const settings = await base44.entities.AppSettings.filter({ 
      setting_key: 'refresh_intervals' 
    });
    
    const appFeesPerDelivery = settings?.[0]?.setting_value?.app_fees_per_delivery || 0;

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