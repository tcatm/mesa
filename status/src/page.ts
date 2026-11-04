/** The public status page. Self-contained: it reads /api/status every 15 s. */
export const page = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mesa status</title>
<meta name="description" content="Live health, sync and uptime of Mesa's Elysium node, RPC and API.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M2 19 L7 10 L8 8 L16 8 L17 10 L22 19 Z' fill='%23e7a55a'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>
  /* Mesa palette, as in mesa-frontend/src/styles.css: night on the mesa */
  :root {
    color-scheme: dark;
    --night: oklch(0.16 0.004 60); --ridge-1: oklch(0.2 0.005 60); --ridge-2: oklch(0.25 0.008 60);
    --ridge-3: oklch(0.32 0.012 55); --ridge-4: oklch(0.42 0.02 55);
    --mist: oklch(0.72 0.012 70); --snow: oklch(0.95 0.006 80);
    --sand: oklch(0.77 0.13 63); --sage: oklch(0.72 0.07 160); --clay: oklch(0.66 0.13 35);
    --line: oklch(0.72 0.012 70 / 18%);
    --display: "Louize", "Instrument Serif", ui-serif, Georgia, serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--night); color: var(--snow);
    font: 15px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 16px 64px; }
  nav { position: sticky; top: 16px; z-index: 10; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 20px; border: 1px solid var(--line); border-radius: 999px; background: oklch(0.2 0.005 60 / 75%); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); margin-bottom: 40px; }
  nav a.brand { display: flex; align-items: center; gap: 8px; color: var(--snow); text-decoration: none; font: 400 24px/1 var(--display); }
  nav .live { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--mist); font: 500 10px/1 "JetBrains Mono", monospace; letter-spacing: 0.16em; text-transform: uppercase; padding: 10px 14px; border-radius: 999px; background: var(--ridge-2); }
  .eyebrow { font: 500 12px/1 "JetBrains Mono", monospace; letter-spacing: 0.2em; text-transform: uppercase; color: var(--sand); margin: 0; }
  h1 { font: 400 clamp(44px, 8vw, 60px)/1 var(--display); color: var(--snow); margin: 8px 0 0; }
  .lede { color: var(--mist); margin: 12px 0 28px; max-width: 36rem; }
  .grain { position: relative; isolation: isolate; }
  .grain::after { content: ""; position: absolute; inset: 0; pointer-events: none; border-radius: inherit; opacity: .09; mix-blend-mode: overlay; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
  .ridge { display: block; width: 100%; height: 90px; margin-top: 40px; }
  .scene { border-radius: 24px; overflow: hidden; border: 1px solid var(--line); background: var(--ridge-1); margin-bottom: 20px; }
  .scene svg { display: block; width: 100%; height: auto; }
  .banner { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-top: 1px solid var(--line); }
  .banner b { font: 400 28px/1.1 var(--display); }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--mist); box-shadow: 0 0 0 4px rgba(143,163,184,.12); }
  .dot.up { background: var(--sage); box-shadow: 0 0 0 4px rgba(127,181,154,.16); }
  .dot.degraded { background: var(--sand); box-shadow: 0 0 0 4px rgba(232,161,90,.16); }
  .dot.down { background: var(--clay); box-shadow: 0 0 0 4px rgba(217,115,91,.18); }
  .grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
  @media (min-width: 760px) { .grid { grid-template-columns: 1fr 1fr; } .wide { grid-column: 1 / -1; } }
  .card { background: var(--ridge-1); border: 1px solid var(--line); border-radius: 24px; padding: 20px 22px; min-width: 0; }
  .card h2 { font: 400 26px/1.1 var(--display); margin: 0; display: flex; align-items: center; gap: 12px; }
  .card h2 .host { color: var(--mist); font: 400 12px/1 "JetBrains Mono", monospace; margin-left: auto; }
  .note { color: var(--mist); margin: 6px 0 16px 22px; font-size: 14px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 13.5px; }
  .kv dt { color: var(--mist); } .kv dd { margin: 0; text-align: right; }
  .bar { height: 8px; border-radius: 99px; background: var(--ridge-2); overflow: hidden; margin: 4px 0 14px; }
  .bar i { display: block; height: 100%; background: var(--sand); border-radius: 99px; transition: width .6s ease; }
  .days { display: grid; grid-template-columns: repeat(30, 1fr); gap: 3px; margin-top: 14px; height: 26px; }
  .days span { border-radius: 3px; background: var(--ridge-2); }
  .days span.ok { background: var(--sage); } .days span.part { background: var(--sand); } .days span.bad { background: var(--clay); }
  .uptime { display: flex; justify-content: space-between; color: var(--mist); font-size: 12px; margin-top: 6px; }
  .uptime b { color: var(--snow); font-weight: 500; }
  footer { color: var(--mist); font-size: 12.5px; text-align: center; padding: 0 16px 28px; }
  footer a { color: var(--mist); }
  @media (prefers-reduced-motion: reduce) { .bar i { transition: none; } }
</style>
</head>
<body>
<main>
  <nav aria-label="Mesa">
    <a class="brand" href="https://mesa.cx">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--sand)" d="M2 19 L7 10 L8 8 L16 8 L17 10 L22 19 Z"/><path fill="var(--night)" opacity=".25" d="M16 8 L17 10 L22 19 L18 19 L15 10 Z"/></svg>
      Mesa
    </a>
    <span class="live"><span id="nav-dot" class="dot"></span><span id="checked">loading</span></span>
  </nav>
  <p class="eyebrow">Status</p>
  <h1>Is the mesa up?</h1>
  <p class="lede">Live health of Mesa's own Elysium node, the wallet RPC and the terminal API. Checked every 15 seconds.</p>

  <section class="scene grain" aria-label="Overall status">
    <svg viewBox="0 0 960 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="960" height="150" fill="var(--ridge-1)"/>
      <circle cx="96" cy="44" r="16" fill="var(--snow)"/><circle cx="104" cy="38" r="15" fill="var(--ridge-1)"/>
      <g fill="var(--snow)" opacity=".7"><circle cx="190" cy="30" r="1.6"/><circle cx="300" cy="52" r="1.2"/><circle cx="640" cy="26" r="1.4"/><circle cx="820" cy="48" r="1.2"/><circle cx="520" cy="40" r="1"/></g>
      <path d="M0 120 L120 86 L230 108 L360 70 L470 96 L600 64 L720 92 L840 72 L960 98 V150 H0Z" fill="var(--ridge-2)"/>
      <path d="M0 150 V128 L180 118 L300 122 L380 96 L420 92 L560 92 L600 96 L680 120 L820 116 L960 126 V150Z" fill="var(--ridge-3)"/>
      <path d="M420 92 L560 92" stroke="var(--sand)" stroke-width="2" opacity=".9"/>
    </svg>
    <div class="banner"><span id="overall-dot" class="dot"></span><b id="overall">Checking</b></div>
  </section>

  <div class="grid">
    <article class="card wide" id="node"></article>
    <article class="card" id="relay"></article>
    <article class="card" id="indexer"></article>
    <article class="card wide" id="host"></article>
  </div>
</main>
<svg class="ridge" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true"><path fill="var(--ridge-1)" d="M0 70 L120 50 L260 66 L420 30 L470 22 L640 22 L690 40 L860 60 L1020 38 L1180 58 L1320 42 L1440 56 L1440 120 L0 120 Z"/><path fill="var(--night)" opacity=".6" d="M0 96 L200 84 L480 100 L760 82 L1060 98 L1440 86 L1440 120 L0 120 Z"/></svg>

<footer><a href="https://mesa.cx">mesa.cx</a> · Built on Elysium · <a href="/api/status">JSON</a></footer>
<script>
  const $ = (id) => document.getElementById(id)
  const num = (n, d = 0) => n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
  const pct = (n) => n === null || n === undefined ? '—' : num(n, n >= 99.995 || n === 0 ? 0 : 2) + '%'
  const bytes = (b) => { if (!b) return '—'; const u = ['B','KB','MB','GB','TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++ } return num(b, i > 2 ? 1 : 0) + ' ' + u[i] }
  const ago = (iso) => { if (!iso) return 'never'; const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago' }
  const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm' }
  const label = { up: 'Operational', degraded: 'Degraded', down: 'Down' }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  function head(s, title, hostname) {
    return '<h2><span class="dot ' + s.state + '"></span>' + title + '<span class="host">' + hostname + '</span></h2><p class="note">' + esc(s.note) + '</p>'
  }
  function days(s) {
    const cells = (s.daily || []).map((v) => '<span class="' + (v === null ? '' : v >= 99.9 ? 'ok' : v >= 95 ? 'part' : 'bad') + '" title="' + (v === null ? 'no data' : pct(v)) + '"></span>').join('')
    return '<div class="days" aria-label="Last 30 days">' + cells + '</div><div class="uptime"><span>30 days ago</span><span>24h <b>' + pct(s.uptime.day) + '</b> · 7d <b>' + pct(s.uptime.week) + '</b> · 30d <b>' + pct(s.uptime.month) + '</b></span><span>Today</span></div>'
  }
  function kv(rows) { return '<dl class="kv">' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd class="mono">' + v + '</dd>').join('') + '</dl>' }

  function render(d) {
    $('checked').textContent = d.checkedAt ? new Date(d.checkedAt).toLocaleTimeString() : 'starting'
    if (!d.services) return
    $('overall').textContent = d.overall === 'up' ? 'All systems operational' : d.overall === 'degraded' ? 'Partially degraded' : 'Service disruption'
    $('overall-dot').className = 'dot ' + d.overall
    $('nav-dot').className = 'dot ' + d.overall
    const n = d.services.node, r = d.services.relay, i = d.services.indexer
    $('node').innerHTML = head(n, 'Elysium node', 'mainnet · chain 99901') +
      (n.progress !== null && n.progress !== undefined ? '<div class="bar" role="progressbar" aria-valuenow="' + n.progress + '"><i style="width:' + n.progress + '%"></i></div>' : '') +
      kv([
        ['Our block', num(n.head)],
        ['Confirmed chain (last batch on HyperEVM)', num(n.confirmedHead)],
        ['Live chain', num(n.liveHead)],
        ['Behind confirmed', n.behindConfirmed === null || n.behindConfirmed === undefined ? '—' : num(n.behindConfirmed) + ' blocks'],
        ['Latest block time', n.headTime ? new Date(n.headTime * 1000).toLocaleString() : '—'],
      ]) + days(n)
    $('relay').innerHTML = head(r, 'Wallet RPC', 'rpc.mesa.cx') + kv([
      ['Mode', r.mode === 'inbox' ? 'via HyperEVM inbox' : esc(r.mode || '—')],
      ['Relayer balance', r.relayerBalance === undefined ? '—' : num(r.relayerBalance, 4) + ' HYPE'],
      ['Relayed', num(r.relayedTotal)],
      ['Refused', num(Object.values(r.rejected || {}).reduce((a, b) => a + b, 0))],
      ['Spent this hour', r.spentLastHour === undefined ? '—' : num(parseFloat(r.spentLastHour), 5) + ' / ' + r.budgetPerHour + ' HYPE'],
      ['Last relay', ago(r.lastRelayAt)],
    ]) + days(r)
    $('indexer').innerHTML = head(i, 'Terminal API', 'api.mesa.cx') + kv([
      ['Network', esc(i.network || '—')],
      ['Blocks behind', num(i.lag)],
      ['Tokens launched', num(i.tokensLaunched)],
      ['Trades (24h)', num(i.trades24h)],
    ]) + days(i)
    const h = d.host
    $('host').innerHTML = '<h2><span class="dot ' + (h ? 'up' : 'down') + '"></span>Server<span class="host">' + (h ? h.cpus + ' cores' : '') + '</span></h2><p class="note">' + (h ? 'Up ' + dur(h.uptimeSeconds) : 'No data') + '</p>' + (h ? kv([
      ['Load (1m / 5m / 15m)', h.load.map((x) => num(x, 2)).join(' / ')],
      ['Memory', bytes(h.memory.used) + ' of ' + bytes(h.memory.total)],
      ['Disk', bytes(h.disk.used) + ' of ' + bytes(h.disk.total)],
    ]) : '')
  }
  async function refresh() {
    try { render(await (await fetch('/api/status', { cache: 'no-store' })).json()) }
    catch { $('overall').textContent = 'Status page cannot reach the checker'; $('overall-dot').className = 'dot down' }
  }
  refresh(); setInterval(refresh, 15000)
</script>
</body>
</html>`
