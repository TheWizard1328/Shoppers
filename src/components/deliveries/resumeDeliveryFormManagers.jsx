export async function resumeDeliveryFormManagers() {
  await Promise.allSettled([
    import('../utils/smartRefreshManager').then(({ smartRefreshManager }) => smartRefreshManager.resume()),
    import('../utils/driverLocationPoller').then(({ driverLocationPoller }) => driverLocationPoller.resume()),
    import('../utils/routePolylineManager').then(({ routePolylineManager }) => routePolylineManager?.resume?.()),
    import('../utils/fabControlEvents').then(({ fabControlEvents }) => fabControlEvents.resumeFAB()),
  ]);
}