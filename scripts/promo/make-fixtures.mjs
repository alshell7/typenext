// Fixtures for the promo film: the files a solution architect and a
// novelist would attach. The voice clips need macOS `say` and ffmpeg.
//   node scripts/promo/make-fixtures.mjs
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const dir = 'artifacts/promo/fixtures'
mkdirSync(dir, { recursive: true })
const files = {
  'order-service-requirements.md': `# Order service: requirements

Every change to an order must keep a full audit trail for seven years.
Refunds must be traceable to the original payment and the person who approved them.
The checkout path must stay under 200 ms at the 99th percentile during peak sales.
Read models can lag the write model by up to two seconds.
Teams must be able to replay events to rebuild a read model after a bug fix.
`,
  'design-review-notes.md': `# Design review, 14 October

Priya asked how we rebuild the reporting view after a schema change. Answer: replay the event log into a fresh projection.
Marco worries about storage growth. Snapshots every 500 events keep replays fast.
We agreed to publish order events on Kafka so billing and shipping can subscribe without coupling.
`,
  'characters.md': `# Characters

Mara Quill, 34, ferry pilot. She keeps her father's brass compass in the inside pocket of her coat. It has not pointed north since the flood.
Tobin, her younger brother, stayed behind in Saltmere to run the chandlery.
`,
}
for (const [name, text] of Object.entries(files)) writeFileSync(`${dir}/${name}`, text)

function voice(name, text) {
  const aiff = `${dir}/${name}.aiff`
  execFileSync('say', ['-r', '160', '-o', aiff, text])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-af', 'apad=pad_dur=3', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', `${dir}/${name}.wav`])
  rmSync(aiff, { force: true })
}
// Whistle hears this line the same way on every run.
voice('dictation', 'Snapshots every five hundred events keep rebuilds fast.')
voice('design-review', 'We agreed to publish order events on Kafka so billing and shipping can subscribe without coupling.')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 })
await page.setContent(`<body style="margin:0;background:#fbfaf7;font:600 20px -apple-system,Helvetica;color:#222">
<svg width="1200" height="720" viewBox="0 0 1200 720">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L10,5L0,10z" fill="#42644d"/></marker></defs>
<text x="60" y="70" font-size="30">Order service · event sourcing</text>
${[['Checkout API',80,160],['Order aggregate',420,160],['Event store',760,160],['Kafka: order-events',760,400],['Billing',420,560],['Shipping',760,600],['Reporting view',1000,560]].map(([t,x,y])=>`<rect x="${x}" y="${y}" width="${t.length*13+40}" height="70" rx="14" fill="#fff" stroke="#42644d" stroke-width="2.5"/><text x="${x+20}" y="${y+43}">${t}</text>`).join('')}
<path d="M290 195 H410" stroke="#42644d" stroke-width="3" marker-end="url(#a)"/>
<path d="M650 195 H750" stroke="#42644d" stroke-width="3" marker-end="url(#a)"/>
<path d="M880 230 V390" stroke="#42644d" stroke-width="3" marker-end="url(#a)"/>
<path d="M820 470 L560 550" stroke="#42644d" stroke-width="3" marker-end="url(#a)"/>
<path d="M880 470 V590" stroke="#42644d" stroke-width="3" marker-end="url(#a)"/>
<path d="M960 470 L1060 550" stroke="#42644d" stroke-width="3" marker-end="url(#a)"/>
</svg></body>`)
await page.screenshot({ path: `${dir}/architecture.png` })
await page.setContent(`<body style="font:15px Georgia;padding:40px;line-height:1.6"><h1>Capacity plan, Q4</h1>
<p>Peak sales reach 2,400 orders per minute. The event store must sustain 9,000 writes per second with headroom.</p>
<p>Snapshots every 500 events keep replays under four minutes for the largest aggregate.</p>
<p>Kafka retention is seven days; the event store keeps everything for seven years.</p></body>`)
await page.pdf({ path: `${dir}/capacity-plan.pdf`, format: 'A4' })
await browser.close()
