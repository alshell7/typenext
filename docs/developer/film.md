# The TypeNext film

The 30-second film in the README and on the website is made from code. The app scenes are real recordings of TypeNext. The motion graphics and the music are made by scripts in `scripts/promo/`.

## Make the film

1. Start the browser preview: `npm run dev -- --host 127.0.0.1`.
2. Make the fixtures: `node scripts/promo/make-fixtures.mjs`. This step needs macOS `say` and `ffmpeg` for the spoken line.
3. Record the app scenes: `node scripts/promo/record-clips.mjs`. To record some scenes again, give their names, for example `write dictate`.
4. Make the soundtrack: `node scripts/promo/soundtrack.mjs`.
5. Render: `node scripts/promo/render.mjs`. For stills, use `--stills 2.1,4.2`. For a part, use `--from 20 --to 25`.
6. Make the web files: `node scripts/promo/publish.mjs`. This writes `docs/media/typenext-film.mp4`, the poster and the README preview.

All output goes to `artifacts/promo/` (not in Git) until step 6.

## How it works

- **One timeline.** `timeline.mjs` holds the scene times, the beats, the stomps and the clip time maps. The picture (`film.js`) and the sound (`soundtrack.mjs`) read the same values, so a stomp always has its sound.
- **Real scenes.** `record-clips.mjs` drives the app with Playwright and saves one JPEG for each paint from the DevTools screencast, at twice the screen size. It also saves the time and the screen position of key moments, such as the suggestion and the source line. The film uses these positions to zoom.
- **Real suggestions and dictation.** The suggestions come from the attached fixture files with the local engine. The dictation scene uses Whistle in the browser. A spoken line from `say` is the microphone input. Do not edit the text in the scenes by hand.
- **Frames from time.** `film.js` sets every element from the time `t`. It has no timers or CSS animations. `render.mjs` calls `renderAt(t)` for each frame at 60 fps and sends PNG frames to `ffmpeg`.
- **Sound from code.** `soundtrack.mjs` makes the drums, pad, bass, risers and impacts with simple synthesis at 120 BPM. It has no samples. The dictated line plays at 1.15× speed with the same pitch, and the music becomes quieter under it.

## Rules

- Keep each claim true. Check numbers (for example the installer size) against a release before you change them.
- Show the app as it is. Do not change frames or add text over the app that the app does not show.
- Keep the TypeNext mark exact. `film.js` draws it from the geometry of `public/brand/logo-master.png`.
- The fonts in the film are Inter Tight, Instrument Serif and JetBrains Mono (SIL Open Font License). They are used only to render the video.
