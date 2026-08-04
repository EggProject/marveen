// Summary step: renders the post-install boxen panel with the
// bootstrap URL, dashboard token, and the three next steps. The token
// is shown in plain text ONCE because the operator needs to paste it
// into the browser; the runtime keeps the only persistent copy in
// store/.dashboard-token (mode 0600).

import type { InstallerContext } from '../types.js'
import { banner } from '../ui/banner.js'
import { t } from '../locale/index.js'

export async function stepSummary(ctx: InstallerContext): Promise<void> {
  const url = `http://127.0.0.1:${ctx.webPort}`
  const lines = [
    t('summary.bootstrap-url', url),
    t('summary.token', ctx.dashboardToken || '(unset)'),
    '',
    t('summary.next-steps'),
    `  - ${t('summary.next-step.dashboard', url)}`,
    `  - ${t('summary.next-step.telegram')}`,
    `  - ${t('summary.next-step.update')}`,
  ]
  process.stdout.write(banner({ title: t('summary.title'), subtitle: lines.join('\n') }) + '\n')
}