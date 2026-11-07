// Shit mode: while LAB_SHIT_MODE=1, every agent launches "shit token" ($SHIT)
// with a pile-of-poo emoji logo instead of its own name and art.
// Turn it off by setting LAB_SHIT_MODE=0 (or removing it) and redeploying.
import { memeLogo } from './memelogo.js'
import { config } from './config.js'

export const shitMode = () => config.shitMode

interface Form { name: string; symbol: string; description?: string; image?: string }

async function poo(): Promise<string | undefined> {
  for (let i = 0; i < 2; i++) {
    try {
      const l = await memeLogo(['pile of poo'], `shit-${Date.now()}`)
      if (!l) return undefined
      const r = await fetch(config.uploadUrl, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(l.png) })
      const b = (await r.json()) as { url?: string }
      if (r.ok && b.url) return b.url
    } catch {
      // retry once
    }
  }
  return undefined
}

/** The form as given, or, in shit mode, the same launch as "shit token". Throws if no logo (no coin without an icon). */
export async function shitify<T extends Form>(form: T): Promise<T> {
  if (!config.shitMode) return form
  const image = await poo()
  if (!image) throw new Error('shit mode: logo upload failed, skipping')
  return { ...form, name: 'shit token', symbol: 'SHIT', description: 'shit token.', image }
}
