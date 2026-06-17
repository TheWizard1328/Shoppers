export function matchesDeliveryCodFilter(delivery, selectedCodFilter) {
  if (selectedCodFilter === 'all_deliveries') return true;

  const codAmount = Number(delivery?.cod_total_amount_required || 0);
  const legacyAmount = Number(delivery?.cod_amount || 0);
  const codPayments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
  const paymentTypes = codPayments.map((payment) => String(payment?.type || '').toLowerCase());
  const legacyType = String(delivery?.cod_payment_type || '').toLowerCase();

  if (selectedCodFilter === 'all') {
    const hasPaymentType = paymentTypes.some((type) => ['cash', 'debit', 'credit', 'check'].includes(type));
    const hasLegacyType = ['cash', 'debit', 'credit', 'check'].includes(legacyType);
    return codAmount > 0 || legacyAmount > 0 || hasPaymentType || hasLegacyType;
  }

  return paymentTypes.includes(selectedCodFilter) || legacyType === selectedCodFilter;
}