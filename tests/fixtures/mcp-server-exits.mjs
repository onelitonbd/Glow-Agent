#!/usr/bin/env node
// A fixture MCP server that is "gone": it exits the moment it is started, without speaking MCP.
//
// The test that uses it first connects the plugin against the healthy fixture, then creates the
// marker file below, which represents the server disappearing between connecting and the next
// message. The stored settings still point at an MCP server and the plugin is still flagged
// connected, so this is the case the app has to survive without breaking the reply.
import { existsSync } from 'node:fs';
import { DIED_MARKER, handleRequest } from './mcp-server.mjs';

if (existsSync(DIED_MARKER)) process.exit(1);

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
    const response = handleRequest(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));
