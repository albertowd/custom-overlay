// Builds packages/core/src/tracks/catalog.json from every <country>/<name>.track.json of the folder:
// the list bundled with the app and downloaded by it from GitHub. Run it after adding or changing a
// track (`npm run tracks`); the core tests fail while it is out of date. Validation is left to them.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const folder = join(import.meta.dirname, '../packages/core/src/tracks');
const EXTENSION = '.track.json';

const tracks = readdirSync(folder, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(join(folder, d.name))
      .filter((f) => f.endsWith(EXTENSION))
      .map((f) => {
        const id = `${d.name}/${f.slice(0, -EXTENSION.length)}`;
        const {
          version: _,
          country,
          location,
          track,
        } = JSON.parse(readFileSync(join(folder, d.name, f), 'utf8'));
        return { id, country, location, track };
      }),
  )
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

writeFileSync(join(folder, 'catalog.json'), `${JSON.stringify({ version: 1, tracks }, null, 2)}\n`);
console.log(`catalog.json: ${tracks.length} tracks`);
