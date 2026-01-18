import { base44 } from '@/api/base44Client';
import { format, subDays } from 'date-fns';

/**
 * Daily message cleanup utility
 * Deletes messages older than 7 days, runs once per day
 * Uses AppSettings to track cleanup across all users/sessions
 */

const LOCAL_CLEANUP_KEY = 'last_message_cleanup_check';
const APP_SETTINGS_KEY = 'message_cleanup_tracker';

/**
 * Check if cleanup was already performed today (server-side check via AppSettings)
 */
async function wasCleanupPerformedToday() {
  try {
    const settings = await base44.entities.AppSettings.filter({ setting_key: APP_SETTINGS_KEY });
    if (settings && settings.length > 0) {
      const lastCleanupDate = settings[0].setting_value?.last_cleanup_date;
      const today = format(new Date(), 'yyyy-MM-dd');
      return lastCleanupDate === today;
    }
    return false;
  } catch (error) {
    console.warn('[messageCleaner] Failed to check AppSettings:', error.message);
    return false;
  }
}

/**
 * Mark cleanup as performed in AppSettings
 */
async function markCleanupPerformed() {
  try {
    const today = format(new Date(), 'yyyy-MM-dd');
    const settings = await base44.entities.AppSettings.filter({ setting_key: APP_SETTINGS_KEY });
    
    if (settings && settings.length > 0) {
      await base44.entities.AppSettings.update(settings[0].id, {
        setting_value: { last_cleanup_date: today }
      });
    } else {
      await base44.entities.AppSettings.create({
        setting_key: APP_SETTINGS_KEY,
        setting_value: { last_cleanup_date: today },
        description: 'Tracks daily message cleanup to prevent multiple runs'
      });
    }
  } catch (error) {
    console.warn('[messageCleaner] Failed to update AppSettings:', error.message);
  }
}

/**
 * Check if cleanup is needed and perform it
 * Only deletes messages older than 7 days
 */
export async function performDailyMessageCleanup() {
  try {
    const today = format(new Date(), 'yyyy-MM-dd');
    
    // Quick local check first to avoid unnecessary API calls
    const localLastCheck = localStorage.getItem(LOCAL_CLEANUP_KEY);
    if (localLastCheck === today) {
      console.log('ℹ️ [messageCleaner] Already checked today (local)');
      return;
    }

    // Mark that we've checked today locally
    localStorage.setItem(LOCAL_CLEANUP_KEY, today);

    // Server-side check - was cleanup already performed by another user/session today?
    const alreadyPerformed = await wasCleanupPerformedToday();
    if (alreadyPerformed) {
      console.log('ℹ️ [messageCleaner] Cleanup already performed today by another session');
      return;
    }

    console.log('🧹 [messageCleaner] Starting daily message cleanup (messages older than 7 days)...');

    // Calculate cutoff date (7 days ago)
    const cutoffDate = subDays(new Date(), 7);
    const cutoffDateStr = format(cutoffDate, 'yyyy-MM-dd');

    // Get all messages
    const allMessages = await base44.entities.Message.list();
    
    if (!allMessages || allMessages.length === 0) {
      console.log('ℹ️ [messageCleaner] No messages to process');
      await markCleanupPerformed();
      return;
    }

    // Filter to only old messages
    const oldMessages = allMessages.filter(msg => {
      if (!msg.created_date) return false;
      const msgDate = format(new Date(msg.created_date), 'yyyy-MM-dd');
      return msgDate < cutoffDateStr;
    });

    if (oldMessages.length === 0) {
      console.log('ℹ️ [messageCleaner] No old messages to delete');
      await markCleanupPerformed();
      return;
    }

    console.log(`🗑️ [messageCleaner] Deleting ${oldMessages.length} messages older than 7 days...`);

    // Delete old messages with minimal delay
    let deleted = 0;
    let failed = 0;

    for (const message of oldMessages) {
      try {
        await base44.entities.Message.delete(message.id);
        deleted++;
        await new Promise(resolve => setTimeout(resolve, 100)); // Delay to prevent rate limits
      } catch (error) {
        console.warn(`Failed to delete message ${message.id}:`, error.message);
        failed++;
      }
    }

    console.log(`✅ [messageCleaner] Daily cleanup complete: ${deleted} deleted, ${failed} failed`);
    await markCleanupPerformed();

  } catch (error) {
    console.error('❌ [messageCleaner] Cleanup failed:', error);
  }
}

/**
 * Initialize daily cleanup - call this once during app startup
 */
export function initializeDailyCleanup() {
  // Run initial check after 30 seconds (delayed to allow app to fully load)
  setTimeout(() => {
    performDailyMessageCleanup();
  }, 30000);

  // Check every 6 hours if cleanup is needed (much less frequent)
  setInterval(() => {
    performDailyMessageCleanup();
  }, 21600000); // 6 hours
}