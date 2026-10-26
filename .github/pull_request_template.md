## What and why

<!-- What this changes and the problem it solves. Link the issue: "Closes #123". -->

## Checks

- [ ] `npm run check` passes (lint, translations, typecheck, tests)
- [ ] New texts are in every language (`packages/ui/src/shared/locales`), or English is used as a placeholder
- [ ] Docs updated when behaviour changes (README for users, CONTRIBUTING for internals, `widgets/README.md`, `values/README.md`, `tracks/README.md`)

## Adding or fixing a track

<!-- Delete this section when the pull request is not about the track list. -->

- [ ] One file per layout: `packages/core/src/tracks/<country>/<name>.track.json`, exported from the Track step, with `country` and `location` added
- [ ] `npm run tracks` run, so `packages/core/src/tracks/catalog.json` includes it
- [ ] The lines cross the whole track at a right angle and touch no other part of it; layouts of the same venue each have a line only they cross
- [ ] Screenshot of the Track step with laps timed by the lines:
- [ ] I placed these lines myself (on the map or from my own logs), did not copy them from another app's track library, and release them under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
