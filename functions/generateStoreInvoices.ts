import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // Admin only
    if (!user || user.role !== 'App Owner') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const { year, month } = await req.json();

    if (!year || !month || month < 1 || month > 12) {
      return Response.json({ error: 'Invalid year or month' }, { status: 400 });
    }

    // Get admin metrics for the period
    const metricsResponse = await base44.asServiceRole.functions.invoke('getAdminMetricsAndPayrollData', {
      adminMetricsYear: year,
      adminMetricsCityId: 'all'
    });

    const metricsData = metricsResponse?.data || metricsResponse;
    if (!metricsData?.adminMetrics) {
      return Response.json({ error: 'Unable to load metrics data' }, { status: 500 });
    }

    const metrics = metricsData.adminMetrics;
    const monthlyStoreData = metrics.storeDataByMonth?.[month] || [];

    // Check for existing invoices for this period
    const existingInvoices = await base44.asServiceRole.entities.Invoice.filter({
      billing_year: year,
      billing_month: month
    });

    if (existingInvoices && existingInvoices.length > 0) {
      return Response.json({
        error: 'Invoices already exist for this period',
        existingCount: existingInvoices.length,
        existingInvoices: existingInvoices.map(inv => ({
          id: inv.id,
          store_name: inv.store_name,
          status: inv.status
        }))
      }, { status: 409 });
    }

    // Get all stores with fee payment status
    const stores = await base44.asServiceRole.entities.Store.list();
    const applicableStores = stores.filter(s => s && s.pays_app_fees);

    if (!applicableStores || applicableStores.length === 0) {
      return Response.json({ error: 'No stores with fee payments enabled' }, { status: 400 });
    }

    // Generate invoices
    const newInvoices = [];
    const today = new Date();
    const firstDayOfMonth = new Date(year, month - 1, 1);
    const lastDayOfMonth = new Date(year, month, 0);

    // Get max invoice number for this year
    const allInvoices = await base44.asServiceRole.entities.Invoice.filter({
      billing_year: year
    });
    const maxInvoiceNum = allInvoices
      .map(inv => {
        const match = inv.invoice_number?.match(/-(\d+)$/);
        return match ? parseInt(match[1]) : 0;
      })
      .reduce((max, num) => Math.max(max, num), 0);

    let invoiceCounter = maxInvoiceNum + 1;

    for (const store of applicableStores) {
      // Find store metrics for this month
      const storeMetrics = monthlyStoreData.find(s => s.storeId === store.id);
      const totalBillable = storeMetrics ? (storeMetrics.completed + storeMetrics.failed) : 0;

      // Calculate fees
      const appFeeRate = metrics.appFeePerDelivery || 0;
      const subtotal = totalBillable * appFeeRate;
      const taxes = 0; // Can be extended for tax calculation
      const totalDue = subtotal + taxes;

      const invoiceNumber = `INV-${year}-${String(month).padStart(2, '0')}-${String(invoiceCounter).padStart(3, '0')}`;
      invoiceCounter++;

      newInvoices.push({
        invoice_number: invoiceNumber,
        store_id: store.id,
        store_name: store.name,
        store_abbreviation: store.abbreviation,
        billing_year: year,
        billing_month: month,
        billing_start_date: firstDayOfMonth.toISOString().split('T')[0],
        billing_end_date: lastDayOfMonth.toISOString().split('T')[0],
        total_billable_deliveries: totalBillable,
        app_fee_per_delivery: appFeeRate,
        subtotal: subtotal,
        taxes: taxes,
        total_amount_due: totalDue,
        status: 'draft',
        created_at: today.toISOString(),
        notes: ''
      });
    }

    // Bulk create invoices
    const createdInvoices = await base44.asServiceRole.entities.Invoice.bulkCreate(newInvoices);

    return Response.json({
      success: true,
      message: `Generated ${createdInvoices.length} invoices for ${year}-${String(month).padStart(2, '0')}`,
      invoices: createdInvoices.map(inv => ({
        id: inv.id,
        invoice_number: inv.invoice_number,
        store_name: inv.store_name,
        total_amount_due: inv.total_amount_due,
        status: inv.status
      }))
    });
  } catch (error) {
    console.error('Error generating invoices:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});