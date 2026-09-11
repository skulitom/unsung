// @ts-check
/**
 * `unsung serve` (DESIGN §9.1, §10.1): start the explorer on 127.0.0.1 — the same as `npm start`.
 * The store and `addRepo` are loaded when they have landed; without the store the explorer still
 * shows the examples. Ctrl-C stops the server cleanly.
 */

import { spawn } from 'node:child_process';
import { startServer } from '../../server.mjs';
import { ArgsError } from './args.mjs';

/** @typedef {import('./context.mjs').Ctx} Ctx */
/** @typedef {import('./args.mjs').ParsedArgs} ParsedArgs */

/**
 * Open the explorer in the default browser, without a shell (§16). Only a `http://127.0.0.1:<port>/`
 * address is ever opened.
 * @param {string} url
 * @param {{platform?: string, spawnFn?: typeof spawn, log?: {warn: (msg: string) => void}}} [opts]
 * @returns {boolean} whether a browser was asked to open it
 */
export function openBrowser(url, { platform = process.platform, spawnFn = spawn, log } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url)) return false;
  /** @type {[string, string[]]} */
  const [cmd, args] = platform === 'win32' ? ['explorer.exe', [url]]
    : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawnFn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
    child.on?.('error', (/** @type {Error} */ err) => log?.warn(`Could not open a browser: ${err.message}`));
    child.unref?.();
    return true;
  } catch (err) {
    log?.warn(`Could not open a browser: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * `addRepo` from src/pipeline/add.mjs, or null while that module (or one it needs) has not landed.
 * @param {Ctx} ctx
 * @returns {Promise<Function | null>}
 */
async function loadAddRepo(ctx) {
  try {
    const mod = await import('../pipeline/add.mjs');
    return typeof mod.addRepo === 'function' ? mod.addRepo : null;
  } catch (err) {
    if (/** @type {{code?: string}} */ (err)?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    ctx.log.debug('Adding repositories is not yet available', { reason: /** @type {Error} */ (err).message });
    return null;
  }
}

export const command = {
  name: 'serve',
  summary: 'Start the local explorer',
  flags: {
    port: { type: 'number', arg: 'N', summary: 'port on 127.0.0.1 (default 8750, from defaults.json)' },
    open: { type: 'boolean', summary: 'open the explorer in your browser' },
  },

  /**
   * @param {ParsedArgs} args
   * @param {Ctx} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const port = args.flags.port ?? ctx.config.defaults.server.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new ArgsError(`--port expects a whole number from 0 to 65535, got '${String(port)}'`);
    }
    let warned = false;
    const openStore = async () => {
      try {
        return await ctx.store();
      } catch (err) {
        if (/** @type {{code?: string}} */ (err)?.code !== 'ENOTAVAILABLE') throw err;
        if (!warned) ctx.log.warn('The store is not available yet: the explorer shows the examples only.');
        warned = true;
        return null;
      }
    };
    const addRepo = await loadAddRepo(ctx);
    const { server, url, close } = await startServer({
      dataDir: ctx.dataDir, config: ctx.config, openStore, addRepo, getClient: () => ctx.client(),
      now: ctx.now, log: ctx.log, port,
    });
    ctx.print(`Unsung explorer: ${url}`);
    ctx.print('Press Ctrl-C to stop.');
    if (args.flags.open) openBrowser(url, { log: ctx.log });
    await new Promise((resolve) => {
      if (ctx.signal.aborted) resolve(undefined);
      ctx.signal.addEventListener('abort', () => resolve(undefined), { once: true });
      server.once('close', () => resolve(undefined));
    });
    await close();
    return 0;
  },
};
