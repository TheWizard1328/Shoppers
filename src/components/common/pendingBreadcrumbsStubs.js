// pendingBreadcrumbsManager removed — breadcrumbs managed via
// locationBreadcrumbService / offlineDB directly. These no-op stubs are kept
// for the call sites in stopCardStartActions / stopCardCompletionActions
// (extracted from useStopCardActions.jsx, Sep 6 2026).
export const clearPendingBreadcrumbsForDelivery = async () => {};
export const getPendingBreadcrumbsForDelivery = async () => null;
