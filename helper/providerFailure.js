import {
  ProviderError,
  ProviderAuthError,
  ProviderRateLimitError,
} from '@lerna-labs/ekklesia-helpers/cardano';

export const PROVIDER_UNAVAILABLE_MESSAGE =
  'The chain data service is temporarily unavailable. Please try again shortly.';

// Fixed tag so a log search or log-based alert rule can match it.
export const PROVIDER_CREDENTIAL_ALERT_TAG = 'ALERT:PROVIDER_CREDENTIAL_REJECTED';

/**
 * Answers a chain data provider failure with 503 and a fixed message.
 * Returns true when the error was a provider failure and the response was sent;
 * returns false for any other error so the caller keeps its own handling.
 * The provider message goes to the server log only, never to the client.
 */
export function respondToProviderFailure(res, error, context) {
  if (!(error instanceof ProviderError)) return false;

  if (error instanceof ProviderAuthError) {
    console.error(
      `[${PROVIDER_CREDENTIAL_ALERT_TAG}] ${context}: provider rejected credentials (${error.provider}, status ${error.status}): ${error.message}`,
    );
  } else if (error instanceof ProviderRateLimitError) {
    console.warn(
      `${context}: provider throttled the request (${error.provider}, status ${error.status}): ${error.message}`,
    );
    const seconds = error.retryAfterSeconds;
    if (Number.isFinite(seconds) && seconds >= 0) {
      res.set('Retry-After', String(Math.ceil(seconds)));
    }
  } else {
    console.error(`${context}: provider failure (${error.provider}): ${error.message}`);
  }

  res.status(503).json({ status: 'error', message: PROVIDER_UNAVAILABLE_MESSAGE });
  return true;
}
