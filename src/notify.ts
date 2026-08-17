import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID } from './config.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'
import { markIfTestRun } from './test-run-marker.js'

export async function notifyChannel(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !CHANNEL_CHAT_ID) {
    logger.warn('Channel ertesites kihagyva: token vagy chat ID hianyzik')
    return
  }

  // Marked here at the funnel, NOT at call sites -- a new caller must not be
  // able to leak an unmarked message from a test run.
  const outbound = markIfTestRun(text)
  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(outbound)
  const chunks = provider.splitMessage(formatted)

  for (const chunk of chunks) {
    try {
      const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
      await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, chunk, parseMode)
    } catch {
      try {
        // Fallback: re-split the failing chunk through the provider's own
        // splitMessage. Each provider's splitMessage uses its own limit
        // constant (telegram 4096, slack 4000, discord 2000, googlechat
        // 4096, teams 28000), so this respects the provider's actual API
        // limit without expanding the ChannelProvider interface.
        const fallback = provider.splitMessage(chunk)[0]
        await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, fallback)
      } catch { /* last resort, give up */ }
    }
  }
}

// Backward-compatible alias
export const notifyTelegram = notifyChannel

// Security-event notification (break-glass password reset, security:reset).
// Unlike notifyChannel, a missing channel config is an EXPECTED state here
// (fresh installs, channel-less deployments), so it stays fully silent -- the
// recovery path must never depend on, or be noisy about, Telegram being wired.
export async function notifySecurityEvent(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !CHANNEL_CHAT_ID) return
  try {
    await notifyChannel(text)
  } catch {
    /* never let a notification failure break the recovery action itself */
  }
}
