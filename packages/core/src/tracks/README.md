# Tracks

The app knows a list of tracks: start/finish and sector lines that are loaded on their own when a
session is driven there. Open a session from Guaporé and the lap values come from the Guaporé lines
without drawing anything.

- [The list: offline and online](#the-list-offline-and-online)
- [Detection](#detection)
- [Choosing a track by hand](#choosing-a-track-by-hand)
- [Adding or improving a track](#adding-or-improving-a-track)

## The list: offline and online

Every track is a file of this folder; `catalog.json` gathers them all (built by `npm run tracks`).

- **Offline:** each release bundles `catalog.json` as it was when it was built, so detection works
  without internet.
- **Online:** at start the app downloads the latest `catalog.json` from the `main` branch of the
  repository, so tracks added or fixed after a release are known without updating the app. A
  downloaded track replaces the bundled one with the same id (a correction).
- **Cached:** the last download is kept in the app data folder (`tracks/catalog.json`) and used
  when GitHub cannot be reached. Later starts only download it again when it changed (ETag).

Only the list is downloaded: the session's positions never leave the computer, and nearby tracks
are found locally. Development builds can test another catalog (a fork, a local server) with
`CUSTOM_OVERLAY_TRACKS_URL`.

## Detection

When the project has no start/finish or sector lines, the app checks the GPS path of every enabled
source (embedded telemetry included) against the list once the media loads:

1. Only tracks whose start/finish line lies within ~1 km of the session's positions are checked.
2. The path must cross the start/finish line and at least half of the track's lines (GPS dropouts
   can miss one). Several sources and GoPro chapters add up.
3. The best match wins: most of its lines crossed, then the most lines (the more precise layout),
   then the most laps. When two tracks fit just as well (two layouts sharing their lines), nothing
   is loaded and the Track step lists both.

The lines are loaded once per opened project: removing them afterwards keeps them removed. With
_Lap values come from: the logger_, the app never loads lines on its own. When the downloaded list
arrives after the media, detection runs again with it.

Code: `catalog.ts` (the list, `parseTrackCatalog`, `mergeTrackCatalogs`) and `detect.ts`
(`detectTracks`, `bestTrackMatch`, `distanceKm`).

## Choosing a track by hand

The _Track list_ group of the Track step loads any track of the list:

- **In this session:** the tracks the session drove on.
- **Within 100 km:** the other tracks near the session's GPS positions, closest first, with their
  distance.
- **By country:** every other track.
- **Search:** type part of the name, the city or the country (in any language of the app; accents
  do not matter: `guapore`, `brasil viamao`) to find a track, with or without GPS. Useful to load
  the lines before the media, or for a session without positions.

The line under the list says where it comes from: this version only, fresh from GitHub, or the
last download.

## Adding or improving a track

Every track is one file, `<country>/<name>.track.json`, where `<country>` is the lower case
[ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) code (`br`, `it`, `us`...).

1. In the Track step, draw the start/finish line and the sector lines (or load the track from the
   list and fix them), give the track its full name, and _Export lines…_.
2. Add `country` and `location` next to `version`:

   ```json
   {
     "version": 1,
     "country": "BR",
     "location": "Guaporé, Rio Grande do Sul",
     "track": {
       "name": "Autódromo Internacional de Guaporé",
       "startFinish": { "a": { "latitude": -28.8437851, "longitude": -51.8515787 }, "b": { "...": "..." } },
       "sectors": [],
       "minLapSeconds": 10
     }
   }
   ```

   `timing` can be left out: the project's own choice is kept when the lines load.
3. Save it in this folder and run `npm run tracks` to rebuild `catalog.json`, then `npm test`:
   the tests check that every file is valid, named, in the right country folder and in an up to
   date `catalog.json`. (Two pull requests adding tracks may conflict on `catalog.json`: run
   `npm run tracks` again after merging.)
4. Open a pull request with a screenshot of the Track step showing laps timed by the lines. Once
   it is merged, every app downloads the track at its next start.

The pull request template has a checklist for tracks.

Not a developer? Fill in the
[Add or fix a track](https://github.com/albertowd/custom-overlay/issues/new?template=track.yml)
issue form with the exported file and a screenshot (the app's _Share your lines_ link in the Track
step opens it), and the track will be added to the list. Use the same form for wrong lines, or when
the app detects the wrong track or none. Questions about timing lines and layouts go to the
[Tracks discussions](https://github.com/albertowd/custom-overlay/discussions/categories/tracks).

Good lines:

- Cross the whole track, pit lane included when it rejoins after the line, at a right angle, about
  30 m long, and do not touch any other part of the track.
- Use the official timing lines when they are known (painted on the track, or the organiser's
  sector boards). Otherwise say where they are in the pull request.
- Different layouts of the same venue are different files (`it/monza-gp`, `it/monza-junior`). Give
  each layout at least one sector line that only it crosses, so detection can tell them apart.

Only share lines you placed yourself (on the map or from your own logs). Do not copy them from
another app's track library. Tracks are released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) so they can be bundled with the app.
