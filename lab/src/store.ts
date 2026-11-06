import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { generatePrivateKey } from 'viem/accounts'
import type { Hex } from 'viem'
import { config } from './config.js'
import { live } from './live.js'

/**
 * Everything the lab keeps, in its data directory: its wallet key (made on
 * first start, never leaves the server), its projects and the apps' files.
 */
export interface Project {
  slug: string
  name: string
  symbol: string
  tagline: string
  about: string
  url: string
  image: string | null
  token: string | null
  tx: string | null
  createdAt: number
  launchedAt: number | null
}

export interface State {
  projects: Project[]
  /** USD spent on the model, per UTC day (YYYY-MM-DD). */
  spend: Record<string, number>
  lastClaimAt: number
  claimedHype: number
  lastError: { at: number; message: string } | null
  log: { at: number; text: string }[]
}

mkdirSync(join(config.dataDir, 'apps'), { recursive: true })
const STATE = join(config.dataDir, 'state.json')
const KEY = join(config.dataDir, 'wallet.key')

export function walletKey(): Hex {
  if (!existsSync(KEY)) {
    writeFileSync(KEY, generatePrivateKey(), { mode: 0o600 })
    chmodSync(KEY, 0o600)
  }
  return readFileSync(KEY, 'utf8').trim() as Hex
}

export const state: State = existsSync(STATE)
  ? (JSON.parse(readFileSync(STATE, 'utf8')) as State)
  : { projects: [], spend: {}, lastClaimAt: 0, claimedHype: 0, lastError: null, log: [] }

export function save() {
  writeFileSync(STATE + '.tmp', JSON.stringify(state, null, 2))
  renameSync(STATE + '.tmp', STATE)
}

/** A line in the public activity log (shown on mesa.cx/lab). Never put secrets here. */
export function note(text: string) {
  state.log.unshift({ at: Math.floor(Date.now() / 1000), text })
  state.log = state.log.slice(0, 100)
  save()
  live('step', text)
  console.log(JSON.stringify({ lab: text }))
}

export const today = () => new Date().toISOString().slice(0, 10)
export const spentToday = () => state.spend[today()] ?? 0

export const appDir = (slug: string) => join(config.dataDir, 'apps', slug)
export function writeApp(slug: string, html: string) {
  mkdirSync(appDir(slug), { recursive: true })
  writeFileSync(join(appDir(slug), 'index.html'), html)
}
export function readApp(slug: string): string | null {
  const f = join(appDir(slug), 'index.html')
  return /^[a-z0-9-]{2,40}$/.test(slug) && existsSync(f) ? readFileSync(f, 'utf8') : null
}
