/**
 * Slack Incoming Webhook notification
 *
 * Sends a text message to a Slack channel via Incoming Webhook.
 * Activated only when TAKT_NOTIFY_WEBHOOK environment variable is set.
 */

const WEBHOOK_ENV_KEY = 'TAKT_NOTIFY_WEBHOOK';
const TIMEOUT_MS = 10_000;

/**
 * Send a notification message to Slack via Incoming Webhook.
 *
 * Never throws: errors are written to stderr so the caller's flow is not disrupted.
 */
export async function sendSlackNotification(webhookUrl: string, message: string): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      process.stderr.write(
        `Slack webhook failed: HTTP ${String(response.status)} ${response.statusText}\n`,
      );
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Slack webhook error: ${detail}\n`);
  }
}

/**
 * Read the Slack webhook URL from the environment.
 *
 * @returns The webhook URL, or undefined if the environment variable is not set.
 */
export function getSlackWebhookUrl(): string | undefined {
  return process.env[WEBHOOK_ENV_KEY];
}
