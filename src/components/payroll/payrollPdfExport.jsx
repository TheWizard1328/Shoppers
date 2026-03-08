import { jsPDF } from 'jspdf';
import { userHasRole, isAppOwner } from '../utils/userRoles';

/**
 * Export payroll data to PDF
 */
export function exportPayrollPdf({
  currentPeriod, selectedDriverId, selectedCityId, payPeriod, payrollData,
  deliveries, patients, stores, cities, currentUser,
  grandTotalAllDrivers, grandTotalTax, grandTotalDeductions, grandTotalGross,
  driverEdits, calculateAppFeeAmount, extraAppFeePercent, otherAppFeePercent, isPeriodEndOfMonth,
  driversWithDeliveries, appFeesPerDelivery
}) {
  if (!currentPeriod) return;

  const formatDate = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const formatFilenameDate = (date) => {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}_${day}`;
  };

  const dateFrom = formatFilenameDate(currentPeriod.start);
  const dateTo = formatFilenameDate(currentPeriod.end);
  const year = currentPeriod.end.getFullYear();

  let filenameContext = '';
  if (selectedDriverId && selectedDriverId !== 'all') {
    const driver = payrollData.find((d) => d.driver.id === selectedDriverId)?.driver;
    filenameContext = driver?.user_name || driver?.full_name || 'Driver';
  } else {
    const city = cities?.find((c) => c.id === selectedCityId);
    filenameContext = city?.name || 'All';
  }

  const filename = `${dateFrom}-${dateTo}_${year} - ${filenameContext}.pdf`;
  const isSingleDriver = selectedDriverId && selectedDriverId !== 'all';

  // Helper: build store data maps
  const buildStoreDataMaps = (storeList, dates, driverFilter) => {
    const storeDataMap = {};
    const oversizedMap = {};
    dates.forEach((date) => {
      const dateKey = date.toISOString().split('T')[0];
      storeDataMap[dateKey] = {};
      oversizedMap[dateKey] = {};
      storeList.forEach((store) => {
        storeDataMap[dateKey][store.id] = 0;
        oversizedMap[dateKey][store.id] = 0;
      });
    });

    deliveries.forEach((d) => {
      if (!d || !d.delivery_date || !d.store_id) return;
      if (driverFilter && d.driver_id !== driverFilter) return;
      const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
      if (!validStatus) return;
      if (!d.patient_id && !d.after_hours_pickup) return;
      const date = new Date(d.delivery_date + 'T00:00:00');
      if (date < currentPeriod.start || date > currentPeriod.end) return;

      if (storeDataMap[d.delivery_date]?.[d.store_id] !== undefined) {
        storeDataMap[d.delivery_date][d.store_id]++;
        if (d.oversized) oversizedMap[d.delivery_date][d.store_id]++;
      }
    });
    return { storeDataMap, oversizedMap };
  };

  // Helper: get period dates array
  const getDatesArray = () => {
    const dates = [];
    let currentDate = new Date(currentPeriod.start);
    while (currentDate <= currentPeriod.end) {
      dates.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    return dates;
  };

  // Helper: get active sorted stores
  const getActiveStores = (storesList) => {
    const sorted = [...storesList].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    return sorted.filter((s) => s.status !== 'inactive');
  };

  // Helper: filter to stores with data
  const filterStoresToData = (activeStores, dates, storeDataMap) => {
    const withData = activeStores.filter((store) =>
      dates.some((date) => storeDataMap[date.toISOString().split('T')[0]]?.[store.id] > 0)
    );
    return withData.length > 0 ? withData : activeStores;
  };

  // Helper: render grid on doc
  const renderGrid = (doc, displayStores, dates, storeDataMap, oversizedMap, startY, leftMargin, dayColWidth, storeColWidth, totalColWidth, rowHeight) => {
    const gridLineEnd = leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth;

    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.text('Day', leftMargin + dayColWidth / 2, startY + 4, { align: 'center' });
    displayStores.forEach((store, i) => {
      const x = leftMargin + dayColWidth + i * storeColWidth;
      const abbr = store.abbreviation || store.name?.substring(0, 2) || '??';
      doc.text(abbr, x + storeColWidth / 2, startY + 4, { align: 'center' });
    });
    doc.text('Tot', leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, startY + 4, { align: 'center' });

    doc.setDrawColor(100, 100, 100);
    doc.line(leftMargin, startY + rowHeight + 1, gridLineEnd, startY + rowHeight + 1);

    doc.setFont('helvetica', 'normal');
    let gridY = startY + rowHeight + 5;
    const storeTotals = {};
    displayStores.forEach((store) => { storeTotals[store.id] = 0; });
    let grandTotal = 0;

    dates.forEach((date) => {
      const dateKey = date.toISOString().split('T')[0];
      const dayNum = date.getDate().toString();
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;

      if (isWeekend) {
        doc.setFillColor(240, 240, 240);
        doc.rect(leftMargin, gridY - 4, gridLineEnd - leftMargin, rowHeight, 'F');
      }

      doc.setFont('helvetica', 'normal');
      doc.text(dayNum, leftMargin + dayColWidth / 2, gridY, { align: 'center' });

      let dayTotal = 0;
      displayStores.forEach((store, i) => {
        const count = storeDataMap[dateKey]?.[store.id] || 0;
        const osCount = oversizedMap[dateKey]?.[store.id] || 0;
        dayTotal += count;
        storeTotals[store.id] += count;
        const x = leftMargin + dayColWidth + i * storeColWidth;
        if (count > 0) {
          const plusSigns = osCount > 0 ? '+'.repeat(osCount) : '';
          doc.text(count.toString() + plusSigns, x + storeColWidth / 2, gridY, { align: 'center' });
        }
      });

      grandTotal += dayTotal;
      doc.setFont('helvetica', 'bold');
      if (dayTotal > 0) {
        doc.text(dayTotal.toString(), leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, gridY, { align: 'center' });
      }
      doc.setFont('helvetica', 'normal');
      gridY += rowHeight;
    });

    // Totals row
    doc.setDrawColor(100, 100, 100);
    doc.line(leftMargin, gridY - 2, gridLineEnd, gridY - 2);
    gridY += 3;

    doc.setFont('helvetica', 'bold');
    doc.text('Tot', leftMargin + dayColWidth / 2, gridY, { align: 'center' });
    displayStores.forEach((store, i) => {
      const total = storeTotals[store.id];
      const x = leftMargin + dayColWidth + i * storeColWidth;
      if (total > 0) doc.text(total.toString(), x + storeColWidth / 2, gridY, { align: 'center' });
    });
    doc.text(grandTotal.toString(), leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, gridY, { align: 'center' });

    // Vertical dividers
    doc.setDrawColor(150, 150, 150);
    doc.line(leftMargin + dayColWidth, startY + rowHeight + 1, leftMargin + dayColWidth, gridY + 2);
    doc.line(leftMargin + dayColWidth + displayStores.length * storeColWidth, startY + rowHeight + 1, leftMargin + dayColWidth + displayStores.length * storeColWidth, gridY + 2);

    // Box
    doc.setDrawColor(100, 100, 100);
    doc.rect(leftMargin - 1, startY, gridLineEnd - leftMargin + 2, gridY - startY + 3);

    return gridY;
  };

  const dates = getDatesArray();
  const activeStores = getActiveStores(stores);

  if (isSingleDriver) {
    const doc = new jsPDF({ orientation: 'landscape' });
    const leftMargin = 14;
    let y = 15;

    const driverData = payrollData.find((d) => d.driver.id === selectedDriverId);
    if (!driverData) return;

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text(`${driverData.driver.user_name || driverData.driver.full_name} - Payroll Report`, leftMargin, y);
    y += 7;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`${currentPeriod.label} | ${formatDate(currentPeriod.start)} - ${formatDate(currentPeriod.end)}`, leftMargin, y);
    y += 8;

    const { storeDataMap, oversizedMap } = buildStoreDataMaps(activeStores, dates, selectedDriverId);
    const displayStores = filterStoresToData(activeStores, dates, storeDataMap);

    const gridWidth = 140;
    const dayColWidth = 12;
    const storeColWidth = Math.min(12, (gridWidth - dayColWidth - 18) / Math.max(displayStores.length, 1));
    const totalColWidth = 12;
    const rowHeight = 5;

    const gridY = renderGrid(doc, displayStores, dates, storeDataMap, oversizedMap, y, leftMargin, dayColWidth, storeColWidth, totalColWidth, rowHeight);

    // Pay breakdown below grid
    y = gridY + 10;
    const rightColStart = leftMargin;
    const col1_rowTitles = rightColStart;
    const col2_payRates = rightColStart + 24;
    const col3_calcTotals = rightColStart + 64;
    const divider1 = col3_calcTotals + 17;
    const col4_ytdCounts = divider1 + 3;
    const col5_ytdTotals = col4_ytdCounts + 17;
    const rightMargin = col5_ytdTotals + 21;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Pay Breakdown', rightColStart, y);
    y += 5;
    const boxTop = y - 2;

    doc.setFontSize(7);
    const periodCenterX = (col1_rowTitles + col3_calcTotals + 28) / 2;
    const ytdCenterX = (divider1 + 5 + rightMargin) / 2;
    doc.text('Period', periodCenterX, y, { align: 'center' });
    doc.text('YTD', ytdCenterX, y, { align: 'center' });
    y += 1;
    doc.setDrawColor(100, 100, 100);
    doc.line(rightColStart, y, rightMargin, y);
    y += 4;
    const breakdownStartY = y;

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    const lineHeight = 4.5;

    // YTD calculations
    const ytdDeliveries = deliveries.filter((d) => {
      if (!d || d.driver_id !== selectedDriverId) return false;
      const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
      if (!validStatus) return false;
      if (!d.patient_id && !d.after_hours_pickup) return false;
      const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
      const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1);
      return deliveryDate >= yearStart && deliveryDate <= currentPeriod.end;
    });

    const ytdTotalDeliveries = ytdDeliveries.length;
    const ytdTotalBasePay = ytdTotalDeliveries * driverData.payRate;
    const ytdExtraKm = ytdDeliveries.reduce((sum, d) => {
      const patient = patients.find((p) => p?.id === d.patient_id);
      if (!patient?.distance_from_store) return sum;
      const distance = d.paid_km_override ?? patient.distance_from_store;
      return sum + Math.max(0, distance - driverData.extraKmLimit);
    }, 0);
    const ytdExtraKmPay = ytdExtraKm * driverData.extraKmRate;
    const ytdOversizedCount = ytdDeliveries.filter((d) => d.oversized).length;
    const ytdOversizedPay = ytdOversizedCount * driverData.oversizedRate;
    const ytdGrossPay = ytdTotalBasePay + ytdExtraKmPay + ytdOversizedPay;
    const ytdFailedCount = ytdDeliveries.filter((d) => d.status === 'failed').length;
    const ytdReturnsCount = ytdDeliveries.filter((d) => d.status === 'cancelled' && d.after_hours_pickup).length;

    // Delivery Rate
    doc.text('Delivery Rate:', col1_rowTitles, y);
    doc.text(`$${driverData.payRate.toFixed(2)} x ${driverData.totalDeliveries}`, col2_payRates, y);
    doc.text('=$', col3_calcTotals, y);
    doc.text(driverData.totalBasePay.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
    doc.text(`${ytdTotalDeliveries}`, col4_ytdCounts, y);
    doc.text('=$', col5_ytdTotals, y);
    doc.text(ytdTotalBasePay.toFixed(2), rightMargin - 2, y, { align: 'right' });
    y += lineHeight;

    // Extra KM
    doc.text('Extra KM:', col1_rowTitles, y);
    doc.text(`$${driverData.extraKmRate.toFixed(3)}/km (>${driverData.extraKmLimit}km) x ${driverData.totalExtraKm.toFixed(2)} km`, col2_payRates, y);
    doc.text('=$', col3_calcTotals, y);
    doc.text(driverData.totalExtraKmPay.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
    doc.text(`${ytdExtraKm.toFixed(2)} km`, col4_ytdCounts, y);
    doc.text('=$', col5_ytdTotals, y);
    doc.text(ytdExtraKmPay.toFixed(2), rightMargin - 2, y, { align: 'right' });
    y += lineHeight;

    // Oversized
    doc.text('Oversized:', col1_rowTitles, y);
    doc.text(`$${driverData.oversizedRate.toFixed(2)} x ${driverData.oversizedCount}`, col2_payRates, y);
    doc.text('=$', col3_calcTotals, y);
    doc.text(driverData.totalOversizedPay.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
    doc.text(`${ytdOversizedCount}`, col4_ytdCounts, y);
    doc.text('=$', col5_ytdTotals, y);
    doc.text(ytdOversizedPay.toFixed(2), rightMargin - 2, y, { align: 'right' });
    y += lineHeight + 1;

    doc.setDrawColor(150, 150, 150);
    doc.line(divider1, breakdownStartY, divider1, y);
    doc.setDrawColor(100, 100, 100);
    doc.line(rightColStart, y, rightMargin, y);
    y += 5;

    // Pay Summary
    const summaryStartY = y;
    doc.setFont('helvetica', 'bold');
    doc.text('Pay Summary:', col1_rowTitles, y);
    doc.setFont('helvetica', 'normal');
    y += lineHeight;

    const hasDeductions = driverData.taxAmount > 0 || driverData.deductions > 0;
    if (hasDeductions) {
      doc.text('Net Pay:', col1_rowTitles, y);
      doc.text('=$', col3_calcTotals, y);
      doc.text(driverData.grandTotal.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
      doc.text('=$', col5_ytdTotals, y);
      doc.text(ytdGrossPay.toFixed(2), rightMargin - 2, y, { align: 'right' });
      y += lineHeight;

      if (driverData.taxAmount > 0) {
        doc.text(`Tax (${(driverData.taxRate * 100).toFixed(0)}% ${driverData.provinceCode || ''}):`, col1_rowTitles, y);
        doc.text('$', col3_calcTotals + 1, y);
        doc.text(driverData.taxAmount.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
        y += lineHeight;
      }
      if (driverData.deductions > 0) {
        doc.text('Deductions:', col1_rowTitles, y);
        doc.text('-$', col3_calcTotals, y);
        doc.text(driverData.deductions.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
        y += lineHeight;
        if (driverData.deductionsArray?.length > 0) {
          doc.setFontSize(7);
          driverData.deductionsArray.forEach((ded) => {
            doc.text(`  • ${ded.name}:`, col1_rowTitles + 2, y);
            doc.text('-$', col3_calcTotals, y);
            doc.text(ded.amount.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
            y += 3.5;
          });
          doc.setFontSize(8);
        }
      }
      y += 1;
    }

    doc.setFont('helvetica', 'bold');
    doc.text('Gross Pay:', col1_rowTitles, y);
    doc.text('=$', col3_calcTotals, y);
    doc.text(driverData.grossPay.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
    doc.text('=$', col5_ytdTotals, y);
    doc.text(ytdGrossPay.toFixed(2), rightMargin - 2, y, { align: 'right' });
    y += lineHeight;

    doc.setDrawColor(150, 150, 150);
    doc.line(divider1, summaryStartY - 5, divider1, y);

    // App Fee
    if (currentUser && (userHasRole(currentUser, 'admin') || isAppOwner(currentUser))) {
      let appFeeTotal = 0;
      const periodDeliveries = deliveries.filter((d) => {
        if (!d || d.driver_id !== selectedDriverId) return false;
        const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
        if (!validStatus) return false;
        if (!d.patient_id && !d.after_hours_pickup) return false;
        const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
        return deliveryDate >= currentPeriod.start && deliveryDate <= currentPeriod.end;
      });
      periodDeliveries.forEach((d) => {
        const store = stores.find((s) => s?.id === d.store_id);
        if (!store) return;
        let paysAppFees = store.pays_app_fees || false;
        if (store.app_fee_history?.length > 0) {
          const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
          const sorted = [...store.app_fee_history].sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date));
          const entry = sorted.find((e) => new Date(e.effective_date) <= deliveryDate);
          if (entry) paysAppFees = entry.pays_app_fees;
        }
        if (paysAppFees && driverData.appFeePercentage > 0) appFeeTotal += driverData.payRate * driverData.appFeePercentage;
      });
      if (appFeeTotal > 0 && driverData.appFeePercentage > 0) {
        doc.setFont('helvetica', 'normal');
        doc.text(`App Fee (${(driverData.appFeePercentage * 100).toFixed(0)}%):`, col1_rowTitles, y);
        doc.text('$', col3_calcTotals + 1, y);
        doc.text(appFeeTotal.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
        y += lineHeight;
      }
    }

    y += 1;
    doc.setDrawColor(100, 100, 100);
    doc.rect(rightColStart - 1, boxTop, rightMargin - rightColStart + 2, y - boxTop);
    doc.line(rightColStart, y, rightMargin, y);
    y += 4;

    const failedReturnsStartY = y - 4;
    doc.setFont('helvetica', 'normal');
    doc.text('Failed:', col1_rowTitles, y);
    doc.text(`${driverData.failedCount}`, col3_calcTotals + 15, y, { align: 'right' });
    doc.text(`${ytdFailedCount}`, rightMargin - 2, y, { align: 'right' });
    y += lineHeight;
    doc.text('Returns:', col1_rowTitles, y);
    doc.text(`${driverData.storeReturnCount || 0}`, col3_calcTotals + 15, y, { align: 'right' });
    doc.text(`${ytdReturnsCount}`, rightMargin - 2, y, { align: 'right' });
    y += lineHeight;

    doc.setDrawColor(150, 150, 150);
    doc.line(divider1, failedReturnsStartY, divider1, y);
    doc.setDrawColor(100, 100, 100);
    doc.rect(rightColStart - 1, failedReturnsStartY, rightMargin - rightColStart + 2, y - failedReturnsStartY);

    doc.save(filename);
    return;
  }

  // Multi-driver view
  const doc = new jsPDF({ orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const leftMargin = 14;

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Deliveries by Store', leftMargin, 15);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`${currentPeriod.label} | ${formatDate(currentPeriod.start)} - ${formatDate(currentPeriod.end)}`, leftMargin, 22);

  const { storeDataMap, oversizedMap } = buildStoreDataMaps(activeStores, dates, selectedDriverId !== 'all' ? selectedDriverId : null);
  const displayStores = filterStoresToData(activeStores, dates, storeDataMap);

  const tableTop = 30;
  const rowHeight = 6;
  const dayColWidth = 15;
  const storeColWidth = Math.min(14, (pageWidth - leftMargin * 2 - dayColWidth - 22) / Math.max(displayStores.length, 1));
  const totalColWidth = 14;

  renderGrid(doc, displayStores, dates, storeDataMap, oversizedMap, tableTop, leftMargin, dayColWidth, storeColWidth, totalColWidth, rowHeight);

  // Second page: Portrait
  doc.addPage('portrait');
  const portraitWidth = doc.internal.pageSize.getWidth();
  let y = 20;

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Driver Payroll Report', 14, y);
  y += 10;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.text(`Period: ${currentPeriod.label}`, 14, y); y += 6;
  doc.text(`${formatDate(currentPeriod.start)} - ${formatDate(currentPeriod.end)}`, 14, y); y += 6;
  doc.text(`Pay Period Type: ${payPeriod.charAt(0).toUpperCase() + payPeriod.slice(1)}`, 14, y); y += 12;

  payrollData.filter((data) => data.totalDeliveries > 0).forEach((data) => {
    if (y > 250) { doc.addPage(); y = 20; }
    const driverName = data.driver.user_name || data.driver.full_name;
    doc.setFontSize(12); doc.setFont('helvetica', 'bold');
    doc.text(driverName, 14, y); y += 7;
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    const col1 = 14, col2 = 64, col3 = 114;
    doc.text(`Rate: $${data.payRate.toFixed(2)}`, col1, y);
    doc.text(`KM Rate: $${data.extraKmRate.toFixed(3)}/km`, col2, y);
    doc.text(`OS Rate: $${data.oversizedRate.toFixed(2)}`, col3, y); y += 5;
    doc.text(`Del: ${data.totalDeliveries} = $${data.totalBasePay.toFixed(2)}`, col1, y);
    doc.text(`KM: ${data.totalExtraKm.toFixed(2)} = $${data.totalExtraKmPay.toFixed(2)}`, col2, y);
    doc.text(`OS: ${data.oversizedCount} = $${data.totalOversizedPay.toFixed(2)}`, col3, y); y += 5;
    doc.text(`Failed: ${data.failedCount}`, col1, y);
    doc.text(`Store Returns: ${data.storeReturnCount || 0}`, col2, y); y += 7;
    const rightCol = portraitWidth - 14;
    doc.setFont('helvetica', 'normal');
    doc.text('Gross:', rightCol - 40, y - 14); doc.text(`$${(data.grandTotal || 0).toFixed(2)}`, rightCol, y - 14, { align: 'right' });
    doc.text('Tax:', rightCol - 40, y - 9); doc.text(`$${(data.taxAmount || 0).toFixed(2)}`, rightCol, y - 9, { align: 'right' });
    doc.text('Deductions:', rightCol - 40, y - 4); doc.text(`-$${(data.deductions || 0).toFixed(2)}`, rightCol, y - 4, { align: 'right' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('Net:', rightCol - 40, y + 2); doc.text(`$${(data.grossPay || 0).toFixed(2)}`, rightCol, y + 2, { align: 'right' });
    y += 8;
    doc.setDrawColor(200, 200, 200); doc.line(14, y, portraitWidth - 14, y); y += 8;
  });

  if (payrollData.length > 1) {
    if (y > 260) { doc.addPage(); y = 20; }
    doc.setFontSize(12); doc.setFont('helvetica', 'bold');
    doc.text('Total Payroll (All Drivers)', 14, y);
    const rightCol = portraitWidth - 14;
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    doc.text(`Gross: $${grandTotalAllDrivers.toFixed(2)}`, rightCol, y, { align: 'right' }); y += 5;
    doc.text(`Tax: $${grandTotalTax.toFixed(2)}`, rightCol, y, { align: 'right' }); y += 5;
    doc.text(`Deductions: $${grandTotalDeductions.toFixed(2)}`, rightCol, y, { align: 'right' }); y += 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text(`Net: $${grandTotalGross.toFixed(2)}`, rightCol, y, { align: 'right' });
  }

  doc.save(filename);
}