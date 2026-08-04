// Hungarian locale strings for every user-visible installer message.
//
// Parity with en.ts is enforced by a unit test (Phase C): both modules
// must export the same key set, otherwise the installer can render a
// Hungarian `t(...)` call against an undefined English string (or
// vice-versa) and the parity gate fails. Keep keys flat and ASCII-only.

const hu = {
  'cli.title': 'Marveen telepítő',
  'cli.subtitle': 'AI fleet management rendszer',

  'install.steps.prereq': 'Előfeltételek ellenőrzése',
  'install.steps.bun': 'Bun telepítése',
  'install.steps.claude': 'Claude Code telepítése',
  'install.steps.claude-auth': 'Claude hitelesítés',
  'install.steps.personal': 'Személyes adatok',
  'install.steps.dependencies': 'Függőségek telepítése',
  'install.steps.build': 'TypeScript build',
  'install.steps.provider': 'Provider választás',
  'install.steps.ollama': 'Ollama felfedezés',
  'install.steps.vault': 'Vault push',
  'install.steps.service': 'Rendszerszolgáltatás telepítése',
  'install.steps.bumblebee': 'Bumblebee scheduled task',
  'install.steps.summary': 'Összefoglaló',

  'provider.choose': 'Válaszd ki a modell-szolgáltatót:',
  'provider.choices.anthropic': 'Anthropic Claude',
  'provider.choices.minimax': 'MiniMax',
  'provider.choices.deepseek': 'DeepSeek',
  'provider.choices.openrouter': 'OpenRouter',
  'provider.choices.ollama': 'Ollama (lokális)',
  'provider.choices.skip': 'Kihagyás',

  'error.invalid-port': 'Érvénytelen port: %s',
  'error.not-supported': 'Nem támogatott platform: %s',
  'error.branch-not-found': 'Nem található a(z) %s marveen ág',
  'error.unknown-provider': 'Ismeretlen provider: %s',

  'provider.anthropic.api-key.prompt': 'ANTHROPIC_API_KEY (sk-ant-...):',
  'provider.anthropic.oauth.prompt': 'OAuth setup-token (sk-ant-oat01-...):',
  'provider.anthropic.method.prompt': 'Anthropic hitelesítés módja:',
  'provider.anthropic.method.api-key': 'API key (sk-ant-...)',
  'provider.anthropic.method.oauth': 'OAuth setup-token',
  'provider.anthropic.method.skip': 'Kihagyás',

  'provider.minimax.region.prompt': 'Válaszd ki a MiniMax régiót:',
  'provider.minimax.region.global': 'Global (https://api.minimax.io/anthropic)',
  'provider.minimax.region.china': 'China (https://api.minimaxi.com/anthropic)',
  'provider.minimax.token.prompt': 'MiniMax API token:',
  'provider.deepseek.prompt': 'DeepSeek API key:',
  'provider.openrouter.prompt': 'OpenRouter API key:',
  'provider.ollama.prompt': 'Ollama base URL:',
  'provider.ollama.default': 'http://localhost:11434',

  'ollama.menu.title': 'Nincs elérhető Ollama. Mit tegyünk?',
  'ollama.menu.1': 'Mashol fut, ide megadom az URL-t',
  'ollama.menu.2': 'Telepítsd most helyben',
  'ollama.menu.3': 'Ollama nélkül megyünk tovább',
  'ollama.probe.ok': 'OK -- using %s',
  'ollama.probe.failed': 'nem elérhető',
  'ollama.wait.timeout': 'Ollama nem válaszol %s másodperc alatt',

  'vault.push.ok': 'Provider konfiguráció push-olva a Vault-ba',
  'vault.push.failed': 'Provider push sikertelen -- a dashboard Beállítások oldalon javítható',
  'vault.push.unauthorized': 'Dashboard token érvénytelen (401)',

  'service.status.active': 'Aktív',
  'service.status.inactive': 'Inaktív',
  'service.status.failed': 'Sikertelen',
  'service.status.unknown': 'Ismeretlen',

  'summary.title': 'Marveen telepítés kész',
  'summary.bootstrap-url': 'Dashboard URL: %s',
  'summary.token': 'Dashboard token: %s',
  'summary.next-steps': 'Következő lépések',
  'summary.next-step.dashboard': 'Nyisd meg a dashboard-ot: %s',
  'summary.next-step.telegram': 'Indítsd el a Telegram channel-t: szkript/channels.sh',
  'summary.next-step.update': 'Frissítés később: marveen-install update',

  'uninstall.confirm': 'Biztosan törlöd a Marveen telepítést? (igen/nem)',
  'uninstall.success': 'Marveen eltávolítva',
  'uninstall.cancelled': 'Megszakítva',

  'doctor.checks.os': 'OS verzió',
  'doctor.checks.bun': 'Bun telepítve',
  'doctor.checks.claude': 'Claude Code telepítve',
  'doctor.checks.node': 'Node verzió',
  'doctor.checks.service': 'Service állapot',
  'doctor.checks.vault': 'Vault elérhető',
  'doctor.checks.web': 'Dashboard elérhető',

  'provider.update.success': 'Provider konfiguráció frissítve',
  'provider.update.no-change': 'Nincs változás',

  'update.check': 'Frissítés keresése',
  'update.apply': 'Frissítés alkalmazása',
  'update.rollback': 'Visszaállás a korábbi verzióra',
  'update.no-updates': 'Nincs elérhető frissítés',

  'prompt.required': 'A mező nem lehet üres',
  'prompt.integer': 'Egész számot adj meg',
  'prompt.port-range': '1 és 65535 közötti portot adj meg',
  'prompt.min-length-20': 'Minimum 20 karakter hosszú legyen',
  'prompt.url': 'http:// vagy https:// kezdetű URL-t adj meg',
  'prompt.choice-1-2-3': '1, 2 vagy 3 közül válassz',
  'prompt.yes-no': 'igen vagy nem',
  'prompt.cancelled': 'Megszakítva a felhasználó által',
} as const

export type LocaleKey = keyof typeof hu
export default hu