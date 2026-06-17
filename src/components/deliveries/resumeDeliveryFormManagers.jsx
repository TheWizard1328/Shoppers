export async function resumeDeliveryFormManagers() {
  const { smartRefreshManager } = await import('../utils/smartRefreshManager');
  const { driverLocationPoller } = await import('../utils/driverLocationPoller');
  const { routePolylineManager } = await import('../utils/routePolylineManager');
  const { fabControlEvents } = await import('../utils/fabControlEvents');

  smartRefreshManager.resume();
  driverLocationPoller.resume();
  routePolylineManager?.resume?.();
  fabControlEvents.resumeFAB();
}