// Global error handler to catch and neutralize persistent Leaflet errors
// This prevents Leaflet errors from crashing the app

// Catch unhandled errors globally
window.addEventListener('error', function(event) {
  const message = event.message || '';
  
  // Check if this is a Leaflet error we should neutralize
  if (message.includes('l is not a function') || 
      message.includes('_leaflet_pos') ||
      message.includes('Leaflet') ||
      message.includes('Cannot read properties of undefined')) {
    console.warn('Leaflet error caught and neutralized:', message);
    event.preventDefault();
    return false;
  }
});

// Catch unhandled promise rejections
window.addEventListener('unhandledrejection', function(event) {
  if (event.reason && event.reason.message) {
    const message = event.reason.message;
    if (message.includes('l is not a function') || 
        message.includes('_leaflet_pos') ||
        message.includes('Leaflet')) {
      console.warn('Leaflet promise rejection caught and neutralized:', message);
      event.preventDefault();
      return false;
    }
  }
});

// Override console.error to catch and neutralize Leaflet errors
const originalConsoleError = console.error;
console.error = function(...args) {
  const message = args.join(' ');
  if (message.includes('l is not a function') || 
      message.includes('_leaflet_pos') ||
      message.includes('Leaflet')) {
    console.warn('Leaflet error intercepted and neutralized:', message);
    return;
  }
  originalConsoleError.apply(console, args);
};

// Create a safe wrapper for any potentially problematic code
export const safeExecute = (fn, fallback = null) => {
  try {
    return fn();
  } catch (error) {
    if (error.message && (error.message.includes('l is not a function') || 
                          error.message.includes('_leaflet_pos') ||
                          error.message.includes('Leaflet'))) {
      console.warn('Leaflet error caught in safeExecute, using fallback');
      return fallback;
    }
    throw error;
  }
};

console.log('Global Leaflet error handler initialized');