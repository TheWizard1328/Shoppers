export const getIntegrationActor = async () => null;

export const buildIntegrationMetadata = (payload = {}, extra = {}) => {
  const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
  return {
    payload_keys: Object.keys(normalizedPayload),
    model: normalizedPayload.model || undefined,
    add_context_from_internet: normalizedPayload.add_context_from_internet === true,
    has_response_json_schema: !!normalizedPayload.response_json_schema,
    file_count: Array.isArray(normalizedPayload.file_urls)
      ? normalizedPayload.file_urls.length
      : normalizedPayload.file_urls ? 1 : 0,
    page_path: typeof window !== 'undefined' ? window.location.pathname : undefined,
    ...extra,
  };
};

export const withIntegrationTracking = async ({ call }) => call();