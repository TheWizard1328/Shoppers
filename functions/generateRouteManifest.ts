import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
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
      // post-route: include everything, keep route order
      items.sort((a,b) => (a?.stop_order ?? 9999) - (b?.stop_order ?? 9999));
    }

    const doc = new jsPDF();

    // Header
    const title = manifestType === 'pre-route' ? `Pre-Route (${ampm || 'AM'})` : 'Post-Route (All)';
    doc.setFontSize(16);
    doc.text(`Route Manifest - ${title}`, 14, 18);
    doc.setFontSize(11);
    doc.text(`Driver: ${driverId}    Date: ${deliveryDate}`, 14, 26);

    let y = 36;
    const addHeader = () => {
      doc.setFontSize(10);
      doc.text('Stop', 14, y);
      doc.text('TR#', 28, y);
      doc.text('Type', 44, y);
      doc.text('Name / Store', 64, y);
      doc.text('Time', 140, y);
      doc.text('Notes', 160, y);
      y += 6;
    };

    addHeader();

    for (const d of items) {
      if (y > 280) { doc.addPage(); y = 20; addHeader(); }
      const isPickup = !d?.patient_id;
      const stop = String(d?.stop_order || '');
      const tr = String(d?.tracking_number || '');
      const type = isPickup ? 'Pickup' : 'Delivery';
      const name = isPickup ? (d?.delivery_notes || 'Store Pickup') : (d?.patient_name || '');
      const time = d?.actual_delivery_time || d?.delivery_time_eta || d?.delivery_time_start || '';
      const notes = d?.delivery_instructions || d?.delivery_notes || '';

      doc.setFontSize(10);
      doc.text(stop, 14, y);
      doc.text(tr, 28, y);
      doc.text(type, 44, y);

      const nameLines = doc.splitTextToSize(name, 70);
      const beforeY = y;
      doc.text(nameLines, 64, y);

      doc.text(String(time), 140, beforeY);

      const notesLines = doc.splitTextToSize(notes, 50);
      doc.text(notesLines, 160, beforeY);

      const rows = Math.max(nameLines.length, notesLines.length);
      y = beforeY + rows * 5 + 2;
    }

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