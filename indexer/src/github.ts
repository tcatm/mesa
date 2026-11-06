import type { DatabaseSync } from 'node:sqlite'

/**
 * GitHub checks for the Builder Drop, for every verified GitHub on a project
 * page: how old the account is (it must be 90+ days old for the GitHub
 * points), and which weeks it pushed commits to the project's repo during the
 * season. Uses the public GitHub API (GITHUB_TOKEN raises the rate limit),
 * re-checked every 6 hours.
 */
export const SEASON_START = Number(process.env.AIRDROP_SEASON_START ?? 1792800000) // Oct 24, 2026: the first trades on Elysium

export function migrateGithub(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_activity (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      repo TEXT,
      created_at INTEGER,
      weeks TEXT NOT NULL DEFAULT '[]',
      checked_at INTEGER NOT NULL
    );
  `)
}

async function gh<T>(path: string): Promise<T | null> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'mesa-indexer' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const r = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(20_000) })
  if (r.status === 404 || r.status === 409) return null // 409: an empty repo
  if (!r.ok) throw new Error(`github ${r.status}`)
  return (await r.json()) as T
}

async function check(db: DatabaseSync, token: string, username: string) {
  const prof = db.prepare('SELECT profile FROM project_profiles WHERE lower(token) = ?').get(token) as { profile: string } | undefined
  const repoRaw = prof ? String((JSON.parse(prof.profile) as { repo?: string }).repo ?? '') : ''
  const repo = /^[\w.-]+\/[\w.-]+$/.test(repoRaw.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''))
    ? repoRaw.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '')
    : null
  const user = await gh<{ created_at?: string }>(`/users/${encodeURIComponent(username)}`)
  const created = user?.created_at ? Math.floor(Date.parse(user.created_at) / 1000) : null
  const weeks = new Set<number>()
  if (repo) {
    const since = new Date(SEASON_START * 1000).toISOString()
    for (let page = 1; page <= 5; page++) {
      const commits = await gh<{ commit?: { author?: { date?: string } } }[]>(
        `/repos/${repo}/commits?author=${encodeURIComponent(username)}&since=${since}&per_page=100&page=${page}`,
      )
      if (!commits?.length) break
      for (const c of commits) {
        const t = Date.parse(c.commit?.author?.date ?? '')
        if (t) weeks.add(Math.floor(t / 1000 / (7 * 86_400)))
      }
      if (commits.length < 100) break
    }
  }
  db.prepare(
    `INSERT INTO github_activity (token, username, repo, created_at, weeks, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET username = excluded.username, repo = excluded.repo, created_at = excluded.created_at,
       weeks = excluded.weeks, checked_at = excluded.checked_at`,
  ).run(token, username, repo, created, JSON.stringify([...weeks].sort()), Math.floor(Date.now() / 1000))
}

export function startGithub(db: DatabaseSync) {
  migrateGithub(db)
  async function loop() {
    for (;;) {
      const due = db
        .prepare(
          `SELECT lower(g.token) token, g.username FROM project_github g
             LEFT JOIN github_activity a ON a.token = lower(g.token)
            WHERE a.checked_at IS NULL OR a.checked_at < ? LIMIT 20`,
        )
        .all(Math.floor(Date.now() / 1000) - 6 * 3_600) as { token: string; username: string }[]
      for (const d of due) {
        try {
          await check(db, d.token, d.username)
        } catch (e) {
          console.error(JSON.stringify({ githubError: String(e).slice(0, 200), token: d.token }))
          if (/403|429/.test(String(e))) await new Promise((r) => setTimeout(r, 15 * 60_000))
        }
        await new Promise((r) => setTimeout(r, 3_000))
      }
      await new Promise((r) => setTimeout(r, 10 * 60_000))
    }
  }
  void loop()
}
