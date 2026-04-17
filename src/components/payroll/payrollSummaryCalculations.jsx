export const roundCurrency = (value = 0) => Math.round((Number(value) || 0) * 100) / 100;

export const sumDeductionAmounts = (deductions = []) =>
  (deductions || []).reduce((sum, item) => sum + (item?.amount || 0), 0);

export const getPeriodNetAmount = ({ grandTotal = 0, taxAmount = 0, bonusPay = 0, deductions = [], appFeeAmount = 0 }) =>
  roundCurrency(
    roundCurrency(grandTotal) +
    roundCurrency(taxAmount) -
    roundCurrency(sumDeductionAmounts(deductions)) +
    roundCurrency(bonusPay) +
    roundCurrency(appFeeAmount)
  );

export const getDefaultPaidAmount = ({ grandTotal = 0, taxAmount = 0, bonusPay = 0, deductions = [] }) =>
  roundCurrency(
    roundCurrency(grandTotal) +
    roundCurrency(taxAmount) +
    (bonusPay || 0) -
    sumDeductionAmounts(deductions)
  );