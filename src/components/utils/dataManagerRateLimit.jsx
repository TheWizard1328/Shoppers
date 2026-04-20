let lastApiCallTime = 0;
const MIN_API_INTERVAL = 10000;
let globalRateLimitUntil = 0;

export const waitForRateLimit = async () => {
  const now = Date.now();

  if (now < globalRateLimitUntil) {
    const waitTime = globalRateLimitUntil - now;
    console.warn(`⏸️ [DataManager] Global rate limit active - waiting ${Math.ceil(waitTime / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitTime, 1000)));
    return;
  }

  const timeSinceLastCall = now - lastApiCallTime;
  if (timeSinceLastCall < MIN_API_INTERVAL) {
    const waitTime = MIN_API_INTERVAL - timeSinceLastCall;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  lastApiCallTime = Date.now();
};

export const triggerGlobalRateLimitPause = () => {
  globalRateLimitUntil = Date.now() + 120000;
  console.warn('🛑 [DataManager] 429 Rate Limit - pausing all API calls for 2 minutes');
};