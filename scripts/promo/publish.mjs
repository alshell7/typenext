// Make the web files from the rendered film:
// docs/media/typenext-film.mp4 (web encode), the poster, and the README preview GIF.
//   node scripts/promo/publish.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'

const master = 'artifacts/promo/typenext-film.mp4'
const media = 'docs/media'
mkdirSync(media, { recursive: true })
const ffmpeg = args => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })

ffmpeg(['-i', master, '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-maxrate', '6M', '-bufsize', '12M', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', `${media}/typenext-film.mp4`])
ffmpeg(['-ss', '29.6', '-i', master, '-frames:v', '1', '-q:v', '3', `${media}/typenext-film-poster.jpg`])

// The README cannot play video, so it shows a light GIF teaser: the opening
// (the idea and a real suggestion with its source), then the mark.
const palette = 'artifacts/promo/palette.png'
const teaser = '[0:v]trim=0:10.95,setpts=PTS-STARTPTS[a];[0:v]trim=26.75:30,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1,hqdn3d=6:6:12:12,fps=12,scale=720:-1:flags=lanczos'
ffmpeg(['-i', master, '-filter_complex', `${teaser},palettegen=max_colors=144:stats_mode=diff`, palette])
ffmpeg(['-i', master, '-i', palette, '-filter_complex', `${teaser}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, `${media}/typenext-film.gif`])
rmSync(palette, { force: true })

for (const file of ['typenext-film.mp4', 'typenext-film-poster.jpg', 'typenext-film.gif'])
  console.log(`${media}/${file}: ${(statSync(`${media}/${file}`).size / 1048576).toFixed(1)} MB`)
