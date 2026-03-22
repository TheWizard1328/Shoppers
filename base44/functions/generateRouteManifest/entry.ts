import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { jsPDF } from 'npm:jspdf@2.5.2';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { driverId, deliveryDate, manifestType, ampm, storeIds, selectedCityId, recipientEmails, emailSubject } = body || {};
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

    if (!deliveryDate || !manifestType || (!driverId && (!Array.isArray(storeIds) || storeIds.length === 0))) {
      return Response.json({ error: 'Missing parameters' }, { status: 400 });
    }

    const deliveries = await base44.entities.Delivery.filter({
      delivery_date: deliveryDate
    });

    const finished = ['completed','failed','cancelled','returned'];
    let items = (deliveries || []).filter(Boolean);
    const creatorIds = [...new Set(items.map((item) => item?.created_by_app_user_id).filter(Boolean))];
    const creatorAppUsers = creatorIds.length > 0
      ? await base44.asServiceRole.entities.AppUser.filter({ id: { $in: creatorIds } })
      : [];
    const creatorNameMap = new Map((creatorAppUsers || []).map((appUser) => [appUser.id, appUser.user_name || appUser.id]));
    const driverIds = [...new Set(items.map((item) => item?.driver_id).filter(Boolean))];
    const driverAppUsers = driverIds.length > 0
      ? await base44.asServiceRole.entities.AppUser.filter({ user_id: { $in: driverIds } })
      : [];
    const driverNameMap = new Map((driverAppUsers || []).map((appUser) => [appUser.user_id, appUser.user_name || appUser.full_name || appUser.user_id]));

    let effectiveStoreIds = Array.isArray(storeIds) ? storeIds : null;
    if (selectedCityId && effectiveStoreIds) {
      const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: selectedCityId });
      effectiveStoreIds = (cityStores || []).filter((store) => effectiveStoreIds.includes(store.id)).map((store) => store.id);
    }

    if (driverId) {
      items = items.filter((d) => d?.driver_id === driverId);
    }

    if (effectiveStoreIds) {
      items = items.filter((d) => d?.store_id && effectiveStoreIds.includes(d.store_id));
    }

    if (manifestType === 'pre-route') {
      const period = ampm === 'PM' ? 'PM' : 'AM';
      items = items.filter((d) => d?.ampm_deliveries === period && !finished.includes(d?.status));
      items.sort((a, b) => {
        const driverA = driverNameMap.get(a?.driver_id) || a?.driver_name || a?.driver_id || '';
        const driverB = driverNameMap.get(b?.driver_id) || b?.driver_name || b?.driver_id || '';
        if (!driverId) {
          const driverCompare = driverA.localeCompare(driverB);
          if (driverCompare !== 0) return driverCompare;
        }
        const soA = a?.stop_order ?? 9999;
        const soB = b?.stop_order ?? 9999;
        if (soA !== soB) return soA - soB;
        const tA = a?.delivery_time_start || '99:99';
        const tB = b?.delivery_time_start || '99:99';
        return tA.localeCompare(tB);
      });
    } else {
      items.sort((a, b) => {
        const deliveredA = a?.actual_delivery_time || a?.arrival_time || a?.updated_date || '';
        const deliveredB = b?.actual_delivery_time || b?.arrival_time || b?.updated_date || '';
        if (deliveredA && deliveredB) {
          const deliveredCompare = deliveredA.localeCompare(deliveredB);
          if (deliveredCompare !== 0) return deliveredCompare;
        } else if (deliveredA || deliveredB) {
          return deliveredA ? -1 : 1;
        }
        const driverA = driverNameMap.get(a?.driver_id) || a?.driver_name || a?.driver_id || '';
        const driverB = driverNameMap.get(b?.driver_id) || b?.driver_name || b?.driver_id || '';
        const driverCompare = driverA.localeCompare(driverB);
        if (driverCompare !== 0) return driverCompare;
        const soA = a?.stop_order ?? 9999;
        const soB = b?.stop_order ?? 9999;
        return soA - soB;
      });
    }

    const patientIds = [...new Set(items.map((item) => item?.patient_id).filter(Boolean))];
    const manifestPatients = patientIds.length > 0
      ? await base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } })
      : [];
    const patientNameMap = new Map((manifestPatients || []).map((patient) => [patient.id, patient.full_name || patient.patient_id || patient.id]));

    const manifestStoreIds = [...new Set(items.map((item) => item?.store_id).filter(Boolean))];
    const manifestStores = manifestStoreIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: manifestStoreIds } })
      : [];
    const storeNameMap = new Map((manifestStores || []).map((store) => [store.id, store.name || store.abbreviation || store.id]));

    // Helper: extract just HH:MM time from various time formats
    function extractTime(timeStr) {
      if (!timeStr) return '';
      // Handle ISO format "YYYY-MM-DDTHH:MM:SS" or "YYYY-MM-DDTHH:MM"
      if (timeStr.includes('T')) {
        const timePart = timeStr.split('T')[1];
        if (timePart) {
          return timePart.substring(0, 5); // HH:MM
        }
      }
      // Handle "HH:MM:SS" or "HH:MM"
      if (/^\d{2}:\d{2}/.test(timeStr)) {
        return timeStr.substring(0, 5);
      }
      return timeStr;
    }

    // Helper: fetch image as base64 for embedding in PDF
    async function fetchImageAsBase64(url) {
      try {
        if (!url) return null;
        const response = await fetch(url);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const format = contentType.includes('png') ? 'PNG' : 'JPEG';
        return { base64Data: `data:${contentType};base64,${base64}`, format };
      } catch {
        return null;
      }
    }

    const encodeBase64Url = (value) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

    const uint8ToBase64 = (bytes) => {
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    };

    const buildGmailRawMessage = ({ to, subject, body, pdfBytes, fileName }) => {
      const boundary = `route_manifest_${crypto.randomUUID()}`;
      const pdfBase64 = uint8ToBase64(new Uint8Array(pdfBytes)).replace(/(.{76})/g, '$1\r\n');
      const mimeMessage = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
        '',
        body,
        '',
        `--${boundary}`,
        `Content-Type: application/pdf; name="${fileName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${fileName}"`,
        '',
        pdfBase64,
        '',
        `--${boundary}--`
      ].join('\r\n');

      return encodeBase64Url(mimeMessage);
    };

    // Pre-fetch all images (signatures and proof photos) in parallel
    const imagePromises = items.map(async (d) => {
      const result = { signature: null, photos: [] };
      if (d?.signature_image_url) {
        result.signature = await fetchImageAsBase64(d.signature_image_url);
      }
      if (d?.proof_photo_urls && Array.isArray(d.proof_photo_urls)) {
        // Limit to first 3 photos to keep PDF manageable
        const photoUrls = d.proof_photo_urls.slice(0, 3);
        const photoResults = await Promise.all(photoUrls.map(url => fetchImageAsBase64(url)));
        result.photos = photoResults.filter(Boolean);
      }
      return result;
    });

    const allImages = await Promise.all(imagePromises);
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const thumbSize = 12; // thumbnail size in mm
    const rightGap = 3; // spacing between right-side thumbnail columns (mm)

    // Alignment helpers
    doc.setLineWidth(0.2);
    doc.setLineHeightFactor(1.2);
    const snap = (n) => Math.round(n * 2) / 2;

    // Row sizing
    const minRowHeight = 6; // mm, ensures consistent spacing for single-line rows
    const cellPadding = 1;  // mm, extra breathing room inside each row
    const textTopOffset = 0.5; // mm, small offset so text doesn't touch the top line

    // Header
    const title = manifestType === 'pre-route' ? `Pre-Route (${ampm || 'AM'})` : 'Post-Route (All)';
    doc.setFontSize(16);
    doc.text(`Route Manifest - ${title}`, 14, 18);
    doc.setFontSize(11);
    doc.text(`Driver: ${driverId || 'All Drivers'}    Date: ${deliveryDate}`, 14, 26);

    let y = 36;

    // Column positions (Stop, TR#, Time, Name/Store, Driver, Created By, Notes, Receipts, Rx, Sig, Photos)
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
      // Draw header line
      y = snap(y + 1);
      doc.setDrawColor(180);
      doc.line(colStop, y, pageWidth - 10, y);
      y = snap(y + 4);
    };

    addHeader();

    function drawCountCell(x, y, count) {
      try {
        doc.setFontSize(9);
        doc.text(String(count), x + thumbSize / 2, y + 4.5, { align: 'center' });
      } catch {}
    }

    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      const images = allImages[i];

      // Calculate row height needed
      const isPickup = !d?.patient_id;
      const name = isPickup
        ? (storeNameMap.get(d?.store_id) || d?.delivery_notes || 'Store Pickup')
        : (patientNameMap.get(d?.patient_id) || d?.patient_name || '');
      const driverName = driverNameMap.get(d?.driver_id) || d?.driver_name || d?.driver_id || '';
      const createdBy = creatorNameMap.get(d?.created_by_app_user_id) || d?.created_by_app_user_id || '';
      const notes = d?.delivery_instructions || d?.delivery_notes || '';
      
      const nameWrapWidth = Math.max(20, colDriver - colName - 2);
      const driverWrapWidth = Math.max(18, colCreatedBy - colDriver - 2);
      const createdByWrapWidth = Math.max(16, colNotes - colCreatedBy - 2);
      const notesWrapWidth = Math.max(18, colReceipts - colNotes - 2);
      const nameLines = doc.splitTextToSize(name, nameWrapWidth);
      const driverLines = doc.splitTextToSize(driverName, driverWrapWidth);
      const createdByLines = doc.splitTextToSize(createdBy, createdByWrapWidth);
      const notesLines = doc.splitTextToSize(notes, notesWrapWidth);
      const nameDims = doc.getTextDimensions(nameLines);
      const driverDims = doc.getTextDimensions(driverLines);
      const createdByDims = doc.getTextDimensions(createdByLines);
      const notesDims = doc.getTextDimensions(notesLines);
      const textHeight = Math.max(nameDims.h, driverDims.h, createdByDims.h, notesDims.h) + cellPadding;

      const receiptsCount = Array.isArray(d?.receipt_barcode_values) ? d.receipt_barcode_values.length : 0;
      const rxCount = Array.isArray(d?.barcode_values) ? d.barcode_values.length : 0;
      const hasImages = images.signature || images.photos.length > 0 || receiptsCount > 0 || rxCount > 0;
      const rowHeight = hasImages ? Math.max(textHeight, thumbSize) : textHeight;

      // Check if we need a new page (use snapped coordinates)
      let rowTop = snap(y);
      const contentBottom = pageHeight - 20;
      if (rowTop + rowHeight > contentBottom) { 
        doc.addPage(); 
        y = 20; 
        addHeader(); 
        rowTop = snap(y);
      }

      const stop = String(d?.stop_order || '');
      const tr = String(d?.tracking_number || '');
      
      // Extract just HH:MM time
      const rawTime = d?.actual_delivery_time || d?.delivery_time_eta || d?.delivery_time_start || '';
      const time = extractTime(rawTime);

      doc.setFontSize(9);
      const rowBottom = snap(rowTop + Math.max(rowHeight, minRowHeight));
      const textY = rowTop + textTopOffset;
      
      // Highlight pickups with light gray background
      if (isPickup) {
        doc.setFillColor(245, 245, 245);
        doc.rect(colStop - 2, rowTop, pageWidth - 12, rowBottom - rowTop, 'F');
      }

      doc.text(stop, colStop, textY, { baseline: 'top' });
      doc.text(tr, colTR, textY, { baseline: 'top' });
      doc.text(time, colTime, textY, { baseline: 'top' });
      doc.text(nameLines, colName, textY, { baseline: 'top' });
      doc.text(driverLines, colDriver, textY, { baseline: 'top' });
      doc.text(createdByLines, colCreatedBy, textY, { baseline: 'top' });
      doc.text(notesLines, colNotes, textY, { baseline: 'top' });

      // Barcode counts
      drawCountCell(colReceipts, textY, receiptsCount);
      drawCountCell(colRx, textY, rxCount);

      // Signature thumbnail
      if (images.signature) {
        try {
          doc.addImage(images.signature.base64Data, images.signature.format, colSig, textY, thumbSize, thumbSize);
        } catch {
          // Fallback: draw a box with a check mark
          doc.setDrawColor(200);
          doc.rect(colSig, textY, thumbSize, thumbSize);
          doc.setFontSize(10);
          doc.text('✓', colSig + thumbSize / 2, textY + thumbSize / 2 + 3, { align: 'center' });
        }
      }

      // Proof photo thumbnails (pack leftwards to stay within right margin)
      if (images.photos.length > 0) {
        let photoX = colPhotos;
        for (let p = 0; p < images.photos.length; p++) {
          const photo = images.photos[p];
          try {
            doc.addImage(photo.base64Data, photo.format, photoX, textY, thumbSize, thumbSize);
            photoX -= (thumbSize + rightGap);
          } catch {
            // Fallback: draw empty box
            doc.setDrawColor(200);
            doc.rect(photoX, textY, thumbSize, thumbSize);
            photoX -= (thumbSize + rightGap);
          }
        }
      }

      // Draw subtle row separator aligned to grid
      y = rowBottom;
      doc.setDrawColor(230);
      doc.line(colStop, rowBottom, pageWidth - 10, rowBottom);
    }

    // Footer with count
    y = snap(y + 4);
    const footerBottom = pageHeight - 20;
    if (y > footerBottom) { doc.addPage(); y = 20; }
    doc.setFontSize(9);
    doc.text(`Total stops: ${items.length}`, 14, y);

    const pdfBytes = doc.output('arraybuffer');

    if (Array.isArray(recipientEmails) && recipientEmails.length > 0) {
      const uniqueRecipientEmails = [...new Set(recipientEmails.map((email) => typeof email === 'string' ? email.trim().toLowerCase() : '').filter(isValidEmail))];

      if (uniqueRecipientEmails.length === 0) {
        return Response.json({ error: 'No valid recipient emails were provided' });
      }

      const fileName = `${manifestType}${ampm ? `-${ampm}` : ''}-${deliveryDate}.pdf`;
      const { accessToken } = await base44.asServiceRole.connectors.getConnection('gmail');
      const subject = emailSubject || `Route logs for: ${driverId || 'All Drivers'} ${deliveryDate}`;
      const body = `Attached is your route manifest PDF for ${deliveryDate}.`;

      const emailStartedAt = Date.now();
      try {
        await Promise.all(uniqueRecipientEmails.map(async (email) => {
          const raw = buildGmailRawMessage({
            to: email,
            subject,
            body,
            pdfBytes,
            fileName,
          });

          const gmailResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ raw }),
          });

          if (!gmailResponse.ok) {
            const errorText = await gmailResponse.text();
            throw new Error(errorText || 'Failed to send route email');
          }
        }));

        await logEmailIntegrationUsage({
          success: true,
          startedAt: emailStartedAt,
          metadata: {
            call_count: uniqueRecipientEmails.length,
            recipient_count: uniqueRecipientEmails.length,
            manifest_type: manifestType,
            delivery_date: deliveryDate
          }
        });
      } catch (sendError) {
        await logEmailIntegrationUsage({
          success: false,
          startedAt: emailStartedAt,
          errorMessage: sendError?.message || 'Failed to send route email',
          metadata: {
            call_count: uniqueRecipientEmails.length,
            recipient_count: uniqueRecipientEmails.length,
            manifest_type: manifestType,
            delivery_date: deliveryDate
          }
        });
        return Response.json({ error: sendError?.message || 'Failed to send route email' });
      }

      return Response.json({ success: true, sent_to: uniqueRecipientEmails });
    }

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=${manifestType}-${deliveryDate}.pdf`
      }
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Server error' }, { status: 500 });
  }
});