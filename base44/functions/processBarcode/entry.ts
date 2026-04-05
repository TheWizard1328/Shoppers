import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { barcodeValue, snapshotBase64 } = await req.json();
    const callerAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }).catch(() => []);
    const appUser = callerAppUsers?.[0] || null;

    const logIntegrationUsage = async ({ operationName, feature, startedAt, success, errorMessage = null, metadata = {}, estimatedCreditsUsed = 1 }) => {
      try {
        await base44.asServiceRole.entities.IntegrationUsageLog.create({
          timestamp: new Date(startedAt).toISOString(),
          integration_name: 'Core',
          operation_name: operationName,
          feature,
          app_user_id: appUser?.id || null,
          app_user_name: appUser?.user_name || user.full_name || null,
          auth_user_id: user.id,
          duration_ms: Date.now() - startedAt,
          success,
          estimated_credits_used: estimatedCreditsUsed,
          error_message: errorMessage,
          metadata
        });
      } catch (trackingError) {
        console.warn('[processBarcode] Tracking failed:', trackingError?.message || trackingError);
      }
    };

    const runTrackedIntegration = async ({ operationName, feature, metadata = {}, estimatedCreditsUsed = 1, call }) => {
      const startedAt = Date.now();
      try {
        const result = await call();
        await logIntegrationUsage({ operationName, feature, startedAt, success: true, metadata, estimatedCreditsUsed });
        return result;
      } catch (error) {
        await logIntegrationUsage({ operationName, feature, startedAt, success: false, errorMessage: error?.message || 'Unknown error', metadata, estimatedCreditsUsed });
        throw error;
      }
    };

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

        const uploadResult = await runTrackedIntegration({
          operationName: 'UploadFile',
          feature: 'barcode_snapshot_upload',
          metadata: { source: 'processBarcode', has_snapshot: true },
          call: () => base44.integrations.Core.UploadFile({ file })
        });
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
        const llmResult = await runTrackedIntegration({
          operationName: 'InvokeLLM',
          feature: 'barcode_snapshot_verification',
          metadata: { source: 'processBarcode', barcode_value: barcodeValue, model: 'automatic', file_count: 1 },
          call: () => base44.integrations.Core.InvokeLLM({
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
          })
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