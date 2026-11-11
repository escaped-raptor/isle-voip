// Starts whichever is needed: the first-run setup page (no config file yet)
// or the voice server. Used by `npm start` and by the server desktop app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';
import { startSetup } from './setup.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * onState is told where things are: { mode: 'setup' | 'running' | 'error', localUrl, message }.
 * Paths come from the ISLE_VOIP_CONFIG and ISLE_VOIP_DATA environment
 * variables when set (the desktop app sets both), else the server folder.
 */
export async function run({ onState = () => {}, log = console.log } = {}) {
  const configFile = process.env.ISLE_VOIP_CONFIG || path.join(root, 'config.json');
  const dataDir = process.env.ISLE_VOIP_DATA || null;

  const serve = async (config) => {
    try {
      const server = await startServer(dataDir ? { ...config, dataDir } : config, { log });
      const scheme = (config.tls?.cert && config.tls?.key) || config.tls?.auto?.agreedToTerms ? 'https' : 'http';
      onState({ mode: 'running', localUrl: `${scheme}://localhost:${server.port}/admin/`, port: server.port });
      return server;
    } catch (err) {
      const message = err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use by another program.` : err.message;
      onState({ mode: 'error', message, configFile });
      throw new Error(message);
    }
  };

  if (!fs.existsSync(configFile)) {
    const setup = await startSetup({
      configFile,
      dataDir: dataDir || path.resolve(root, './data'),
      log,
      onDone: (config) => serve(config).catch((err) => log(`Could not start: ${err.message}`))
    });
    onState({ mode: 'setup', localUrl: setup.url });
    return;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    const message = `The settings file is not valid JSON: ${err.message}`;
    onState({ mode: 'error', message, configFile });
    throw new Error(message);
  }
  return serve(config);
}
