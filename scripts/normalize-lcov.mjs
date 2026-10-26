// Rewrite Windows path separators in lcov reports so the (Linux) SonarQube scanner resolves them.
import { readFile, writeFile } from 'node:fs/promises';

const files = process.argv.slice(2);
for (const file of files) {
  const content = await readFile(file, 'utf8');
  const normalized = content.replace(/^SF:(.*)$/gm, (_, path) => `SF:${path.replaceAll('\\', '/')}`);
  await writeFile(file, normalized);
}
