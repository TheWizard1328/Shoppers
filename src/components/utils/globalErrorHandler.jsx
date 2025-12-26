// Global error handler - DISABLED
// Errors should bubble up naturally so they can be fixed

// Create a safe wrapper for any potentially problematic code (kept for compatibility)
export const safeExecute = (fn, fallback = null) => {
  try {
    return fn();
  } catch (error) {
    throw error;
  }
};

console.log('Global error handler disabled - errors will bubble up naturally');