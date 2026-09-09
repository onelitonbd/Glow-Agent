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

async function stream(path, body, onEvent) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    let payload;
    try { payload = await response.json(); } catch { /* A malformed response is handled below. */ }
    throw new ApiError(payload?.error?.message || 'The stream could not be started.', {
      code: payload?.error?.code,
      status: response.status,
      requestId: payload?.error?.requestId
    });
  }
  if (!response.body) throw new ApiError('The browser did not receive a readable streaming response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed;
  const dispatch = async (block) => {
    const lines = block.replace(/\r/g, '').split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch { throw new ApiError('The server sent an invalid stream event.'); }
    if (event === 'error') throw new ApiError(payload.message || 'The stream could not be completed.', { code: payload.code });
    await onEvent(event, payload);
    if (event === 'completed') completed = payload;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop();
      for (const block of blocks) await dispatch(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) await dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!completed) throw new ApiError('The provider stream ended before it completed.');
  return completed;
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
    respond: (id, values) => request(`/conversations/${encodeURIComponent(id)}/respond`, { method: 'POST', body: values }),
    streamRespond: (id, values, onEvent) => stream(`/conversations/${encodeURIComponent(id)}/respond/stream`, values, onEvent)
  }
};
