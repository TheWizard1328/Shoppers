// Suppress the benign "ResizeObserver loop completed with undelivered
// notifications" warning. This is a harmless browser-level notice fired when
// a ResizeObserver callback triggers a layout change that generates a further
// notification in the same frame. Chrome treats it as non-fatal and the spec
// explicitly allows it. It does not break any functionality, but it pollutes
// error logs and surfaces as a scary error in the UI. Intercept and swallow it
// at the source before any handler or remote logger sees it.
const RO_MSG = 'ResizeObserver loop completed with undelivered notifications';

window.addEventListener('error', (event) => {
  if (event && typeof event.message === 'string' && event.message.indexOf(RO_MSG) !== -1) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }
}, { capture: true });

window.addEventListener('unhandledrejection', (event) => {
  const msg = String((event && event.reason && event.reason.message) || (event && event.reason) || '');
  if (msg.indexOf(RO_MSG) !== -1) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }
}, { capture: true });

export {};