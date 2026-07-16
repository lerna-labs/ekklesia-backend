// Helper for HTTP calls that may take many minutes to return.
//
// Node's native `fetch` uses undici under the hood and enforces its own
// `headersTimeout` (default 300_000 ms = 5 min) and `bodyTimeout` that
// are INDEPENDENT of the AbortController/signal you pass. For long-
// running Hydra lifecycle operations (waitForHeadOpen 10m,
// waitForHeadClose 15m, fanout) those defaults fire early and throw
// `UND_ERR_HEADERS_TIMEOUT` regardless of how you configure your abort.
//
// Use `longFetch(url, init, { timeoutMs })` for any call that might
// legitimately take longer than 5 minutes. Internally it attaches a
// per-request undici Agent whose header/body timeouts match `timeoutMs`.

import { Agent } from 'undici';

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ timeoutMs?: number }} [opts]
 *   timeoutMs — both AbortController timeout and undici headers/body timeout
 */
export async function longFetch(url, init = {}, { timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: timeoutMs,
  });
  try {
    return await fetch(url, {
      ...init,
      signal: init.signal || controller.signal,
      dispatcher,
    });
  } finally {
    clearTimeout(timer);
    dispatcher.close().catch(() => {
      /* ignore */
    });
  }
}
