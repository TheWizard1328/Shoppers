import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const DEFAULT_CONFIG = {
  enabled: true,
  threshold_credits: 10,
  window_minutes: 15,
  recipient_name: 'Robert T'
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const settings = await base44.asServiceRole.entities.AppSettings.filter({
      setting_key: 'integration_credit_monitor'
    });

    const config = {
      ...DEFAULT_CONFIG,
      ...(settings?.[0]?.setting_value || {})
    };

    if (!config.enabled) {
      return Response.json({ success: true, alertSent: false, reason: 'monitor_disabled' });
    }

    const windowMinutes = Number(config.window_minutes) || DEFAULT_CONFIG.window_minutes;
    const thresholdCredits = Number(config.threshold_credits) || DEFAULT_CONFIG.threshold_credits;
    const cutoff = Date.now() - windowMinutes * 60 * 1000;

    const recentLogs = await base44.asServiceRole.entities.IntegrationUsageLog.list('-timestamp', 500);
    const matchingLogs = (recentLogs || []).filter((log) => {
      const ts = new Date(log.timestamp || log.created_date || 0).getTime();
      return ts >= cutoff;
    });

    const totalCredits = matchingLogs.reduce((sum, log) => sum + Number(log.estimated_credits_used || 0), 0);

    if (totalCredits < thresholdCredits) {
      return Response.json({
        success: true,
        alertSent: false,
        thresholdCredits,
        totalCredits,
        windowMinutes
      });
    }

    const owners = await base44.asServiceRole.entities.AppUser.filter({
      user_name: config.recipient_name || DEFAULT_CONFIG.recipient_name
    }).catch((error) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });
    const owner = owners?.[0];

    if (!owner?.user_id) {
      return Response.json({ success: false, alertSent: false, reason: 'recipient_not_found' }, { status: 404 });
    }

    const bucketKey = Math.floor(Date.now() / (windowMinutes * 60 * 1000));
    const bucketToken = `[credit-alert:${windowMinutes}:${thresholdCredits}:${bucketKey}]`;
    const conversationId = ['system_updates', owner.user_id].sort().join('_');

    const recentMessages = await base44.asServiceRole.entities.Message.filter(
      {
        receiver_id: owner.user_id,
        conversation_id: conversationId
      },
      '-created_date',
      20
    ).catch((error) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });

    const alreadySent = (recentMessages || []).some((message) =>
      typeof message.content === 'string' && message.content.includes(bucketToken)
    );

    if (alreadySent) {
      return Response.json({
        success: true,
        alertSent: false,
        reason: 'already_sent_for_bucket',
        totalCredits,
        thresholdCredits,
        windowMinutes
      });
    }

    const featureTotals = matchingLogs.reduce((acc, log) => {
      const key = log.feature || log.operation_name || 'Unknown task';
      acc[key] = (acc[key] || 0) + Number(log.estimated_credits_used || 0);
      return acc;
    }, {});

    const topTasks = Object.entries(featureTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([task, credits]) => `${task}: ${credits}`)
      .join(' | ');

    const content = `${bucketToken} Estimated integration usage reached ${totalCredits} credits within ${windowMinutes} minutes. Top tasks: ${topTasks || 'n/a'}.`;

    const message = await base44.asServiceRole.entities.Message.create({

      sender_id: 'system_updates',
      sender_name: 'System Updates',
      receiver_id: owner.user_id,
      receiver_name: owner.user_name || config.recipient_name,
      conversation_id: conversationId,
      content,
      read: false
    });

    return Response.json({
      success: true,
      alertSent: true,
      totalCredits,
      thresholdCredits,
      windowMinutes,
      messageId: message.id
    });
  } catch (error) {
    console.error('checkIntegrationUsageAlerts failed:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});