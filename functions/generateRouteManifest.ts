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
    const { driverId, deliveryDate, manifestType, ampm, storeIds } = body || {};

    if (!driverId || !deliveryDate || !manifestType) {
      return Response.json({ error: 'Missing parameters' }, { status: 400 });
    }

    const deliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    const finished = ['completed','failed','cancelled','returned'];
    let items = (deliveries || []).filter(Boolean);

    // CRITICAL: If storeIds provided (dispatcher export), filter to only those stores
    if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
      items = items.filter(d => d?.store_id && storeIds.includes(d.store_id));
    }

    if (manifestType === 'pre-route') {
      const period = ampm === 'PM' ? 'PM' : 'AM';
      items = items.filter(d => d?.ampm_deliveries === period && !finished.includes(d?.status));
      items.sort((a,b) => {
        const soA = a?.stop_order ?? 9999; const soB = b?.stop_order ?? 9999;
        if (soA !== soB) return soA - soB;
        const tA = a?.delivery_time_start || '99:99';
        const tB = b?.delivery_time_start || '99:99';
        return tA.localeCompare(tB);
      });
    } else {
      items.sort((a,b) => (a?.stop_order ?? 9999) - (b?.stop_order ?? 9999));
    }

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

    // Alignment helpers
    doc.setLineWidth(0.2);
    doc.setLineHeightFactor(1.2);
    const snap = (n: number) => Math.round(n * 2) / 2;

    // Row sizing
    const minRowHeight = 6; // mm, ensures consistent spacing for single-line rows
    const cellPadding = 1;  // mm, extra breathing room inside each row
    const textTopOffset = 0.5; // mm, small offset so text doesn't touch the top line

    // Header
    const title = manifestType === 'pre-route' ? `Pre-Route (${ampm || 'AM'})` : 'Post-Route (All)';
    doc.setFontSize(16);
    doc.text(`Route Manifest - ${title}`, 14, 18);
    doc.setFontSize(11);
    doc.text(`Driver: ${driverId}    Date: ${deliveryDate}`, 14, 26);

    let y = 36;

    // Column positions (Stop, TR#, Time, Name/Store, Notes, Receipts, Rx, Sig, Photos)
    const colStop = 12;
    const colTR = 26;
    const colTime = 42;
    const colName = 60;
    const rightMargin = pageWidth - 12;
    const colPhotos = rightMargin - thumbSize;
    const colSig = colPhotos - (thumbSize + 2);
    const colRx = colSig - (thumbSize + 2);
    const colReceipts = colRx - (thumbSize + 2);
    const colNotes = colReceipts - 48;

    const addHeader = () => {
      doc.setFontSize(9);
      doc.setFont(undefined, 'bold');
      doc.text('Stop', colStop, y);
      doc.text('TR#', colTR, y);
      doc.text('Time', colTime, y);
      doc.text('Name / Store', colName, y);
      doc.text('Notes', colNotes, y);
      doc.text('Receipts', colReceipts, y);
      doc.text('Rx', colRx, y);
      doc.text('Sig', colSig, y);
      doc.text('Photos', colPhotos, y);
      doc.setFont(undefined, 'normal');
      // Draw header line
      y = snap(y + 1);
      doc.setDrawColor(180);
      doc.line(colStop, y, pageWidth - 10, y);
      y = snap(y + 4);
    };

    addHeader();

    // Draw a small thumbnail with a count badge (for Receipts and Rx)
    function drawMiniThumb(x, y, label, count) {
      try {
        // base box
        doc.setDrawColor(200);
        doc.setFillColor(250, 250, 250);
        doc.rect(x, y, thumbSize, thumbSize, 'FD');
        // center label
        doc.setFontSize(7);
        const labelX = x + thumbSize / 2;
        const labelY = y + thumbSize / 2 + 2.2; // visual center tweak
        doc.text(label, labelX, labelY, { align: 'center' });
        // count badge
        const badgeW = Math.min(10, Math.max(7, (String(count).length + 1) * 2.5));
        const bx = x + thumbSize - badgeW - 0.5;
        const by = y + thumbSize - 4.5;
        doc.setFillColor(30);
        doc.rect(bx, by, badgeW, 4, 'F');
        doc.setTextColor(255);
        doc.setFontSize(6);
        doc.text(`x${count}`, bx + badgeW / 2, by + 3, { align: 'center' });
        doc.setTextColor(0);
      } catch {}
    }

    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      const images = allImages[i];

      // Calculate row height needed
      const isPickup = !d?.patient_id;
      const name = isPickup ? (d?.delivery_notes || 'Store Pickup') : (d?.patient_name || '');
      const notes = d?.delivery_instructions || d?.delivery_notes || '';
      
      const nameWrapWidth = Math.max(30, colNotes - colName - 2);
      const notesWrapWidth = Math.max(20, colReceipts - colNotes - 2);
      const nameLines = doc.splitTextToSize(name, nameWrapWidth);
      const notesLines = doc.splitTextToSize(notes, notesWrapWidth);
      const nameDims = doc.getTextDimensions(nameLines as any);
      const notesDims = doc.getTextDimensions(notesLines as any);
      const textHeight = Math.max(nameDims.h, notesDims.h) + cellPadding;

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

      doc.text(stop, colStop, textY, { baseline: 'top' } as any);
      doc.text(tr, colTR, textY, { baseline: 'top' } as any);
      doc.text(time, colTime, textY, { baseline: 'top' } as any);
      doc.text(nameLines, colName, textY, { baseline: 'top' } as any);
      doc.text(notesLines, colNotes, textY, { baseline: 'top' } as any);

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

      // Proof photo thumbnails
      if (images.photos.length > 0) {
        let photoX = colPhotos;
        for (const photo of images.photos) {
          try {
            doc.addImage(photo.base64Data, photo.format, photoX, textY, thumbSize, thumbSize);
            photoX += thumbSize + 1;
          } catch {
            // Skip failed images
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