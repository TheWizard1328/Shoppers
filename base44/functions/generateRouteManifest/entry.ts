import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { jsPDF } from 'npm:jspdf@2.5.2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const {
      driverId,
      deliveryDate,
      startDate,
      endDate,
      manifestType: requestedManifestType,
      ampm,
      storeIds,
      selectedCityId,
      recipientEmails,
      emailSubject,
      storeName: requestedStoreName,
      useBarcodes
    } = body || {};

    // ── Code 128B barcode renderer (pure JS, no external lib) ───────────────
    // Returns array of {x, w} bar positions (in units) for the given string.
    function encodeCode128B(text) {
      const START_B = 104;
      const STOP = 106;
      const CODE128_BARS = [
        '11011001100','11001101100','11001100110','10010011000','10010001100',
        '10001001100','10011001000','10011000100','10001100100','11001001000',
        '11001000100','11000100100','10110011100','10011011100','10011001110',
        '10111001100','10011101100','10011100110','11001110010','11001011100',
        '11001001110','11011100100','11001110100','11101101110','11101001100',
        '11100101100','11100100110','11101100100','11100110100','11100110010',
        '11011011000','11011000110','11000110110','10100011000','10001011000',
        '10001000110','10110001000','10001101000','10001100010','11010001000',
        '11000101000','11000100010','10110111000','10110001110','10001101110',
        '10111011000','10111000110','10001110110','11101110110','11010001110',
        '11000101110','11011101000','11011100010','11011101110','11101011000',
        '11101000110','11100010110','11101101000','11101100010','11100011010',
        '11101111010','11001000010','11110001010','10100110000','10100001100',
        '10010110000','10010000110','10000101100','10000100110','10110010000',
        '10110000100','10011010000','10011000010','10000110100','10000110010',
        '11000010010','11001010000','11110111010','11000010100','10001111010',
        '10100111100','10010111100','10010011110','10111100100','10011110100',
        '10011110010','11110100100','11110010100','11110010010','11011011110',
        '11011110110','11110110110','10101111000','10100011110','10001011110',
        '10111101000','10111100010','11110101000','11110100010','10111011110',
        '10111101110','11101011110','11110101110','11010000100','11010010000',
        '11010011100','1100011101011'
      ];
      const chars = [];
      let checksum = START_B;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i) - 32;
        if (code < 0 || code > 95) continue;
        chars.push(code);
        checksum += code * (i + 1);
      }
      const checksumVal = checksum % 103;
      const pattern = CODE128_BARS[START_B] + chars.map((c) => CODE128_BARS[c]).join('') + CODE128_BARS[checksumVal] + CODE128_BARS[STOP];
      const bars = [];
      let x = 0;
      for (let i = 0; i < pattern.length; i++) {
        const w = parseInt(pattern[i], 10);
        bars.push({ x, w, bar: i % 2 === 0 });
        x += w;
      }
      return { bars, totalWidth: x };
    }

    // Draw a Code128 barcode into jsPDF at (x, y) with given width and height
    function drawBarcode(doc, text, x, y, targetWidth, targetHeight) {
      const { bars, totalWidth } = encodeCode128B(text);
      if (totalWidth === 0) return;
      const scale = targetWidth / totalWidth;
      doc.setFillColor(0, 0, 0);
      for (const bar of bars) {
        if (bar.bar) {
          doc.rect(x + bar.x * scale, y, bar.w * scale, targetHeight, 'F');
        }
      }
    }

    const isValidEmail = (value) => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
    const callerAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1).catch(() => []);
    const callerAppUser = callerAppUsers?.[0] || null;

    const logEmailIntegrationUsage = async ({ success, startedAt, errorMessage = null, metadata = {} }) => {
      try {
        await base44.asServiceRole.entities.IntegrationUsageLog.create({
          timestamp: new Date(startedAt).toISOString(),
          integration_name: 'gmail',
          operation_name: 'send_message',
          feature: 'route_manifest_email_export',
          app_user_id: callerAppUser?.id || null,
          app_user_name: callerAppUser?.user_name || user.full_name || null,
          auth_user_id: user.id,
          duration_ms: Date.now() - startedAt,
          success,
          estimated_credits_used: 0,
          error_message: errorMessage,
          metadata
        });
      } catch (trackingError) {
        console.warn('[generateRouteManifest] Tracking failed:', trackingError?.message || trackingError);
      }
    };

    // Build list of dates to process
    const datesToProcess = [];
    if (startDate && endDate) {
      const start = new Date(`${startDate}T12:00:00`);
      const end = new Date(`${endDate}T12:00:00`);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        datesToProcess.push(d.toISOString().substring(0, 10));
      }
    } else if (deliveryDate) {
      datesToProcess.push(deliveryDate);
    }

    if (datesToProcess.length === 0 || (!driverId && (!Array.isArray(storeIds) || storeIds.length === 0))) {
      return Response.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // Guard: cap at 31 days to avoid timeouts
    if (datesToProcess.length > 31) {
      return Response.json({ error: `Date range too large (${datesToProcess.length} days). Please select 14 days or fewer.` }, { status: 400 });
    }

    const finished = ['completed', 'failed', 'cancelled', 'returned'];
    const isObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);

    function extractTime(timeStr) {
      if (!timeStr) return '';
      if (timeStr.includes('T')) {
        const timePart = timeStr.split('T')[1];
        if (timePart) return timePart.substring(0, 5);
      }
      if (/^\d{2}:\d{2}/.test(timeStr)) return timeStr.substring(0, 5);
      return timeStr;
    }

    function getImageDimensions(bytes, type) {
      try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (type === 'PNG') {
          if (bytes.length < 24) return null;
          return { width: view.getUint32(16), height: view.getUint32(20) };
        } else if (type === 'JPEG') {
          let offset = 2;
          while (offset < bytes.length - 10) {
            if (bytes[offset] !== 0xFF) break;
            const marker = bytes[offset + 1];
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
              return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
            }
            offset += 2 + view.getUint16(offset + 2);
          }
        }
      } catch { return null; }
      return null;
    }

    async function fetchImageAsBase64(url) {
      try {
        if (!url) return null;
        const response = await fetch(url);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let format = 'JPEG';
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
          format = 'PNG';
        } else if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
          format = 'JPEG';
        } else {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('png')) format = 'PNG';
        }
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        const mimeType = format === 'PNG' ? 'image/png' : 'image/jpeg';
        const dimensions = getImageDimensions(bytes, format);
        return { base64Data: `data:${mimeType};base64,${base64}`, format, width: dimensions?.width, height: dimensions?.height };
      } catch { return null; }
    }

    const encodeBase64Url = (value) => {
      // Use TextEncoder to handle full UTF-8 range safely
      const bytes = new TextEncoder().encode(value);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };

    const uint8ToBase64 = (bytes) => {
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    };

    // Encode a header value (subject, filename) safely as UTF-8 base64 MIME word
    const encodeMimeWord = (value) => {
      const b64 = uint8ToBase64(new TextEncoder().encode(value));
      return `=?UTF-8?B?${b64}?=`;
    };

    const buildGmailRawMessageMulti = ({ to, subject, body, attachments }) => {
      const boundary = `route_manifest_${crypto.randomUUID()}`;
      // Encode body as base64 to handle any UTF-8 characters
      const bodyB64 = uint8ToBase64(new TextEncoder().encode(body)).replace(/(.{76})/g, '$1\r\n');
      const parts = [
        `To: ${to}`,
        `Subject: ${encodeMimeWord(subject)}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        bodyB64,
        ''
      ];

      for (const { pdfBytes, fileName } of attachments) {
        const pdfBase64 = uint8ToBase64(new Uint8Array(pdfBytes)).replace(/(.{76})/g, '$1\r\n');
        const encodedFileName = encodeMimeWord(fileName);
        parts.push(
          `--${boundary}`,
          `Content-Type: application/pdf; name="${encodedFileName}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${encodedFileName}"`,
          '',
          pdfBase64,
          ''
        );
      }

      parts.push(`--${boundary}--`);
      return encodeBase64Url(parts.join('\r\n'));
    };

    // ─── Resolve effective store IDs once (shared across all dates) ─────────────
    let finalStoreIds = Array.isArray(storeIds) && storeIds.length > 0 ? [...storeIds] : null;

    if (selectedCityId) {
      const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: selectedCityId });
      const cityStoreIds = (cityStores || []).map((s) => s.id);
      if (finalStoreIds) {
        finalStoreIds = finalStoreIds.filter((id) => cityStoreIds.includes(id));
      } else {
        finalStoreIds = cityStoreIds;
      }
    }

    // ─── Generate manifest content for one date into a shared jsPDF doc ────────
    async function generateManifestForDate(doc, dateStr, isFirstDate) {
      // Build a targeted filter — only fetch what this dispatcher needs
      const deliveryFilter = { delivery_date: dateStr };
      if (driverId) deliveryFilter.driver_id = driverId;
      if (finalStoreIds && finalStoreIds.length > 0) deliveryFilter.store_id = { $in: finalStoreIds };

      const deliveries = await base44.asServiceRole.entities.Delivery.filter(deliveryFilter);
      // Exclude cycling marker pseudo-stops — they have no delivery data and corrupt stop/TR# ordering
      let items = (deliveries || []).filter((d) => d && !d.is_cycling_marker);

      // ── AUTO-DETECT manifestType from actual data ──────────────────────────
      const allFinished = items.length > 0 && items.every((d) => finished.includes(d?.status));
      const hasAnyPending = items.some((d) => !finished.includes(d?.status));

      let manifestType;
      let effectiveAmpm = ampm || 'AM';

      if (requestedManifestType === 'pre-route' && hasAnyPending) {
        manifestType = 'pre-route';
      } else if (allFinished || !hasAnyPending) {
        manifestType = 'post-route';
      } else {
        manifestType = requestedManifestType || 'post-route';
      }

      // Build name/driver maps — only fetch IDs that actually appear in this dataset
      const creatorAppUserIds = [...new Set(items.map((i) => i?.created_by_app_user_id).filter(isObjectId))];
      // Also collect created_by_id values so we can look them up as AppUser.user_id
      const creatorAuthUserIds = [...new Set(items.map((i) => i?.created_by_id).filter(isObjectId))];
      const driverIds = [...new Set(items.map((i) => i?.driver_id).filter(Boolean))];

      // Combine all IDs that might match AppUser.id or AppUser.user_id
      const allCreatorLookupIds = [...new Set([...creatorAppUserIds, ...creatorAuthUserIds])];

      const [creatorAppUsersById, creatorAppUsersByUserId, driverAppUsers] = await Promise.all([
        creatorAppUserIds.length > 0 ? base44.asServiceRole.entities.AppUser.filter({ id: { $in: creatorAppUserIds } }) : [],
        creatorAuthUserIds.length > 0 ? base44.asServiceRole.entities.AppUser.filter({ user_id: { $in: creatorAuthUserIds } }) : [],
        driverIds.length > 0 ? base44.asServiceRole.entities.AppUser.filter({ user_id: { $in: driverIds } }) : []
      ]);

      // Priority: AppUser.user_name always wins — never fall back to platform User names
      const creatorNameMap = new Map();
      (creatorAppUsersById || []).forEach((u) => {
        creatorNameMap.set(u.id, u.user_name || u.id);
        if (u.user_id) creatorNameMap.set(u.user_id, u.user_name || u.user_id);
      });
      (creatorAppUsersByUserId || []).forEach((u) => {
        if (!creatorNameMap.has(u.user_id)) creatorNameMap.set(u.user_id, u.user_name || u.user_id);
        if (!creatorNameMap.has(u.id)) creatorNameMap.set(u.id, u.user_name || u.id);
      });
      const driverNameMap = new Map((driverAppUsers || []).map((u) => [u.user_id, u.user_name || u.full_name || u.user_id]));

      // Filter and sort items
      if (manifestType === 'pre-route') {
        const period = effectiveAmpm === 'PM' ? 'PM' : 'AM';
        items = items.filter((d) => d?.ampm_deliveries === period && !finished.includes(d?.status));
        items.sort((a, b) => {
          if (!driverId) {
            const dc = (driverNameMap.get(a?.driver_id) || '').localeCompare(driverNameMap.get(b?.driver_id) || '');
            if (dc !== 0) return dc;
          }
          const soDiff = (a?.stop_order ?? 9999) - (b?.stop_order ?? 9999);
          if (soDiff !== 0) return soDiff;
          return (a?.delivery_time_start || '99:99').localeCompare(b?.delivery_time_start || '99:99');
        });
      } else {
        items.sort((a, b) => {
          const dA = a?.actual_delivery_time || a?.arrival_time || a?.updated_date || '';
          const dB = b?.actual_delivery_time || b?.arrival_time || b?.updated_date || '';
          if (dA && dB) { const c = dA.localeCompare(dB); if (c !== 0) return c; }
          else if (dA || dB) return dA ? -1 : 1;
          const nc = (driverNameMap.get(a?.driver_id) || '').localeCompare(driverNameMap.get(b?.driver_id) || '');
          if (nc !== 0) return nc;
          return (a?.stop_order ?? 9999) - (b?.stop_order ?? 9999);
        });
      }

      // Fetch patients, stores, and fridge temp logs for this date
      const patientIds = [...new Set(items.map((i) => i?.patient_id).filter(Boolean))];
      const manifestStoreIds = [...new Set(items.map((i) => i?.store_id).filter(Boolean))];
      const fridgeDriverIds = [...new Set(items.filter((i) => i?.fridge_item && i?.driver_id).map((i) => i.driver_id))];

      const [manifestPatients, manifestStores, fridgeTempLogs] = await Promise.all([
        patientIds.length > 0 ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }) : [],
        manifestStoreIds.length > 0 ? base44.asServiceRole.entities.Store.filter({ id: { $in: manifestStoreIds } }) : [],
        fridgeDriverIds.length > 0
          ? base44.asServiceRole.entities.RxTempLogs.filter({ delivery_date: dateStr, driver_id: { $in: fridgeDriverIds } })
          : []
      ]);

      // Map: driver_id -> sorted temperature readings for this date
      const fridgeTempByDriver = new Map();
      (fridgeTempLogs || []).forEach((log) => {
        if (log?.driver_id && Array.isArray(log.temperature_readings)) {
          fridgeTempByDriver.set(log.driver_id, [...log.temperature_readings].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || '')));
        }
      });

      const patientNameMap = new Map((manifestPatients || []).map((p) => [p.id, p.full_name || p.patient_id || p.id]));
      const storeNameMap = new Map((manifestStores || []).map((s) => [s.id, s.name || s.abbreviation || s.id]));

      const displayStoreName = requestedStoreName
        || (manifestStores.length === 1 ? manifestStores[0]?.name : null)
        || (finalStoreIds?.length === 1 ? (manifestStores.find((s) => s.id === finalStoreIds[0])?.name || 'Store') : null)
        || 'All Stores';

      // Fetch images in parallel — only for items that actually have them
      const imagePromises = items.map(async (d) => {
        const result = { signature: null, photos: [] };
        if (d?.signature_image_url) result.signature = await fetchImageAsBase64(d.signature_image_url);
        if (Array.isArray(d?.proof_photo_urls) && d.proof_photo_urls.length > 0) {
          const photoResults = await Promise.all(d.proof_photo_urls.slice(0, 3).map((url) => fetchImageAsBase64(url)));
          result.photos = photoResults.filter(Boolean);
        }
        return result;
      });
      const allImages = await Promise.all(imagePromises);

      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const thumbSize = 12;
      const sigSize = 15; // 25% larger than thumbSize
      const rightGap = 3;

      doc.setLineWidth(0.2);
      doc.setLineHeightFactor(1.2);
      const snap = (n) => Math.round(n * 2) / 2;
      const minRowHeight = 6;
      const cellPadding = 1;
      const textTopOffset = 0.5;

      // Each date starts on a fresh page (except the very first)
      if (!isFirstDate) { doc.addPage(); }

      const titleType = manifestType === 'pre-route' ? `Pre-Route (${effectiveAmpm})` : 'Post-Route (All)';
      doc.setFontSize(16);
      doc.text(`Route Manifest - ${titleType}`, 14, 18);
      doc.setFontSize(11);
      doc.text(`Store: ${displayStoreName}    Date: ${dateStr}${driverId ? `    Driver: ${driverNameMap.get(driverId) || driverId}` : ''}`, 14, 26);

      let y = 36;
      const colStop = 12;
      const colTR = 26;
      const colTime = 42;
      const colName = 58;
      const rightMargin = pageWidth - 12;
      const colPhotos = rightMargin - thumbSize;
      const colSig = colPhotos - (thumbSize + rightGap);
      const colRx = colSig - (thumbSize + rightGap);
      const colReceipts = colRx - (thumbSize + rightGap);
      const colNotes = colReceipts - 34;
      const colCreatedBy = colNotes - 28;
      const colDriver = colCreatedBy - 28;

      const addHeader = () => {
        doc.setFontSize(9);
        doc.setFont(undefined, 'bold');
        doc.text('Stop', colStop, y);
        doc.text('TR#', colTR, y);
        doc.text('Time', colTime, y);
        doc.text('Name / Store', colName, y);
        doc.text('Driver', colDriver, y);
        doc.text('Created By', colCreatedBy, y);
        doc.text('Notes', colNotes, y);
        doc.text('Rcpt', colReceipts + thumbSize / 2, y, { align: 'center' });
        doc.text('Rx', colRx + thumbSize / 2, y, { align: 'center' });
        doc.text('Sig', colSig + thumbSize / 2, y, { align: 'center' });
        doc.text('Photos', colPhotos + thumbSize / 2, y, { align: 'center' });
        doc.setFont(undefined, 'normal');
        y = snap(y + 1);
        doc.setDrawColor(180);
        doc.line(colStop, y, pageWidth - 10, y);
        y = snap(y + 4);
      };

      addHeader();

      function drawCountCell(x, cellY, count) {
        try {
          doc.setFontSize(9);
          doc.text(String(count), x + thumbSize / 2, cellY + 4.5, { align: 'center' });
        } catch {}
      }

      for (let i = 0; i < items.length; i++) {
        const d = items[i];
        const images = allImages[i];
        const isPickup = !d?.patient_id;
        const name = isPickup
          ? (storeNameMap.get(d?.store_id) || d?.delivery_notes || 'Store Pickup')
          : (patientNameMap.get(d?.patient_id) || d?.patient_name || '');
        const driverName = driverNameMap.get(d?.driver_id) || d?.driver_name || d?.driver_id || '';
        const createdByName = creatorNameMap.get(d?.created_by_app_user_id) || creatorNameMap.get(d?.created_by_id) || d?.created_by_id || '';
        const notes = d?.delivery_notes || '';
        const stopLabel = isPickup ? 'P' : (d?.stop_order != null ? String(d.stop_order) : '');
        const trNum = d?.tracking_number || '';
        const timeStr = extractTime(d?.actual_delivery_time || d?.arrival_time || '');

        // Build fridge temp string from RxTempLogs (keyed by driver_id)
        const fridgeTempStr = (() => {
          if (!d?.fridge_item || !d?.driver_id) return '';
          const readings = fridgeTempByDriver.get(d.driver_id);
          if (!readings || readings.length === 0) return '';
          return '❄ ' + readings.map((r) => {
            const t = r.timestamp ? r.timestamp.substring(11, 16) : '';
            return `${r.temperature_celsius}°C@${t}`;
          }).join(', ');
        })();

        const barcodeValues = Array.isArray(d?.barcode_values) ? d.barcode_values.filter(Boolean) : [];
        // Text mode: Rx numbers as plain text
        const barcodeStr = !useBarcodes && barcodeValues.length > 0
          ? 'Rx: ' + barcodeValues.map((b) => String(b).substring(0, 8)).join(' - Rx: ')
          : '';
        // Barcode mode: all barcodes on ONE row, side by side
        const barcodesToDraw = useBarcodes ? barcodeValues.map((b) => String(b).substring(0, 8)) : [];
        const barcodeH = 6;    // mm tall per barcode
        const barcodeW = 28;   // mm wide per barcode (fits ~8 across the name column area)
        const barcodeGap = 3;  // mm gap between barcodes
        // Only one extra row needed regardless of how many barcodes (they all sit side by side)
        const barcodeRowHeight = barcodesToDraw.length > 0 ? (barcodeH + 4) : 0; // 4mm for label below
        const barcodeLineCount = barcodeStr ? 1 : 0;

        const nameLines = doc.splitTextToSize(name, 27); // reduced 40% from 45
        const driverLines = doc.splitTextToSize(driverName, 24);
        const createdByLines = doc.splitTextToSize(createdByName, 24);
        const fridgeTempLines = fridgeTempStr ? doc.splitTextToSize(fridgeTempStr, 28) : [];
        const notesLines = doc.splitTextToSize(fridgeTempStr ? (fridgeTempStr + (notes ? '\n' + notes : '')) : notes, 28);
        const textContentLines = Math.max(nameLines.length + barcodeLineCount, driverLines.length, createdByLines.length, notesLines.length, 1);
        const hasPhotos = images?.photos?.length > 0;
        const hasSig = !!images?.signature;
        const needsPhotoRow = hasPhotos;
        const imageRowHeight = needsPhotoRow ? thumbSize + 2 : 0;
        const rowHeight = snap(Math.max(minRowHeight, textContentLines * 4.5 + cellPadding * 2) + imageRowHeight + barcodeRowHeight);
        const contentLines = textContentLines;

        if (y + rowHeight > pageHeight - 20) {
          doc.addPage();
          y = 20;
          addHeader();
        }

        const textY = snap(y + textTopOffset + cellPadding);
        const rowBottom = snap(y + rowHeight);

        doc.setFontSize(9);
        doc.text(stopLabel, colStop, textY + 3);
        doc.text(String(trNum), colTR, textY + 3);
        doc.text(timeStr, colTime, textY + 3);
        doc.text(nameLines, colName, textY + 3);
        // Rx: text numbers (non-barcode mode)
        if (barcodeStr) {
          doc.setFontSize(7.5);
          doc.setFont(undefined, 'italic');
          doc.text(barcodeStr, colName, textY + 3 + nameLines.length * 4.5);
          doc.setFont(undefined, 'normal');
          doc.setFontSize(9);
        }
        // Barcode mode: draw all barcodes side by side on a single row
        if (barcodesToDraw.length > 0) {
          const barcodeRowY = textY + textContentLines * 4.5 + cellPadding + 1;
          barcodesToDraw.forEach((bval, bi) => {
            const bx = colName + bi * (barcodeW + barcodeGap);
            drawBarcode(doc, bval, bx, barcodeRowY, barcodeW, barcodeH);
            doc.setFontSize(6);
            doc.setTextColor(60);
            doc.text(bval, bx + barcodeW / 2, barcodeRowY + barcodeH + 2, { align: 'center' });
            doc.setTextColor(0);
            doc.setFontSize(9);
          });
        }
        doc.text(driverLines, colDriver, textY + 3);
        doc.text(createdByLines, colCreatedBy, textY + 3);
        doc.text(notesLines, colNotes, textY + 3);

        const receiptCount = Array.isArray(d?.receipt_urls) ? d.receipt_urls.length : 0;
        const rxCount = Array.isArray(d?.rx_photo_urls) ? d.rx_photo_urls.length : 0;
        if (receiptCount > 0) drawCountCell(colReceipts, textY, receiptCount);
        if (rxCount > 0) drawCountCell(colRx, textY, rxCount);

        const imageBaseY = textY + contentLines * 4.5 + cellPadding;
        if (hasSig && images.signature) {
          try {
            // Signature spans the full row height (text area + any remaining space)
            const availH = rowBottom - textY - 2;
            let w = sigSize, h = Math.min(availH, sigSize);
            if (images.signature.width && images.signature.height) {
              const ratio = images.signature.width / images.signature.height;
              // Fit within available height, up to sigSize wide
              h = Math.min(availH, sigSize);
              w = h * ratio;
              if (w > sigSize) { w = sigSize; h = w / ratio; }
            }
            const x = colSig + (sigSize - w) / 2;
            const imgY = textY + (availH - h) / 2;
            doc.addImage(images.signature.base64Data, images.signature.format, x, imgY, w, h);
          } catch { doc.setDrawColor(200); doc.rect(colSig, textY, sigSize, rowBottom - textY - 2); }
        }

        let photoX = colPhotos;
        if (images?.photos) {
          for (const photo of images.photos) {
            try {
              let w = thumbSize, h = thumbSize;
              if (photo.width && photo.height) {
                const ratio = photo.width / photo.height;
                if (ratio > 1) { h = thumbSize / ratio; } else { w = thumbSize * ratio; }
              }
              let x = photoX, imgY = imageBaseY;
              if (w < thumbSize) x += (thumbSize - w) / 2;
              if (h < thumbSize) imgY += (thumbSize - h) / 2;
              doc.addImage(photo.base64Data, photo.format, x, imgY, w, h);
              photoX -= (thumbSize + rightGap);
            } catch { doc.setDrawColor(200); doc.rect(photoX, textY, thumbSize, thumbSize); photoX -= (thumbSize + rightGap); }
          }
        }

        y = rowBottom;
        doc.setDrawColor(230);
        doc.line(colStop, rowBottom, pageWidth - 10, rowBottom);
      }

      y = snap(y + 4);
      if (y > pageHeight - 20) { doc.addPage(); y = 20; }
      doc.setFontSize(9);
      doc.text(`Total stops: ${items.length}`, 14, y);

      // ─── Temperature Graph ───────────────────────────────────────────────────
      // Only render if there are fridge items AND temp readings exist
      const hasFridgeItems = items.some((d) => d?.fridge_item);
      const allTempReadings = [];
      fridgeTempByDriver.forEach((readings) => allTempReadings.push(...readings));
      allTempReadings.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

      if (hasFridgeItems && allTempReadings.length > 0) {
        // Determine route time window: pickup arrival → last delivery time
        const pickupItems = items.filter((d) => !d?.patient_id && (d?.arrival_time || d?.actual_delivery_time));
        const deliveryItems = items.filter((d) => d?.patient_id && (d?.actual_delivery_time || d?.arrival_time));

        const routeStartStr = pickupItems.length > 0
          ? (pickupItems[0]?.arrival_time || pickupItems[0]?.actual_delivery_time)
          : allTempReadings[0]?.timestamp;
        const routeEndStr = deliveryItems.length > 0
          ? deliveryItems.reduce((latest, d) => {
              const t = d.actual_delivery_time || d.arrival_time || '';
              return t > latest ? t : latest;
            }, '')
          : allTempReadings[allTempReadings.length - 1]?.timestamp;

        const toMinutes = (ts) => {
          if (!ts) return null;
          const t = ts.includes('T') ? ts.split('T')[1] : ts;
          const parts = (t || '').substring(0, 5).split(':');
          if (parts.length < 2) return null;
          return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        };

        const routeStartMin = toMinutes(routeStartStr) ?? toMinutes(allTempReadings[0]?.timestamp);
        const routeEndMin = toMinutes(routeEndStr) ?? toMinutes(allTempReadings[allTempReadings.length - 1]?.timestamp);

        // Filter readings to those within (or near) the route window
        const windowReadings = allTempReadings.filter((r) => {
          const m = toMinutes(r.timestamp);
          if (m === null) return false;
          // Allow ±30 min padding around route window
          return m >= (routeStartMin - 30) && m <= (routeEndMin + 30);
        });

        if (windowReadings.length > 0) {
          // Start graph on a new page if not enough space (need ~80mm)
          if (y + 90 > pageHeight - 10) { doc.addPage(); y = 20; }
          else { y = snap(y + 10); }

          const graphX = 14;
          const graphW = pageWidth - 28;
          const graphH = 60;
          const graphY = y;
          const axisBottom = graphY + graphH;
          const axisLeft = graphX + 16;
          const axisRight = graphX + graphW;
          const plotW = axisRight - axisLeft;
          const plotTop = graphY + 6;
          const plotH = axisBottom - plotTop;

          // Title
          doc.setFontSize(10);
          doc.setFont(undefined, 'bold');
          doc.text('Cooler Temperature Log', axisLeft, graphY + 3);
          doc.setFont(undefined, 'normal');

          // Determine temp range with padding
          const temps = windowReadings.map((r) => r.temperature_celsius).filter((t) => typeof t === 'number');
          const tempMin = Math.min(...temps, 0);
          const tempMax = Math.max(...temps, 8);
          const tempPad = Math.max(1, (tempMax - tempMin) * 0.15);
          const tLow = Math.floor(tempMin - tempPad);
          const tHigh = Math.ceil(tempMax + tempPad);
          const tRange = tHigh - tLow || 1;

          // Time axis range
          const allMinutes = windowReadings.map((r) => toMinutes(r.timestamp)).filter((m) => m !== null);
          const tMinStart = Math.min(...allMinutes);
          const tMinEnd = Math.max(...allMinutes);
          const tMinRange = tMinEnd - tMinStart || 1;

          const xForMin = (m) => axisLeft + ((m - tMinStart) / tMinRange) * plotW;
          const yForTemp = (t) => axisBottom - ((t - tLow) / tRange) * plotH;

          // Background
          doc.setFillColor(248, 250, 252);
          doc.rect(axisLeft, plotTop, plotW, plotH, 'F');

          // Safe zone band (2–6°C)
          const safeTop = yForTemp(6);
          const safeBot = yForTemp(2);
          doc.setFillColor(220, 242, 220);
          doc.rect(axisLeft, safeTop, plotW, safeBot - safeTop, 'F');

          // Horizontal gridlines & Y-axis labels
          doc.setDrawColor(210, 220, 230);
          doc.setFontSize(7);
          const tempStep = tRange <= 8 ? 1 : 2;
          for (let t = Math.ceil(tLow); t <= tHigh; t += tempStep) {
            const gy = yForTemp(t);
            doc.setLineWidth(0.15);
            doc.line(axisLeft, gy, axisRight, gy);
            doc.setTextColor(100);
            doc.text(`${t}°`, axisLeft - 2, gy + 1, { align: 'right' });
          }

          // Fridge delivery event lines (vertical, per driver)
          const fridgeDeliveries = items.filter((d) => d?.fridge_item && d?.patient_id && (d?.actual_delivery_time || d?.arrival_time));
          doc.setDrawColor(59, 130, 246); // blue
          doc.setLineWidth(0.4);
          fridgeDeliveries.forEach((d) => {
            const ts = d.actual_delivery_time || d.arrival_time;
            const m = toMinutes(ts);
            if (m === null) return;
            const fx = xForMin(m);
            if (fx < axisLeft || fx > axisRight) return;
            // Dashed vertical line
            const dashLen = 1.5;
            for (let dy = plotTop; dy < axisBottom; dy += dashLen * 2) {
              doc.line(fx, dy, fx, Math.min(dy + dashLen, axisBottom));
            }
            // Small label at top
            doc.setFontSize(6);
            doc.setTextColor(59, 130, 246);
            const timeLabel = extractTime(ts);
            doc.text(timeLabel, fx, plotTop - 1, { align: 'center' });
          });

          // Temperature line
          doc.setDrawColor(220, 38, 38); // red
          doc.setLineWidth(0.6);
          doc.setTextColor(0);
          for (let i = 0; i < windowReadings.length - 1; i++) {
            const r1 = windowReadings[i];
            const r2 = windowReadings[i + 1];
            const m1 = toMinutes(r1.timestamp), m2 = toMinutes(r2.timestamp);
            if (m1 === null || m2 === null) continue;
            doc.line(xForMin(m1), yForTemp(r1.temperature_celsius), xForMin(m2), yForTemp(r2.temperature_celsius));
          }

          // Dots + value labels on each reading
          doc.setFillColor(220, 38, 38);
          windowReadings.forEach((r) => {
            const m = toMinutes(r.timestamp);
            if (m === null) return;
            const px = xForMin(m);
            const py = yForTemp(r.temperature_celsius);
            doc.circle(px, py, 0.8, 'F');
            doc.setFontSize(6.5);
            doc.setTextColor(80);
            doc.text(`${r.temperature_celsius}°`, px, py - 2, { align: 'center' });
          });

          // X-axis time labels (pick ~6 evenly spaced)
          doc.setFontSize(7);
          doc.setTextColor(100);
          doc.setDrawColor(180);
          doc.setLineWidth(0.2);
          const labelCount = Math.min(windowReadings.length, 6);
          const step = Math.max(1, Math.floor(windowReadings.length / labelCount));
          for (let i = 0; i < windowReadings.length; i += step) {
            const r = windowReadings[i];
            const m = toMinutes(r.timestamp);
            if (m === null) continue;
            const lx = xForMin(m);
            doc.line(lx, axisBottom, lx, axisBottom + 1.5);
            doc.text(extractTime(r.timestamp), lx, axisBottom + 4, { align: 'center' });
          }

          // Axes
          doc.setDrawColor(100);
          doc.setLineWidth(0.3);
          doc.line(axisLeft, plotTop, axisLeft, axisBottom);     // Y
          doc.line(axisLeft, axisBottom, axisRight, axisBottom); // X

          // Legend
          const legY = axisBottom + 10;
          doc.setFontSize(7.5);
          doc.setTextColor(0);
          // Green safe zone
          doc.setFillColor(180, 230, 180);
          doc.rect(axisLeft, legY - 3, 5, 3.5, 'F');
          doc.text('Safe zone (2–6°C)', axisLeft + 7, legY);
          // Red line = temp
          doc.setDrawColor(220, 38, 38);
          doc.setLineWidth(0.6);
          doc.line(axisLeft + 50, legY - 1.5, axisLeft + 56, legY - 1.5);
          doc.setFillColor(220, 38, 38);
          doc.circle(axisLeft + 53, legY - 1.5, 0.8, 'F');
          doc.setTextColor(0);
          doc.text('Temperature reading', axisLeft + 59, legY);
          // Blue dashed = fridge delivery
          if (fridgeDeliveries.length > 0) {
            doc.setDrawColor(59, 130, 246);
            doc.setLineWidth(0.4);
            for (let dx = 0; dx < 6; dx += 2) {
              doc.line(axisLeft + 108 + dx, legY - 1.5, axisLeft + 108 + dx + 1, legY - 1.5);
            }
            doc.setTextColor(0);
            doc.text('Fridge item delivered', axisLeft + 116, legY);
          }

          y = legY + 8;
        }
      }
      // ─── End Temperature Graph ───────────────────────────────────────────────

      // Return metadata only — pdfBytes come from the shared doc at the end
      return { displayStoreName, manifestType, dateStr };
    }

    // ─── Create ONE shared doc, process all dates into it ───────────────────────
    const sharedDoc = new jsPDF({ orientation: 'landscape', unit: 'mm' });
    const dateMetadata = [];
    for (let i = 0; i < datesToProcess.length; i++) {
      const meta = await generateManifestForDate(sharedDoc, datesToProcess[i], i === 0);
      dateMetadata.push(meta);
      // Throttle between dates to avoid hitting DB rate limits on large ranges
      if (i < datesToProcess.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const combinedPdfBytes = sharedDoc.output('arraybuffer');
    const combinedPdfBase64 = uint8ToBase64(new Uint8Array(combinedPdfBytes as ArrayBuffer));

    const isSingleDate = datesToProcess.length === 1;
    const dateRangeStr = isSingleDate
      ? datesToProcess[0]
      : `${datesToProcess[0]} to ${datesToProcess[datesToProcess.length - 1]}`;
    const firstStoreName = dateMetadata[0]?.displayStoreName || requestedStoreName || 'All Stores';
    const combinedFileName = `RxDeliver Logs - ${firstStoreName} - ${dateRangeStr}.pdf`;

    if (Array.isArray(recipientEmails) && recipientEmails.length > 0) {
      const uniqueRecipientEmails = [...new Set(
        recipientEmails.map((email) => typeof email === 'string' ? email.trim().toLowerCase() : '').filter(isValidEmail)
      )];

      if (uniqueRecipientEmails.length === 0) {
        return Response.json({ error: 'No valid recipient emails were provided' });
      }

      const { accessToken } = await base44.asServiceRole.connectors.getConnection('gmail', { forceRefresh: true });
      const emailStartedAt = Date.now();

      const subject = emailSubject || `RxDeliver Route logs for: ${firstStoreName} - ${dateRangeStr}`;
      const bodyLines = [`RxDeliver Route logs for: ${firstStoreName} - ${dateRangeStr}`, ''];
      if (!isSingleDate) {
        dateMetadata.forEach(({ displayStoreName: ds, dateStr: dt, manifestType: mt }) => {
          bodyLines.push(`• ${dt} (${mt}) — ${ds}`);
        });
      }
      const body = bodyLines.join('\n');
      const attachments = [{ pdfBytes: combinedPdfBytes, fileName: combinedFileName }];

      try {
        const toAddresses = uniqueRecipientEmails.join(', ');
        const raw = buildGmailRawMessageMulti({ to: toAddresses, subject, body, attachments });

        let gmailResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw })
        });

        if (gmailResponse.status === 401) {
          console.warn('[generateRouteManifest] Gmail 401 on first attempt — retrying with refreshed token');
          const { accessToken: refreshedToken } = await base44.asServiceRole.connectors.getConnection('gmail');
          gmailResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${refreshedToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw })
          });
        }

        if (!gmailResponse.ok) {
          const errorText = await gmailResponse.text();
          throw new Error(errorText || 'Failed to send route email');
        }

        await logEmailIntegrationUsage({
          success: true,
          startedAt: emailStartedAt,
          metadata: { call_count: uniqueRecipientEmails.length, recipient_count: uniqueRecipientEmails.length, date_range: dateRangeStr }
        });
      } catch (sendError) {
        await logEmailIntegrationUsage({
          success: false,
          startedAt: emailStartedAt,
          errorMessage: sendError?.message || 'Failed to send route email',
          metadata: { call_count: uniqueRecipientEmails.length, recipient_count: uniqueRecipientEmails.length, date_range: dateRangeStr }
        });
        return Response.json({ error: sendError?.message || 'Failed to send route email' });
      }

      return Response.json({ success: true, sent_to: uniqueRecipientEmails });
    }

    // Preview — return the single combined PDF
    return Response.json({ pdfBase64: combinedPdfBase64, fileName: combinedFileName });

  } catch (error) {
    return Response.json({ error: error?.message || 'Server error' }, { status: 500 });
  }
});