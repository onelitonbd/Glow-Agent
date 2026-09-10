#!/usr/bin/env node
// A fixture that answers like the GitHub MCP server does for the two calls this app makes on its
// own: `get_me` (to resolve the account) and `search_repositories` (to list and auto-pick a
// repository). Used to test the plugin's account and repository handling without GitHub.
import { handleRequest as handleReference, PROTOCOL_VERSION } from './mcp-server.mjs';

const ACCOUNT = { login: 'octocat', name: 'The Octocat', avatar_url: 'https://example.test/octocat.png' };
const REPOSITORIES = [
  { full_name: 'octocat/widgets', name: 'widgets', private: false, default_branch: 'main', updated_at: '2026-08-30T10:00:00Z', html_url: 'https://example.test/octocat/widgets', language: 'JavaScript', stargazers_count: 12 },
  { full_name: 'octocat/gizmos', name: 'gizmos', private: true, default_branch: 'trunk', updated_at: '2026-09-01T10:00:00Z', html_url: 'https://example.test/octocat/gizmos', language: 'Go', stargazers_count: 3 }
];

const TOOLS = [
  { name: 'get_me', description: 'The signed in user.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  {
    name: 'search_repositories',
    description: 'Search repositories.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  }
];

function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'github-mcp-fixture', version: '9.9.9' },
        instructions: 'A fixture that behaves like the GitHub MCP server.'
      }
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const text = (value) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
    if (params?.name === 'get_me') return text(ACCOUNT);
    if (params?.name === 'search_repositories') {
      // The app asks for the most recently updated repository first; honour that so the test
      // proves the ordering rather than the fixture's array order.
      const order = params?.arguments?.order === 'asc' ? 1 : -1;
      const items = [...REPOSITORIES].sort((a, b) => (a.updated_at < b.updated_at ? -order : order));
      const limit = Number(params?.arguments?.per_page) || items.length;
      return text({ total_count: items.length, incomplete_results: false, items: items.slice(0, limit) });
    }
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } };
  }
  if (method === 'notifications/initialized') return null;
  return handleReference(message);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const response = handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));
