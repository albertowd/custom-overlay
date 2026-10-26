# Contributing to Custom Overlay

Thanks for helping! This guide is for people who want to build the app from source, fix a bug,
add a feature, a widget, a translation or a track. If you only want to use the app, the
[README](README.md) is the place to start.

- **Bugs and feature requests:** [GitHub Issues](https://github.com/albertowd/custom-overlay/issues).
- **Questions and ideas:** [GitHub Discussions](https://github.com/albertowd/custom-overlay/discussions).
- **Tracks:** no code needed, see [Adding or fixing a track](#adding-or-fixing-a-track).

## Getting started

Requires Node.js 24+ (the version in `.nvmrc`, also the one Electron ships).

```sh
npm install
npm run dev          # build the core, start the desktop app with hot reload
npm run dev:pwa      # build the core, start the web app with hot reload
```

| Script                                       |                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run build`                              | Build the core, CLI, desktop app and web app (`apps/pwa/dist`)                    |
| `npm test` / `npm run test:coverage`         | Unit tests (Vitest) of every workspace, with coverage in `<workspace>/coverage`   |
| `npm run typecheck`                          | Type-check every workspace                                                        |
| `npm run lint` / `npm run lint:fix`          | [Biome](https://biomejs.dev) lint + format check / autofix                        |
| `npm run check:locales`                      | Missing translation keys and placeholders that differ from English                |
| `npm run check`                              | lint + translations + typecheck + tests                                           |
| `npm run tracks`                             | Rebuild `packages/core/src/tracks/catalog.json` after adding or changing a track  |
| `npm run cli -- --help`                      | Run the CLI from the build output                                                 |
| `npm run package -w @custom-overlay/desktop` | Installer for the current OS (electron-builder, output in `apps/desktop/release`) |

The desktop app also opens a `*.overlay.json` passed on the command line ("Open with").

## Repository layout

```
packages/core   Engine (no UI): MP4/GPMF reader, RaceChrono and DJI subtitle parsers, sync, project model, workflow
                 '@custom-overlay/core'          platform agnostic
                 '@custom-overlay/core/loaders'  media loading from any reader (a file, a browser File)
                 '@custom-overlay/core/node'     file system: loaders, project/template files
packages/ui     React user interface shared by both apps, its translations and the API it needs from its host
                 '@custom-overlay/ui'            mountApp(root, api)
                 '@custom-overlay/ui/api'        the AppApi contract each host implements
packages/cli    `custom-overlay` command line, built on the core
apps/desktop    Electron app (electron-vite): main process + preload implement the AppApi
apps/pwa        Web app (Vite, installable PWA): the AppApi in the browser, engine in a Web Worker
docs/media      Screenshot and step recordings used by the README
```

Everything is driven by the TypeScript core, shared by the desktop app, the web app and the CLI,
so a project or a template built in the app can be rendered later without a UI. New features go to
both the desktop app and the web app.

The step rules (what is optional, what blocks the next step) live in the core
(`evaluateWorkflow`), so the CLI enforces the same checks as the app.

Projects (`*.overlay.json`) and templates (`*.template.json`) are validated with zod schemas
(`ProjectSchema`, `TemplateSchema`). Paths in a project are stored relative to the project file.

## How it works

### Reading media

Video files are never fully loaded and importing needs no ffmpeg: the MP4 parser only reads the
`moov` box and the telemetry samples, so files of several GB are fine. Exporting uses the ffmpeg
bundled with the app (`ffmpeg-static`), or the one in `FFMPEG_PATH`.

### Sync strategies

Convention: `timeline time = item time + offset`. The first video (or the first source when
there is no video) sits at 0. The timeline runs from the earliest start to the latest end of all
enabled videos and sources.

1. **GoPro chapters.** `GX01xxxx`, `GX02xxxx`... of the same clip are chained end to end. Chapters
   of one folder are a single recording, so their chaining is certain and beats any signal match.
2. **GPS time.** The UTC instant of the first frame is taken as the median of `GPS date − cts`
   over samples **with a GPS lock** (fix ≥ 2). It is compared with the logger's absolute time or
   another camera's GPS time.
3. **Speed correlation.** The item's speed is cross-correlated with everything already placed: a
   coarse pass, then a 20 Hz pass. With an absolute estimate available, the search is limited to
   a window around it (±30 s for GPS time, ±120 s for the camera clock). This also absorbs logger
   clock drift. When another, distant offset matches almost as well (repeating laps), the result
   is flagged as ambiguous and never auto-accepted.
4. **Camera clock fallback** (no GPS). Uses `mvhd`, `mdhd` or `udta/GPMF CDAT`. Two cameras'
   clocks are compared directly. Against a UTC logger, GoPro's habit of storing local time as if
   it were UTC means the machine's timezone is proposed first (override with `--camera-tz`)
   and UTC second.

Items are synced in order (chapters, then other videos, then data sources), so each item that
gets placed helps place the next. Results with at least 80% confidence are applied and marked as
synced; anything less is applied but left for review. The timestamp sources and the GPS-fix
handling are adapted from [gpmf-sync](https://github.com/albertowd/gpmf-sync) /
[gpmf-sync-web](https://github.com/albertowd/gpmf-sync-web).

### Export

Widgets are drawn frame by frame with the editor's own widget code on a Skia canvas
(`@napi-rs/canvas`), on several worker threads, and piped as raw RGBA to ffmpeg. ffmpeg cuts the
range out of the videos (chapters and gaps between videos become black and silence), converts to
the output frame rate, scales, overlays the widgets and encodes. The transparent PNG sequence
skips the videos.

- **GPU.** Videos are decoded with D3D11 (Windows) / VideoToolbox (macOS), and the first working
  NVIDIA NVENC, AMD AMF or Intel QSV encoder is used, else x264 / x265 / AOM AV1 on the CPU.
- **Colours.** The output colour description is written into the stream (some GPU encoders
  ignore ffmpeg's tags otherwise).
- **Encoder presets** follow YouTube's
  [recommended upload settings](https://support.google.com/youtube/answer/1722171) and
  [HDR upload guide](https://support.google.com/youtube/answer/7126552): one preset per cell of
  YouTube's bitrate tables (every resolution, in both frame rate columns), at the top of
  YouTube's range for that cell. Projects saved with the earlier single "YouTube" preset load with
  its H.264 equivalent.
- **Scaling.** DLSS and XeSS are not offered: they are temporal upscalers that need motion vectors
  and depth from a game engine. NVIDIA RTX Video Super Resolution could come later as a native
  add-on.

The web app exports the transparent PNG sequence itself (into a folder in Chrome and Edge, as a
streamed zip elsewhere). The final video is exported by the desktop app or the CLI.

## Widgets and values

- [packages/core/src/widgets/README.md](packages/core/src/widgets/README.md): the widget framework,
  including how to write a widget type.
- [packages/core/src/values/README.md](packages/core/src/values/README.md): built-in values and
  value scripts.

## Translations

Messages live in `packages/ui/src/shared/locales/<language>/<namespace>.json`; English is the
reference. Texts defined by the core (steps, widgets, values, presets) are translated under the
`core` namespace by their ids, so the core itself stays English. The CLI and the files it writes
stay in English.

To fix or add a translation, edit the JSON files and run `npm run check:locales`. A new language
also needs an entry in `LANGUAGES` (`packages/ui/src/shared/i18n.ts`), in `locales/index.ts`, and
in `electronLanguages` (`apps/desktop/electron-builder.yml`), which keeps Chromium's own texts to
the same languages.

## Adding or fixing a track

The app ships with a [list of known tracks](packages/core/src/tracks/README.md), updated from
GitHub at every start. Open a pull request with the `*.track.json` exported from the Track step
(see [the guide](packages/core/src/tracks/README.md#adding-or-improving-a-track)), or fill in the
[Add or fix a track](https://github.com/albertowd/custom-overlay/issues/new?template=track.yml)
issue form.

## Pull requests

Before opening a pull request:

- `npm run check` passes (lint, translations, typecheck, tests);
- new texts are in every language, or English is used as a placeholder;
- docs are updated when behaviour changes: the [README](README.md) for what users see, this file
  for how things work, and the widgets / values / tracks guides.

## Releases

Pushing a version tag (`git tag v0.2.0 && git push origin v0.2.0`, or _Run workflow_ in the
Actions tab) runs [.github/workflows/release.yml](.github/workflows/release.yml): lint, typecheck
and tests, then packages for Windows x64, Linux x64 and macOS (Apple Silicon and Intel), each as
an installer (`.exe`, `.AppImage`, `.dmg`) and a portable archive of the whole app (`.zip`,
`.tar.gz`), attached to the GitHub release with a `SHA256SUMS.txt`. Tags like `v0.2.0-beta.1`
become pre-releases. Builds are not code-signed yet.

The packaged app checks GitHub for a newer release at start. Development builds only check with
`CUSTOM_OVERLAY_CHECK_UPDATES=1`.

## Code quality: SonarQube

`docker-compose.yml` runs a local SonarQube Community instance, using its embedded database
since this is for development only.

```sh
npm run sonar:up        # http://localhost:9000, first login admin / admin (you'll be asked to change it)
# My Account > Security > generate a token, then:
export SONAR_TOKEN=...  # PowerShell: $env:SONAR_TOKEN = "..."; or SONAR_TOKEN=... in .env
npm run sonar:scan      # tests with coverage, then the scanner container
npm run sonar:down
```

Analysis settings are in `sonar-project.properties`. Coverage comes from the `coverage/lcov.info`
of the core, the CLI and the desktop app, with paths normalized for the Linux scanner container.
The desktop tests run the main process in Node with `electron` mocked, and the renderer in jsdom
with a fake `window.api` (`apps/desktop/test/renderer/setup.ts`).

## Troubleshooting

- **Electron starts as plain Node** (`Cannot find module 'electron'`): the shell has
  `ELECTRON_RUN_AS_NODE=1` set, which happens in terminals spawned by some VS Code extensions.
  Unset it before running `npm run dev`.
- **Electron binary missing after install**: `npm install` runs `scripts/ensure-electron.mjs`,
  which downloads it. You can also run `node node_modules/electron/install.js` directly.

## License

By contributing code, you agree to license it under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Widgets, templates, value
scripts and tracks shared in Discussions, track issues and track pull requests are released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), so they can be bundled with the app.
