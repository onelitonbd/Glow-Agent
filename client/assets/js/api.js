const API_ROOT = '/api/v1';

export class ApiError extends Error {
  constructor(message, { code = 'REQUEST_FAILED', status = 0, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });
  if (response.status === 204) return null;
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('The server returned an invalid response.', { status: response.status });
  }
  if (!response.ok) {
    throw new ApiError(payload?.error?.message || 'The request could not be completed.', {
      code: payload?.error?.code,
      status: response.status,
      requestId: payload?.error?.requestId
    });
  }
  return payload.data;
}

export const api = {
  health: () => request('/health'),
  tools: { list: () => request('/tools') },
  providers: {
    list: () => request('/providers'),
    get: (id) => request(`/providers/${encodeURIComponent(id)}`),
    create: (values) => request('/providers', { method: 'POST', body: values }),
    update: (id, values) => request(`/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: values }),
    remove: (id) => request(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    fetchModels: (id) => request(`/providers/${encodeURIComponent(id)}/fetch-models`, { method: 'POST' }),
    selectedModels: (id) => request(`/providers/${encodeURIComponent(id)}/models`),
    addSelectedModel: (id, modelId) => request(`/providers/${encodeURIComponent(id)}/models`, { method: 'POST', body: { modelId } }),
    removeSelectedModel: (id, modelId) => request(`/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' })
  },
  skills: {
    list: () => request('/skills'),
    get: (id) => request(`/skills/${encodeURIComponent(id)}`),
    create: (values) => request('/skills', { method: 'POST', body: values }),
    update: (id, values) => request(`/skills/${encodeURIComponent(id)}`, { method: 'PUT', body: values }),
    remove: (id) => request(`/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  conversations: {
    list: () => request('/conversations'),
    create: (title) => request('/conversations', { method: 'POST', body: title ? { title } : {} }),
    get: (id) => request(`/conversations/${encodeURIComponent(id)}`),
    respond: (id, values) => request(`/conversations/${encodeURIComponent(id)}/respond`, { method: 'POST', body: values })
  }
};
