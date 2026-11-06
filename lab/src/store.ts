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
  /** The news agent (news.ts). */
  news?: NewsCoin[]
  newsSpend?: Record<string, number>
  newsSeen?: string[]
  newsLog?: { at: number; text: string }[]
  newsLastClaimAt?: number
  newsClaimedHype?: number
  /** The idea agent (ideas.ts): open project ideas, each with a coin, for anyone to fork and build. */
  ideas?: IdeaCoin[]
  ideasLog?: { at: number; text: string }[]
  /** The vamp agent (vamps.ts): Elysium versions of tokens trending on other chains. */
  vamps?: NewsCoin[]
  vampLog?: { at: number; text: string }[]
  vampLastClaimAt?: number
  vampClaimedHype?: number
  /** One-off top-ups already sent (config.fundIdeas ids). */
  funded?: string[]
}

export interface IdeaCoin {
  name: string
  symbol: string
  tagline: string
  /** The problem it solves, what to build, and three milestones. */
  problem: string
  build: string
  milestones: string[]
  category: string
  image: string | null
  token: string | null
  tx: string | null
  at: number
}

export interface NewsCoin {
  name: string
  symbol: string
  blurb: string
  headline: string
  source: string
  link: string
  image: string | null
  token: string | null
  tx: string | null
  at: number
  /** 'news' from a headline, 'vamp' from a ticker trending on another chain. */
  kind?: 'news' | 'vamp'
  /** Where a vamp's picture came from (public domain / CC0 on Wikimedia Commons). */
  imageCredit?: string
}

mkdirSync(join(config.dataDir, 'apps'), { recursive: true })
const STATE = join(config.dataDir, 'state.json')
const KEY = join(config.dataDir, 'wallet.key')

/** A wallet key kept in the data directory, made on first use; it never leaves the server. */
export function walletKey(name = 'wallet'): Hex {
  const file = name === 'wallet' ? KEY : join(config.dataDir, `${name}.key`)
  if (!existsSync(file)) {
    writeFileSync(file, generatePrivateKey(), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return readFileSync(file, 'utf8').trim() as Hex
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
export const spentToday = (bucket: 'lab' | 'news' = 'lab') =>
  (bucket === 'news' ? state.newsSpend?.[today()] : state.spend[today()]) ?? 0

export const appDir = (slug: string) => join(config.dataDir, 'apps', slug)
export function writeApp(slug: string, html: string) {
  mkdirSync(appDir(slug), { recursive: true })
  writeFileSync(join(appDir(slug), 'index.html'), html)
}
export function readApp(slug: string): string | null {
  const f = join(appDir(slug), 'index.html')
  return /^[a-z0-9-]{2,40}$/.test(slug) && existsSync(f) ? readFileSync(f, 'utf8') : null
}
