// Slimmed: LLM extraction ONLY — patient matching is now client-side (IDB)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { base64Image, fileUrl } = body;

    if (!base64Image && !fileUrl) {
      return Response.json({ error: 'No image data provided' }, { status: 400 });
    }

    const imageSource = fileUrl || base64Image;
    let uploadedFileUrl = imageSource;

    // If base64, upload once to get a URL
    if (imageSource.startsWith('data:')) {
      try {
        const base64Data = imageSource.split(',')[1];
        const mimeType = imageSource.split(';')[0].split(':')[1] || 'image/jpeg';
        const byteCharacters = atob(base64Data);
        const byteArray = new Uint8Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) byteArray[i] = byteCharacters.charCodeAt(i);
        const blob = new Blob([byteArray], { type: mimeType });
        const file = new File([blob], 'prescription_label.jpg', { type: mimeType });
        const uploadResult = await base44.integrations.Core.UploadFile({ file });
        if (uploadResult?.file_url) uploadedFileUrl = uploadResult.file_url;
      } catch (uploadError) {
        console.warn('[scanPrescriptionLabel] Upload failed, using raw base64:', uploadError.message);
      }
    }

    // Single LLM call — tight JSON-only prompt
    console.log('[scanPrescriptionLabel] Running vision LLM extraction...');
    let extractionResult = null;

    try {
      const textResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `Extract from this prescription label. Return ONLY JSON, nothing else:
{"patient_name":"","street_address":"","city":"","state":"","zip_code":"","phone_number":""}`,
        file_urls: [uploadedFileUrl]
      });

      if (typeof textResponse === 'string' && textResponse.trim()) {
        const cleaned = textResponse.trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '');
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) extractionResult = JSON.parse(jsonMatch[0]);
      } else if (textResponse && typeof textResponse === 'object') {
        extractionResult = textResponse;
      }
    } catch (llmError) {
      console.error('[scanPrescriptionLabel] LLM failed:', llmError.message);
      return Response.json({
        error: 'Failed to extract data from image. Please ensure the label is clear and readable.',
        details: llmError.message
      }, { status: 400 });
    }

    if (!extractionResult || !extractionResult.patient_name) {
      return Response.json({
        error: 'Failed to extract data from image. Please ensure the label is clear and readable.',
        details: 'No patient name found'
      }, { status: 400 });
    }

    const extractedData = {
      patient_name: extractionResult.patient_name,
      street_address: extractionResult.street_address,
      city_state_zip: [extractionResult.city, extractionResult.state, extractionResult.zip_code].filter(Boolean).join(', '),
      phone_number: extractionResult.phone_number
    };

    console.log('[scanPrescriptionLabel] Extracted:', extractedData);

    // Return ONLY extracted data — client does matching against IDB
    return Response.json({ extractedData });

  } catch (error) {
    console.error('Error in scanPrescriptionLabel:', error);
    return Response.json({
      error: error.message || 'Internal server error'
    }, { status: 500 });
  }
});
