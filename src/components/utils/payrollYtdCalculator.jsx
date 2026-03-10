/**
 * Calculate YTD (Year-to-Date) payroll values from Period 1 to selected period
 * 
 * YTD Gross Formula: YTD Net + YTD Tax - YTD Deductions + YTD Bonus + YTD App Fees
 * YTD Tax: Based on YTD Net with the current period's tax rate
 */

export const PROVINCE_TAX_RATES = {
  'AB': 0.05, 'BC': 0.05, 'SK': 0.05, 'MB': 0.05, 'ON': 0.13,
  'QC': 0.05, 'NB': 0.15, 'NS': 0.15, 'PE': 0.15, 'NL': 0.15,
  'YT': 0.05, 'NT': 0.05, 'NU': 0.05
};

/**
 * Get tax rate for a driver based on their city
 */
const getTaxRateForDriver = (driverCity) => {
  if (!driverCity?.province_state) return 0;
  
  const province = driverCity.province_state.toUpperCase();
  let provinceCode = null;

  if (province.length === 2 && PROVINCE_TAX_RATES[province]) {
    provinceCode = province;
  } else {
    const provinceMap = {
      'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'SASKATCHEWAN': 'SK',
      'MANITOBA': 'MB', 'ONTARIO': 'ON', 'QUEBEC': 'QC',
      'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS', 'PRINCE EDWARD ISLAND': 'PE',
      'NEWFOUNDLAND': 'NL', 'NEWFOUNDLAND AND LABRADOR': 'NL',
      'YUKON': 'YT', 'NORTHWEST TERRITORIES': 'NT', 'NUNAVUT': 'NU'
    };
    provinceCode = provinceMap[province] || null;
  }

  return (provinceCode && PROVINCE_TAX_RATES[provinceCode]) || 0;
};

/**
 * Calculate YTD payroll totals from payroll records
 * 
 * @param {Array} ytdRecords - All payroll records from Jan 1 to current period end
 * @param {Object} driverData - Current period driver payroll data (for tax info)
 * @param {Array} cities - List of cities to determine tax rate
 * @param {Object} appUser - Driver's AppUser data to get city
 * @returns {Object} YTD totals
 */
export const calculateYtdPayroll = (ytdRecords, driverData, cities = [], appUser = null) => {
  // Sum all net pay from payroll records, rounding to 2 decimals
  const ytdNetPay = Math.round(ytdRecords.reduce((sum, r) => sum + (r.net_pay || 0), 0) * 100) / 100;
  
  // Sum all deductions from payroll records, rounding to 2 decimals
  const ytdDeductionsAmount = Math.round(ytdRecords.reduce((sum, r) => sum + (r.total_deductions || 0), 0) * 100) / 100;
  
  // Sum all bonus pay from payroll records, rounding to 2 decimals
  const ytdBonusAmount = Math.round(ytdRecords.reduce((sum, r) => sum + (r.bonus_pay || 0), 0) * 100) / 100;
  
  // Sum all app fees from payroll records, rounding to 2 decimals
  const ytdAppFeeAmount = Math.round(ytdRecords.reduce((sum, r) => sum + (r.app_fee_amount || 0), 0) * 100) / 100;

  // Sum all tax amounts from payroll records (not calculated), rounding to 2 decimals
  const ytdTaxAmount = Math.round(ytdRecords.reduce((sum, r) => sum + (r.tax_amount || 0), 0) * 100) / 100;

  // Calculate YTD Gross = YTD Net + YTD Tax - YTD Deductions + YTD Bonus + YTD App Fees
  const ytdGrossPay = Math.round((ytdNetPay + ytdTaxAmount - ytdDeductionsAmount + ytdBonusAmount + ytdAppFeeAmount) * 100) / 100;

  return {
    ytdNetPay,
    ytdTaxAmount,
    ytdDeductionsAmount,
    ytdBonusAmount,
    ytdAppFeeAmount,
    ytdGrossPay,
  };
};