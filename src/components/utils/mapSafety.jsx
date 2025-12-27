// This utility provides safe fallbacks for any remaining map functionality
// It prevents the application from crashing if Leaflet is referenced anywhere

export const safeMapOperation = (operation) => {
  try {
    return operation();
  } catch (error) {
    console.warn("Map operation failed safely:", error);
    return null;
  }
};

export const DisabledMapPlaceholder = ({ height = "400px", message = "Map temporarily disabled" }) => {
  return (
    <div 
      className="bg-slate-100 rounded-lg border border-slate-200 flex items-center justify-center"
      style={{ height }}
    >
      <div className="text-center text-slate-500">
        <div className="w-12 h-12 mx-auto mb-4 bg-slate-200 rounded-full flex items-center justify-center">
          <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <p className="text-lg font-medium mb-2">Map Temporarily Disabled</p>
        <p className="text-sm">{message}</p>
      </div>
    </div>
  );
};

// Safe wrapper for any map components
export const SafeMapWrapper = ({ children, fallback }) => {
  try {
    return children;
  } catch (error) {
    console.warn("Map component failed, showing fallback:", error);
    return fallback || <DisabledMapPlaceholder />;
  }
};