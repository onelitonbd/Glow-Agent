// A real MCP server used by the tests. It implements the JSON-RPC methods the client actually
// speaks (initialize, notifications/initialized, tools/list with pagination, tools/call) so both
// transports are exercised against a genuine server rather than a stub.
//
// Run directly as a stdio server:  node tests/fixtures/mcp-server.mjs
export const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'read_thing',
    description: 'Read one thing by id.',
    annotations: { readOnlyHint: true },
    // `missing` is deliberately not a declared property: providers reject that, so the client
    // must strip it while sanitising the schema.
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The thing id.' },
        depth: { type: 'integer', description: 'How deep to go.', default: 1 }
      },
      required: ['id', 'missing']
    }
  },
  {
    name: 'write_thing',
    description: 'Change one thing.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } }, required: ['id', 'value'] }
  },
  {
    name: 'delete_thing',
    description: 'Delete one thing. Publishes no annotations, so the name decides.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'describe_server',
    description: 'Return a fixed description.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'explode',
    description: 'Always fails, to test error propagation.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} }
  }
];

const PAGE_ONE = TOOLS.slice(0, 3);
const PAGE_TWO = TOOLS.slice(3);

// Handles one JSON-RPC request and returns the response message, or null for a notification.
export function handleRequest(message) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });

  if (method === 'initialize') {
    return reply({
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fixture-mcp', version: '1.2.3' },
      instructions: 'A fixture server for tests.'
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    if (params?.cursor === 'page-2') return reply({ tools: PAGE_TWO });
    return reply({ tools: PAGE_ONE, nextCursor: 'page-2' });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!TOOLS.some((tool) => tool.name === name)) return fail(-32602, `Unknown tool ${name}`);
    if (name === 'explode') return reply({ content: [{ type: 'text', text: 'The thing exploded.' }], isError: true });
    if (name === 'describe_server') {
      return reply({ content: [{ type: 'text', text: 'fixture-mcp 1.2.3' }] });
    }
    if (name === 'write_thing') {
      return reply({
        content: [{ type: 'text', text: `wrote ${args.id}` }],
        structuredContent: { id: args.id, value: args.value }
      });
    }
    return reply({ content: [{ type: 'text', text: JSON.stringify({ tool: name, args }) }] });
  }
  return fail(-32601, `Method not found: ${method}`);
}

// stdio entrypoint: newline-delimited JSON-RPC on stdin/stdout, diagnostics on stderr.
import { pathToFileURL } from 'node:url';
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stderr.write('fixture mcp server ready\n');
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
      const response = handleRequest(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
