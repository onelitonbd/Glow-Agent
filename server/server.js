import { createApp } from './app.js';
import { loadConfig } from './lib/config.js';

const config = loadConfig();
const { app, close } = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.info(JSON.stringify({ event: 'started', host: config.host, port: config.port, databasePath: config.databasePath }));
});

function shutdown(signal) {
  console.info(JSON.stringify({ event: 'shutdown', signal }));
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
