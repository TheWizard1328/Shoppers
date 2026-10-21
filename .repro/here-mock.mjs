// canned HERE responses: findsequence2 + router v8
globalThis.fetch = async (url) => {
  if (url.includes('findsequence2')) {
    return { ok: true, json: async () => ({ results: [{ waypoints: [
      { id: 'driverStart', lat: 53.5461, lng: -113.4938 },
      { id: 'S1', lat: 53.5400, lng: -113.4900 },
      { id: 'S2', lat: 53.5600, lng: -113.5100 },
    ] }] }) };
  }
  if (url.includes('router.hereapi.com')) {
    return { ok: true, json: async () => ({ routes: [{ sections: [
      { polyline: 'CgoCAOIDvwIA', summary: { duration: 300, length: 4000 } },
      { polyline: 'CgoCAOIDvwIA', summary: { duration: 400, length: 5000 } },
    ] }] }) };
  }
  return { ok: true, json: async () => ({}) };
};
