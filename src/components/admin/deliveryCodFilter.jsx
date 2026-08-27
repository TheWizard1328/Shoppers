export function matchesDeliveryCodFilter(delivery, selectedCodFilter) {
  if (selectedCodFilter === 'all_deliveries') return true;

  const codAmount = Number(delivery?.cod_total_amount_required || 0);
  const legacyAmount = Number(delivery?.cod_amount || 0);
  const codPayments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
  // Normalize the money-type value to "cheque". The COD type was renamed from
  // "Check" to "Cheque"; legacy records may still carry "Check" in cod_payments
  // or the deprecated cod_payment_type field, so map the old spelling on read.
  const normalizeType = (value) => {
    const lower = String(value || '').toLowerCase();
    return lower === 'check' ? 'cheque' : lower;
  };
  const paymentTypes = codPayments.map((payment) => normalizeType(payment?.type));
  const legacyType = normalizeType(delivery?.cod_payment_type);

  if (selectedCodFilter === 'all') {
    const hasPaymentType = paymentTypes.some((type) => ['cash', 'debit', 'credit', 'cheque'].includes(type));
    const hasLegacyType = ['cash', 'debit', 'credit', 'cheque'].includes(legacyType);
    return codAmount > 0 || legacyAmount > 0 || hasPaymentType || hasLegacyType;
  }

  return paymentTypes.includes(selectedCodFilter) || legacyType === selectedCodFilter;
}