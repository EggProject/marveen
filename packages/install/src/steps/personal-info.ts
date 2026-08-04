// Personal info step: BOT_NAME, BRAND_NAME, OWNER_NAME.
//
// The three names go straight into the runtime env via vault push
// later. They are NOT provider credentials so they are not sensitive
// but they ARE user-visible in dashboard greeting + agent identity, so
// defaults are derived from the system user name when blank.

import { homedir, userInfo } from 'node:os'
import type { InstallerContext } from '../types.js'
import { input } from '../ui/prompts.js'

export interface PersonalInfoResult {
  botName: string
  brandName: string
  ownerName: string
}

function defaultOwner(): string {
  try { return userInfo().username }
  catch { return 'operator' }
}

export async function stepPersonalInfo(ctx: InstallerContext): Promise<PersonalInfoResult> {
  const ownerDefault = ctx.ownerName || defaultOwner()
  const botDefault = ctx.botName || 'Marveen'
  const brandDefault = ctx.brandName || 'Marveen'

  if (ctx.nonInteractive) {
    ctx.botName = botDefault
    ctx.brandName = brandDefault
    ctx.ownerName = ownerDefault
    return { botName: botDefault, brandName: brandDefault, ownerName: ownerDefault }
  }

  const botName = await input('BOT_NAME', {
    defaultValue: botDefault,
    validate: (v) => v.trim().length > 0 ? true : 'A BOT_NAME megadása kötelező',
  })
  const brandName = await input('BRAND_NAME', {
    defaultValue: brandDefault,
    validate: (v) => v.trim().length > 0 ? true : 'A BRAND_NAME megadása kötelező',
  })
  const ownerName = await input('OWNER_NAME', {
    defaultValue: ownerDefault,
    validate: (v) => v.trim().length > 0 ? true : 'Az OWNER_NAME megadása kötelező',
  })

  ctx.botName = botName
  ctx.brandName = brandName
  ctx.ownerName = ownerName

  return { botName, brandName, ownerName }
}

// Helper used by Listr2 step titles: the home-derived default is useful
// in logs so the operator sees what was inferred without inspecting
// ctx.
export function homeOwner(): string {
  return homedir()
}