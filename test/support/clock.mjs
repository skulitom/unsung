// @ts-check
/**
 * A fake clock for tests (DESIGN §12.1): time moves only when a test says so. Pass it wherever a
 * module takes `{clock}`; it has the same `now()`, `ms()` and `sleep()` as the real one.
 *
 * - `advance(ms)` jumps at once and wakes every sleeper that has become due, earliest first.
 * - `advanceAsync(ms)` steps from deadline to deadline and lets woken code run (and sleep again)
 *   before moving on, so loops of sleeps behave as they would in real time.
 * - With `{auto: true}` every sleep completes by itself: the clock jumps to the earliest pending
 *   deadline on the next macrotask. Code under test then runs in virtual time without any help.
 *
 * This file is a helper: `node --test` loads it, and it only exports functions.
 */

/**
 * @typedef {object} FakeClock
 * @property {() => string} now current fake time, ISO-8601 UTC
 * @property {() => number} ms current fake time in milliseconds since the epoch
 * @property {(ms: number) => number} advance move forward now; returns the new time in ms
 * @property {(ms: number) => Promise<number>} advanceAsync move forward in steps; resolves to the new time
 * @property {(ms: number, opts?: {signal?: AbortSignal}) => Promise<void>} sleep resolves when the
 *   fake time reaches now + ms
 * @property {(iso: string | number) => number} set jump forward to an absolute time
 * @property {() => number} pending number of sleepers still waiting
 */

/**
 * @typedef {object} Timer
 * @property {number} at
 * @property {number} seq
 * @property {() => void} resolve
 * @property {() => void} cleanup
 */

/** @returns {Error} */
function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** @returns {Promise<void>} */
function macrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Create a fake clock starting at `startIso`.
 * @param {string | number} [startIso] default `2026-09-11T00:00:00Z`
 * @param {{auto?: boolean}} [opts]
 * @returns {FakeClock}
 */
export function fakeClock(startIso = '2026-09-11T00:00:00Z', { auto = false } = {}) {
  let t = typeof startIso === 'number' ? startIso : Date.parse(startIso);
  if (!Number.isFinite(t)) throw new RangeError(`Not a valid start time: ${String(startIso)}`);
  let seq = 0;
  /** @type {Timer[]} */
  const timers = [];
  let autoScheduled = false;

  const sortTimers = () => timers.sort((a, b) => a.at - b.at || a.seq - b.seq);

  /** @param {Timer} timer */
  const fire = (timer) => {
    timer.cleanup();
    timer.resolve();
  };

  const scheduleAuto = () => {
    if (!auto || autoScheduled) return;
    autoScheduled = true;
    setImmediate(() => {
      autoScheduled = false;
      sortTimers();
      const next = timers.shift();
      if (!next) return;
      t = Math.max(t, next.at);
      fire(next);
      if (timers.length > 0) scheduleAuto();
    });
  };

  /**
   * @param {number} ms
   * @returns {number}
   */
  const checkStep = (ms) => {
    const step = Number(ms);
    if (!Number.isFinite(step) || step < 0) throw new RangeError('The fake clock only moves forward');
    return step;
  };

  /** @type {FakeClock} */
  const clock = {
    now: () => new Date(t).toISOString(),
    ms: () => t,
    advance(ms) {
      const target = t + checkStep(ms);
      sortTimers();
      while (timers.length > 0 && timers[0].at <= target) {
        const timer = /** @type {Timer} */ (timers.shift());
        t = Math.max(t, timer.at);
        fire(timer);
      }
      t = target;
      return t;
    },
    async advanceAsync(ms) {
      const target = t + checkStep(ms);
      await macrotask();
      for (;;) {
        sortTimers();
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        t = Math.max(t, next.at);
        fire(next);
        await macrotask();
      }
      t = Math.max(t, target);
      return t;
    },
    sleep(ms, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? abortError());
          return;
        }
        const delay = Math.max(0, Number(ms) || 0);
        if (delay === 0) {
          resolve();
          return;
        }
        /** @type {Timer} */
        const timer = { at: t + delay, seq: seq++, resolve, cleanup: () => {} };
        if (signal) {
          const onAbort = () => {
            const i = timers.indexOf(timer);
            if (i >= 0) timers.splice(i, 1);
            reject(signal.reason ?? abortError());
          };
          signal.addEventListener('abort', onAbort, { once: true });
          timer.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
        timers.push(timer);
        scheduleAuto();
      });
    },
    set(iso) {
      const target = typeof iso === 'number' ? iso : Date.parse(iso);
      if (!Number.isFinite(target)) throw new RangeError(`Not a valid time: ${String(iso)}`);
      return clock.advance(checkStep(target - t));
    },
    pending: () => timers.length,
  };
  return clock;
}
