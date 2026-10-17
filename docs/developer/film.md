# The TypeNext film

The 45-second film in the README and on the website is made from code. The app scenes are real recordings of TypeNext. The 3D scenes, the Lottie animations, the kinetic type and the music are made by scripts in `scripts/promo/`.

## Make the film

1. Start the browser preview: `npm run dev -- --host 127.0.0.1`.
2. Make the fixtures: `node scripts/promo/make-fixtures.mjs`. This step needs macOS `say` and `ffmpeg` for the spoken line.
3. Record the app scenes: `node scripts/promo/record-clips.mjs`. To record some scenes again, give their names, for example `write dictate`.
4. Make the score: `node scripts/promo/soundtrack.mjs`. It also writes the voice envelope for the on-screen meter.
5. Render: `node scripts/promo/render.mjs` (about 25 minutes). For stills, use `--stills 2.1,4.2`. For a part, use `--from 20 --to 25`. `--blur 1` turns off motion blur for quick previews.
6. Make the web files: `node scripts/promo/publish.mjs`. This writes `docs/media/typenext-film.mp4`, the poster and the README teaser GIF.

All output goes to `artifacts/promo/` (not in Git) until step 6. The render page loads fonts, three.js and lottie-web from the network.

## How it works

- **One timeline.** `timeline.mjs` holds the scenes on a 100 BPM grid (a beat is 0.6 s), the stomps, the cues for sound and Lottie, and the clip time maps. The picture (`film.js`, `three-scenes.js`) and the sound (`soundtrack.mjs`) read the same values, so every hit has its sound.
- **Real scenes.** `record-clips.mjs` drives the app with Playwright and saves one JPEG for each paint from the DevTools screencast, at twice the screen size. It also saves the time and the screen position of key moments, such as the suggestion and the source line. The film uses these positions to zoom.
- **Real suggestions and dictation.** The suggestions come from the attached fixture files with the local engine. The dictation scene uses Whistle in the browser, with a spoken line from `say` as the microphone. It plays at its natural speed. Do not edit the text in the scenes by hand.
- **Three layers.** Back to front: a WebGL stage (`three-scenes.js`: drifting light and dust, the knowledge core with orbiting source tiles, the extruded TypeNext mark with studio reflections and bloom), the DOM world (`film.js`: kinetic type with 3D extrusion, app windows with depth and a floor reflection, captions), and a flat overlay for Lottie bursts that must stay in front.
- **Lottie.** `lottie-assets.mjs` writes the animations as Lottie JSON (shape layers, trim paths, eased keyframes): a sparkle for Tab, checkmarks, a microphone with ripples and a padlock. lottie-web steps each one to the exact frame.
- **Frames from time.** Every element is set from the time `t`. There are no timers or CSS animations. `render.mjs` renders two sub-frames for each 60 fps frame and `ffmpeg` blends them, which gives real motion blur.
- **Sound from code.** `soundtrack.mjs` synthesizes the score in A minor: kicks, claps and 808-style hats, an FM electric piano, plucked arpeggios, a supersaw pad and a sub bass with sidechain. It adds impacts, risers, whooshes, key clicks and bells on the timeline cues, a convolution reverb from a synthetic hall, ducking under the voice and a glue compressor. A two-pass loudness pass masters it to −14 LUFS and −1 dBTP. It uses no samples.

## Rules

- Keep each claim true. Check numbers (for example the installer size) against a release before you change them.
- Show the app as it is. Do not change frames or add text over the app that the app does not show.
- Keep the TypeNext mark exact. `three-scenes.js` extrudes it from the geometry of `public/brand/logo-master.png`.
- Use pinned library versions in `film.html`. Use only fonts and libraries whose licences allow use in a rendered video; see `docs/licensing.md`.
