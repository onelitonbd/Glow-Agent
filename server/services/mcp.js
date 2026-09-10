import { spawn } from 'node:child_process';
import { AppError } from '../lib/errors.js';

// Minimal, dependency-free MCP (Model Context Protocol) client.
//
// MCP is JSON-RPC 2.0. The lifecycle is: `initialize` request -> server result ->
// `notifications/initialized` notification -> normal operation (`tools/list`, `tools/call`).
// Two standard transports exist:
//   * stdio          - the client spawns the server as a subprocess and exchanges
//                      newline-delimited JSON-RPC over stdin/stdout.
//   * Streamable HTTP - every JSON-RPC message is its own HTTP POST to one MCP endpoint;
//                      the reply is either a single JSON object or a request-scoped
//                      Server-Sent Events stream that ends with the final response.
// Over HTTP the client must send `Accept: application/json, text/event-stream`, echo the
// negotiated protocol version in `MCP-Protocol-Version`, and echo any `Mcp-Session-Id`
// the server issued. Both response shapes are supported below.
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'glow-agent', title: 'Glow Agent', version: '0.1.0' };
const MAX_STDERR = 4096;

function rpcError(message, { code = 'MCP_ERROR', status = 502 } = {}) {
  return new AppError(status, code, message, { expose: true });
}

// Parses an SSE stream incrementally and hands each `data:` payload to onMessage. Resolves
// as soon as onMessage returns true (the final response arrived) so the stream can be closed
// early, which matters because some servers keep the response stream open.
async function readSse(body, onMessage) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Normalising CRLF on the whole buffer is safe even when a "\r\n" pair is split
      // across chunks: the stray "\r" is fixed on the next append.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/gu, '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /u, ''))
          .join('\n');
        if (data && onMessage(data) === true) return true;
        separator = buffer.indexOf('\n\n');
      }
    }
    return false;
  } finally {
    reader.releaseLock();
  }
}

class HttpTransport {
  constructor({ url, headers = {}, fetchTimeoutMs }) {
    this.url = url;
    this.headers = headers;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.sessionId = '';
    this.protocolVersion = '';
  }

  // Owns the request deadline so the abort timer is always cleared, whatever happens.
  async send(message, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      return await this.exchange(message, options, controller.signal);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError') throw rpcError(`The MCP server did not respond within ${Math.round(this.fetchTimeoutMs / 1000)}s.`, { code: 'MCP_TIMEOUT' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async exchange(message, { expectResponse = true } = {}, signal) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers
    };
    // The protocol version header is only sent once the version has been negotiated, and the
    // session id only once the server has issued one.
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'The MCP server did not respond in time.' : `The MCP server at ${this.url} could not be reached (${error?.message || 'network error'}).`;
      throw rpcError(reason, { code: 'MCP_UNREACHABLE' });
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (!expectResponse) {
      await response.body?.cancel?.().catch(() => {});
      if (response.status >= 400) throw rpcError(`The MCP server rejected the notification (HTTP ${response.status}).`, { code: 'MCP_REQUEST_FAILED' });
      return null;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isEventStream = contentType.includes('text/event-stream');
    const text = isEventStream ? '' : await response.text();
    if (response.status >= 400) {
      // Servers may answer an HTTP error with a JSON-RPC error body; prefer that message.
      const detail = isEventStream ? `HTTP ${response.status}` : (safeJson(text)?.error?.message || text.slice(0, 300) || `HTTP ${response.status}`);
      await response.body?.cancel?.().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? 'MCP_UNAUTHORIZED' : 'MCP_REQUEST_FAILED';
      const status = response.status === 401 || response.status === 403 ? 401 : 502;
      throw rpcError(`MCP server error: ${detail}`, { code, status });
    }

    if (isEventStream) {
      // Read the event stream incrementally and stop at the final response: the stream is
      // request-scoped, but not every server closes it promptly once it has answered.
      let result = null;
      await readSse(response.body, (payload) => {
        const parsed = safeJson(payload);
        if (!parsed) return false;
        if (parsed.id === message.id) { result = parsed; return true; }
        return false; // notifications on the stream are ignored
      });
      await response.body?.cancel?.().catch(() => {});
      if (!result) throw rpcError('The MCP server closed its event stream without answering the request.', { code: 'MCP_REQUEST_FAILED' });
      return result;
    }

    const parsed = safeJson(text);
    if (!parsed) throw rpcError('The MCP server returned a response that is not valid JSON-RPC.', { code: 'MCP_REQUEST_FAILED' });
    return parsed;
  }

  async close() {}
}

class StdioTransport {
  constructor({ command, args = [], env = {}, fetchTimeoutMs }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.process = null;
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    this.exited = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.command, this.args, {
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch (error) {
        reject(rpcError(`Could not start the MCP server "${this.command}": ${error.message}`, { code: 'MCP_SPAWN_FAILED' }));
        return;
      }
      this.process = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.dispatch(line);
          newline = buffer.indexOf('\n');
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
      });
      child.on('error', (error) => {
        const reason = error.code === 'ENOENT'
          ? `The MCP server command "${this.command}" was not found. Install it or use the remote HTTP server instead.`
          : `Could not start the MCP server "${this.command}": ${error.message}`;
        this.failAll(rpcError(reason, { code: 'MCP_SPAWN_FAILED' }));
        reject(rpcError(reason, { code: 'MCP_SPAWN_FAILED' }));
      });
      child.on('exit', (code, signal) => {
        this.exited = { code, signal };
        this.closed = true;
        this.failAll(rpcError(`The MCP server exited (${signal || `code ${code}`}): ${this.stderr.trim().slice(-300) || 'no stderr output'}`, { code: 'MCP_SERVER_EXITED' }));
      });
      // Give the process a moment to report a spawn error before the first request goes out.
      setImmediate(() => { if (!this.exited) resolve(); });
    });
  }

  dispatch(line) {
    const message = safeJson(line);
    if (!message || message.id === undefined || message.id === null) return;
    const waiter = this.pending.get(String(message.id));
    if (!waiter) return;
    this.pending.delete(String(message.id));
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  failAll(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  async send(message, { expectResponse = true } = {}) {
    if (!this.process) await this.start();
    if (this.closed) throw rpcError(`The MCP server has exited: ${this.stderr.trim().slice(-300) || 'no stderr output'}`, { code: 'MCP_SERVER_EXITED' });
    const payload = `${JSON.stringify(message)}\n`;
    if (!expectResponse) {
      this.process.stdin.write(payload);
      return null;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(message.id));
        reject(rpcError(`The MCP server did not answer "${message.method}" within ${Math.round(this.fetchTimeoutMs / 1000)}s.`, { code: 'MCP_TIMEOUT' }));
      }, this.fetchTimeoutMs);
      this.pending.set(String(message.id), { resolve, reject, timer });
      this.process.stdin.write(payload, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(String(message.id));
        reject(rpcError(`Could not write to the MCP server: ${error.message}`, { code: 'MCP_WRITE_FAILED' }));
      });
    });
  }

  async close() {
    const child = this.process;
    if (!child || this.closed) return;
    this.closed = true;
    try { child.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    });
  }
}

function safeJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Flattens an MCP tool result into plain text the model can read. Tool results are a list of
// content blocks (text, image, embedded resource); only text is meaningful for a chat model.
export function mcpResultToText(result, maxChars = 60_000) {
  const parts = [];
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'image') parts.push('[image content omitted]');
    else if (block?.type === 'audio') parts.push('[audio content omitted]');
    else if (block?.type === 'resource' || block?.type === 'resource_link') {
      const embedded = block?.resource;
      if (typeof embedded?.text === 'string') parts.push(embedded.text);
      else if (embedded?.uri) parts.push(`[resource ${embedded.uri}]`);
      else if (block?.uri) parts.push(`[resource ${block.uri}]`);
    }
  }
  if (result?.structuredContent !== undefined && parts.length === 0) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = parts.join('\n').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} characters]`;
}

// One live MCP session. Created per request, reused across every tool round in that request,
// and always closed afterwards so no subprocess or socket is left behind.
export class McpClient {
  constructor(options = {}) {
    this.options = options;
    this.requestId = 0;
    this.transport = options.transport === 'stdio'
      ? new StdioTransport(options)
      : new HttpTransport(options);
    this.serverInfo = null;
    this.protocolVersion = '';
    this.capabilities = {};
    this.instructions = '';
    this.connected = false;
  }

  nextId() {
    this.requestId += 1;
    return this.requestId;
  }

  async request(method, params, { expectResponse = true, timeoutMs } = {}) {
    const timeout = timeoutMs || this.options.fetchTimeoutMs || 60_000;
    const transport = this.transport;
    if (transport instanceof HttpTransport) transport.fetchTimeoutMs = timeout;
    const message = expectResponse
      ? { jsonrpc: '2.0', id: this.nextId(), method, ...(params ? { params } : {}) }
      : { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    const reply = await transport.send(message, { expectResponse });
    if (!expectResponse) return null;
    if (reply?.error) {
      throw rpcError(`MCP "${method}" failed: ${reply.error.message || 'unknown error'} (code ${reply.error.code ?? 'n/a'})`, { code: 'MCP_TOOL_FAILED' });
    }
    return reply?.result ?? null;
  }

  // Runs the MCP handshake. The server answers with the protocol version it supports; if that
  // differs from the one we asked for we adopt it and keep going.
  async connect({ timeoutMs = 20_000 } = {}) {
    if (this.connected) return this.serverInfo;
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    }, { timeoutMs });
    if (!result || typeof result !== 'object') throw rpcError('The MCP server answered the handshake with no result.', { code: 'MCP_HANDSHAKE_FAILED' });
    this.protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION;
    this.serverInfo = { name: result.serverInfo?.name || '', version: result.serverInfo?.version || '', title: result.serverInfo?.title || '' };
    this.capabilities = result.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {};
    this.instructions = typeof result.instructions === 'string' ? result.instructions : '';
    if (this.transport instanceof HttpTransport) this.transport.protocolVersion = this.protocolVersion;
    await this.request('notifications/initialized', {}, { expectResponse: false });
    this.connected = true;
    return this.serverInfo;
  }

  async listTools() {
    const tools = [];
    let cursor;
    // tools/list is paginated with an opaque cursor; follow it to the end.
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      const batch = Array.isArray(result?.tools) ? result.tools : [];
      for (const tool of batch) {
        if (typeof tool?.name === 'string') tools.push(tool);
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : '';
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name, args = {}, { timeoutMs } = {}) {
    return this.request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, { timeoutMs });
  }

  async close() {
    try {
      await this.transport.close();
    } catch {
      // Closing is best effort; a broken transport must not fail the request.
    }
    this.connected = false;
  }
}

// Builds the client options for a stored plugin config, expanding the GitHub preset into a
// concrete HTTP or stdio server definition.
export function mcpServerOptions(config = {}) {
  const transport = config.transport === 'stdio' ? 'stdio' : 'http';
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 90_000;
  if (transport === 'stdio') {
    const command = typeof config.command === 'string' ? config.command.trim() : '';
    if (!command) throw rpcError('This MCP plugin needs a command to start.', { code: 'MCP_CONFIG_INVALID', status: 400 });
    return {
      transport,
      command,
      args: Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === 'string') : [],
      env: stringMap(config.env),
      fetchTimeoutMs: timeoutMs
    };
  }
  const url = typeof config.url === 'string' ? config.url.trim() : '';
  if (!url) throw rpcError('This MCP plugin needs a server URL.', { code: 'MCP_CONFIG_INVALID', status: 400 });
  return { transport, url, headers: stringMap(config.headers), fetchTimeoutMs: timeoutMs };
}

function stringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof key === 'string' && typeof item === 'string') out[key] = item;
  }
  return out;
}

// Opens a session, runs `body(client)`, and always closes the session again.
export async function withMcpClient(options, body, { connectTimeoutMs } = {}) {
  const client = new McpClient(options);
  try {
    await client.connect({ timeoutMs: connectTimeoutMs });
    return await body(client);
  } finally {
    await client.close();
  }
}
