const { offlineDB, __CALLS } = await import('./odb.mjs');
const { processPendingMutationsInternal } = await import('./proc.mjs');
for (let cycle = 1; cycle <= 4; cycle++) {
  offlineDB.__seed([{ mutationId: 'm1', entity: 'Delivery', recordId: 'd1', operation: 'update', payload: { status: 'in_transit' }, retryCount: cycle - 1, notBefore: 0 }]);
  await processPendingMutationsInternal();
  console.log('cycle', cycle, '->', JSON.stringify(__CALLS.map(c => c[0] === 'retry' ? ['retry', c[2]] : c)));
  __CALLS.length = 0;
}
