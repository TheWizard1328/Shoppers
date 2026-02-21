import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { barcodeValue, snapshotBase64 } = await req.json();

    if (!barcodeValue) {
      return Response.json({ error: 'No barcode value provided' }, { status: 400 });
    }

    console.log(`📦 [processBarcode] Processing barcode: ${barcodeValue}`);

    let snapshotUrl = null;

    // Upload snapshot image if provided
    if (snapshotBase64) {
      try {
        const base64Data = snapshotBase64.split(',')[1];
        const mimeType = snapshotBase64.split(';')[0].split(':')[1] || 'image/jpeg';
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: mimeType });
        const file = new File([blob], `barcode_${barcodeValue}_${Date.now()}.jpg`, { type: mimeType });

        const uploadResult = await base44.integrations.Core.UploadFile({ file });
        if (uploadResult?.file_url) {
          snapshotUrl = uploadResult.file_url;
          console.log(`✅ [processBarcode] Snapshot uploaded: ${snapshotUrl}`);
        }
      } catch (uploadError) {
        console.error('⚠️ [processBarcode] Snapshot upload failed:', uploadError.message);
      }
    }

    // Use LLM to verify/read the barcode value from the image (optional validation)
    let verification = { valid: true, confidence: 'high', notes: null };
    if (snapshotUrl) {
      try {
        const llmResult = await base44.integrations.Core.InvokeLLM({
          prompt: `This is a snapshot of a barcode that was scanned. The scanner detected the value: "${barcodeValue}". 
Please look at the image and confirm:
1. Is there a visible barcode in the image?
2. Does the barcode appear to be Code 128 format?
3. Is the barcode clearly readable (not blurry or damaged)?
Return JSON only: {"barcode_visible": true/false, "code128_format": true/false, "clearly_readable": true/false, "notes": "any issues or null"}`,
          file_urls: [snapshotUrl],
          response_json_schema: {
            type: "object",
            properties: {
              barcode_visible: { type: "boolean" },
              code128_format: { type: "boolean" },
              clearly_readable: { type: "boolean" },
              notes: { type: "string" }
            }
          }
        });

        if (llmResult) {
          verification = {
            valid: llmResult.barcode_visible && llmResult.clearly_readable,
            confidence: llmResult.clearly_readable ? 'high' : 'low',
            notes: llmResult.notes || null
          };
          console.log(`🔍 [processBarcode] Verification result:`, verification);
        }
      } catch (llmError) {
        console.warn('⚠️ [processBarcode] LLM verification skipped:', llmError.message);
      }
    }

    console.log(`✅ [processBarcode] Done. Barcode: ${barcodeValue}, Snapshot: ${snapshotUrl ? 'uploaded' : 'none'}`);

    return Response.json({
      success: true,
      barcodeValue,
      snapshotUrl,
      verification
    });

  } catch (error) {
    console.error('Error in processBarcode:', error);
    return Response.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
});