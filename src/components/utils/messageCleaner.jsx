import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

/**
 * Daily message cleanup utility
 * Deletes all messages from the Message entity once per day
 */

const CLEANUP_KEY = 'last_message_cleanup_date';

/**
 * Check if cleanup is needed and perform it
 */
export async function performDailyMessageCleanup() {
  try {
    const today = format(new Date(), 'yyyy-MM-dd');
    const lastCleanup = localStorage.getItem(CLEANUP_KEY);

    if (lastCleanup === today) {
      console.log('ℹ️ [messageCleaner] Messages already cleaned today');
      return;
    }

    console.log('🧹 [messageCleaner] Starting daily message cleanup...');

    // Get all messages
    const allMessages = await base44.entities.Message.list();
    
    if (!allMessages || allMessages.length === 0) {
      console.log('ℹ️ [messageCleaner] No messages to delete');
      localStorage.setItem(CLEANUP_KEY, today);
      return;
    }

    console.log(`🗑️ [messageCleaner] Deleting ${allMessages.length} messages...`);

    // Delete all messages with minimal delay
    let deleted = 0;
    let failed = 0;

    for (const message of allMessages) {
      try {
        await base44.entities.Message.delete(message.id);
        deleted++;
        await new Promise(resolve => setTimeout(resolve, 50)); // Small delay to prevent rate limits
      } catch (error) {
        console.error(`Failed to delete message ${message.id}:`, error);
        failed++;
      }
    }

    console.log(`✅ [messageCleaner] Daily cleanup complete: ${deleted} deleted, ${failed} failed`);
    localStorage.setItem(CLEANUP_KEY, today);

  } catch (error) {
    console.error('❌ [messageCleaner] Cleanup failed:', error);
  }
}

/**
 * Initialize daily cleanup - call this once during app startup
 */
export function initializeDailyCleanup() {
  // Run initial check after 5 seconds
  setTimeout(() => {
    performDailyMessageCleanup();
  }, 5000);

  // Check every hour if cleanup is needed
  setInterval(() => {
    performDailyMessageCleanup();
  }, 3600000); // 1 hour
}