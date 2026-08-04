// English locale strings for every user-visible installer message.
//
// Must have the EXACT same key set as hu.ts -- the locale-parity test
// gates on it. Translations stay 1:1 in shape: if hu.ts adds a key, en.ts
// must add the English text for the same key in the same position.

const en = {
  'cli.title': 'Marveen installer',
  'cli.subtitle': 'AI fleet management system',

  'install.steps.prereq': 'Checking prerequisites',
  'install.steps.bun': 'Installing bun',
  'install.steps.claude': 'Installing Claude Code',
  'install.steps.claude-auth': 'Claude authentication',
  'install.steps.personal': 'Personal info',
  'install.steps.dependencies': 'Installing dependencies',
  'install.steps.build': 'TypeScript build',
  'install.steps.provider': 'Provider selection',
  'install.steps.ollama': 'Ollama discovery',
  'install.steps.vault': 'Vault push',
  'install.steps.service': 'Installing system service',
  'install.steps.bumblebee': 'Bumblebee scheduled task',
  'install.steps.summary': 'Summary',

  'provider.choose': 'Select the model provider:',
  'provider.choices.anthropic': 'Anthropic Claude',
  'provider.choices.minimax': 'MiniMax',
  'provider.choices.deepseek': 'DeepSeek',
  'provider.choices.openrouter': 'OpenRouter',
  'provider.choices.ollama': 'Ollama (local)',
  'provider.choices.skip': 'Skip',

  'error.invalid-port': 'Invalid port: %s',
  'error.not-supported': 'Unsupported platform: %s',
  'error.branch-not-found': 'Marveen branch not found: %s',
  'error.unknown-provider': 'Unknown provider: %s',

  'provider.anthropic.api-key.prompt': 'ANTHROPIC_API_KEY (sk-ant-...):',
  'provider.anthropic.oauth.prompt': 'OAuth setup-token (sk-ant-oat01-...):',
  'provider.anthropic.method.prompt': 'Anthropic auth method:',
  'provider.anthropic.method.api-key': 'API key (sk-ant-...)',
  'provider.anthropic.method.oauth': 'OAuth setup-token',
  'provider.anthropic.method.skip': 'Skip',

  'provider.minimax.region.prompt': 'Select MiniMax region:',
  'provider.minimax.region.global': 'Global (https://api.minimax.io/anthropic)',
  'provider.minimax.region.china': 'China (https://api.minimaxi.com/anthropic)',
  'provider.minimax.token.prompt': 'MiniMax API token:',
  'provider.deepseek.prompt': 'DeepSeek API key:',
  'provider.openrouter.prompt': 'OpenRouter API key:',
  'provider.ollama.prompt': 'Ollama base URL:',
  'provider.ollama.default': 'http://localhost:11434',

  'ollama.menu.title': 'No Ollama available. What next?',
  'ollama.menu.1': 'It runs elsewhere, I will provide the URL',
  'ollama.menu.2': 'Install it locally now',
  'ollama.menu.3': 'Continue without Ollama',
  'ollama.probe.ok': 'OK -- using %s',
  'ollama.probe.failed': 'not reachable',
  'ollama.wait.timeout': 'Ollama did not respond within %s seconds',

  'vault.push.ok': 'Provider configuration pushed to the Vault',
  'vault.push.failed': 'Provider push failed -- can be fixed in the dashboard Settings page',
  'vault.push.unauthorized': 'Dashboard token invalid (401)',

  'service.status.active': 'Active',
  'service.status.inactive': 'Inactive',
  'service.status.failed': 'Failed',
  'service.status.unknown': 'Unknown',

  'summary.title': 'Marveen installation complete',
  'summary.bootstrap-url': 'Dashboard URL: %s',
  'summary.token': 'Dashboard token: %s',
  'summary.next-steps': 'Next steps',
  'summary.next-step.dashboard': 'Open the dashboard: %s',
  'summary.next-step.telegram': 'Start the Telegram channel: scripts/channels.sh',
  'summary.next-step.update': 'Update later: marveen-install update',

  'uninstall.confirm': 'Really remove the Marveen installation? (yes/no)',
  'uninstall.success': 'Marveen removed',
  'uninstall.cancelled': 'Cancelled',

  'doctor.checks.os': 'OS version',
  'doctor.checks.bun': 'Bun installed',
  'doctor.checks.claude': 'Claude Code installed',
  'doctor.checks.node': 'Node version',
  'doctor.checks.service': 'Service status',
  'doctor.checks.vault': 'Vault reachable',
  'doctor.checks.web': 'Dashboard reachable',

  'provider.update.success': 'Provider configuration updated',
  'provider.update.no-change': 'No changes',

  'update.check': 'Checking for updates',
  'update.apply': 'Applying update',
  'update.rollback': 'Rolling back to the previous version',
  'update.no-updates': 'No updates available',

  'prompt.required': 'This field is required',
  'prompt.integer': 'Enter an integer',
  'prompt.port-range': 'Port must be between 1 and 65535',
  'prompt.min-length-20': 'Must be at least 20 characters long',
  'prompt.url': 'Enter a URL starting with http:// or https://',
  'prompt.choice-1-2-3': 'Choose 1, 2 or 3',
  'prompt.yes-no': 'yes or no',
  'prompt.cancelled': 'Cancelled by user',
} as const

export type LocaleKey = keyof typeof en
export default en