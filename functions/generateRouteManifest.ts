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
    const { driverId, deliveryDate, manifestType, ampm } = body || {};

    if (!driverId || !deliveryDate || !manifestType) {
      return Response.json({ error: 'Missing parameters' }, { status: 400 });
    }

    const deliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    const finished = ['completed','failed','cancelled','returned'];
    let items = (deliveries || []).filter(Boolean);

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

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const thumbSize = 12; // thumbnail size in mm

    // Header
    const title = manifestType === 'pre-route' ? `Pre-Route (${ampm || 'AM'})` : 'Post-Route (All)';
    doc.setFontSize(16);
    doc.text(`Route Manifest - ${title}`, 14, 18);
    doc.setFontSize(11);
    doc.text(`Driver: ${driverId}    Date: ${deliveryDate}`, 14, 26);

    let y = 36;

    // Column positions (no Type column, added Sig + Photos)
    const colStop = 14;
    const colTR = 26;
    const colName = 40;
    const colTime = 108;
    const colNotes = 126;
    const colSig = 162;
    const colPhotos = 176;

    const addHeader = () => {
      doc.setFontSize(9);
      doc.setFont(undefined, 'bold');
      doc.text('Stop', colStop, y);
      doc.text('TR#', colTR, y);
      doc.text('Name / Store', colName, y);
      doc.text('Time', colTime, y);
      doc.text('Notes', colNotes, y);
      doc.text('Sig', colSig, y);
      doc.text('Photos', colPhotos, y);
      doc.setFont(undefined, 'normal');
      // Draw header line
      y += 1;
      doc.setDrawColor(180);
      doc.line(colStop, y, pageWidth - 10, y);
      y += 4;
    };

    addHeader();

    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      const images = allImages[i];

      // Calculate row height needed
      const isPickup = !d?.patient_id;
      const name = isPickup ? (d?.delivery_notes || 'Store Pickup') : (d?.patient_name || '');
      const notes = d?.delivery_instructions || d?.delivery_notes || '';
      
      const nameLines = doc.splitTextToSize(name, 64);
      const notesLines = doc.splitTextToSize(notes, 32);
      const textRows = Math.max(nameLines.length, notesLines.length);
      const textHeight = textRows * 4.5 + 2;
      
      const hasImages = images.signature || images.photos.length > 0;
      const rowHeight = hasImages ? Math.max(textHeight, thumbSize + 2) : textHeight;

      // Check if we need a new page
      if (y + rowHeight > 280) { 
        doc.addPage(); 
        y = 20; 
        addHeader(); 
      }

      const stop = String(d?.stop_order || '');
      const tr = String(d?.tracking_number || '');
      
      // Extract just HH:MM time
      const rawTime = d?.actual_delivery_time || d?.delivery_time_eta || d?.delivery_time_start || '';
      const time = extractTime(rawTime);

      doc.setFontSize(9);
      
      // Highlight pickups with light gray background
      if (isPickup) {
        doc.setFillColor(245, 245, 245);
        doc.rect(colStop - 2, y - 3.5, pageWidth - 12, rowHeight, 'F');
      }

      const rowTop = y;
      doc.text(stop, colStop, y);
      doc.text(tr, colTR, y);
      doc.text(nameLines, colName, y);
      doc.text(time, colTime, y);
      doc.text(notesLines, colNotes, y);

      // Signature thumbnail
      if (images.signature) {
        try {
          doc.addImage(images.signature.base64Data, images.signature.format, colSig, rowTop - 3, thumbSize, thumbSize);
        } catch {
          doc.setFontSize(7);
          doc.text('✓', colSig + 4, rowTop);
        }
      }

      // Proof photo thumbnails
      if (images.photos.length > 0) {
        let photoX = colPhotos;
        for (const photo of images.photos) {
          try {
            doc.addImage(photo.base64Data, photo.format, photoX, rowTop - 3, thumbSize, thumbSize);
            photoX += thumbSize + 1;
          } catch {
            // Skip failed images
          }
        }
      }

      // Draw subtle row separator
      y = rowTop + rowHeight;
      doc.setDrawColor(230);
      doc.line(colStop, y - 1, pageWidth - 10, y - 1);
    }

    // Footer with count
    y += 4;
    if (y > 280) { doc.addPage(); y = 20; }
    doc.setFontSize(9);
    doc.text(`Total stops: ${items.length}`, 14, y);

    const pdfBytes = doc.output('arraybuffer');

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=route-${manifestType}-${deliveryDate}.pdf`
      }
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Server error' }, { status: 500 });
  }
});