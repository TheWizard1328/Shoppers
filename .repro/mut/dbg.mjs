const { offlineDB, __CALLS } = await import('./odb.mjs');
const { processPendingMutationsInternal } = await import('./proc.mjs');
offlineDB.__seed([{ mutationId: 'm1', entity: 'Delivery', recordId: 'd1', operation: 'update', payload: { status: 'in_transit' }, retryCount: 0, notBefore: 0 }]);
const res = await processPendingMutationsInternal();
console.log('RES:', JSON.stringify(res));
console.log('CALLS:', JSON.stringify(__CALLS));
