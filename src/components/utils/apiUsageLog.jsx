export const getApiLogCallCount = (log) => {
  const provider = getApiLogProvider(log);
  const rawCount = Number(log?.metadata?.call_count ?? log?.metadata?.api_calls ?? 1);

  if (provider === 'here') {
    return rawCount > 0 ? 1 : 0;
  }

  return Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 1;
};

export const getApiLogProvider = (log) => {
  const explicitProvider = String(log?.metadata?.api_provider || '').toLowerCase();
  if (explicitProvider === 'google' || explicitProvider === 'here') return explicitProvider;

  if (String(log?.api_type || '').includes('(HERE)')) return 'here';
  return 'google';
};

export const getApiLogCategory = (log) => {
  const apiType = String(log?.api_type || '');
  if (apiType === 'Map Tiles (HERE)') return 'here_tiles';
  if (getApiLogProvider(log) === 'here') return 'here_routing';
  return 'google';
};

export const getApiLogNormalizedType = (log) => {
  const apiType = String(log?.api_type || 'Unknown');
  return apiType.replace(' (HERE)', '');
};

export const getApiLogDisplayType = (log) => {
  const provider = getApiLogProvider(log);
  const normalizedType = getApiLogNormalizedType(log);
  return `${provider === 'here' ? 'HERE' : 'Google'} ${normalizedType}`;
};

export const sumApiLogCalls = (logs = [], predicate = null) => {
  return (logs || []).reduce((total, log) => {
    if (predicate && !predicate(log)) return total;
    return total + getApiLogCallCount(log);
  }, 0);
};