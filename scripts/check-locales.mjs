// Compares every language of the user interface with English (the reference): missing and extra
// keys, and placeholders ({name}) that differ. Exits with 1 when something is wrong.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../packages/ui/src/shared/locales');
const REFERENCE = 'en';

function flatten(tree, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const id = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[id] = [value];
    else if (typeof value.other === 'string') out[id] = Object.values(value);
    else flatten(value, id, out);
  }
  return out;
}

function load(language) {
  const messages = {};
  for (const file of readdirSync(join(root, language)).filter((f) => f.endsWith('.json'))) {
    const namespace = file.slice(0, -'.json'.length);
    flatten(JSON.parse(readFileSync(join(root, language, file), 'utf8')), namespace, messages);
  }
  return messages;
}

const placeholders = (texts) =>
  [...new Set(texts.flatMap((t) => t.match(/\{\w+\}/g) ?? []))].sort().join(' ');

const reference = load(REFERENCE);
const languages = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== REFERENCE)
  .map((d) => d.name);

let problems = 0;
for (const language of languages) {
  const messages = load(language);
  const report = (text) => {
    problems++;
    console.error(`${language}: ${text}`);
  };
  for (const key of Object.keys(reference)) {
    if (!(key in messages)) report(`missing ${key}`);
    else if (placeholders(messages[key]) !== placeholders(reference[key])) {
      report(
        `placeholders of ${key}: ${placeholders(messages[key]) || 'none'}, expected ${placeholders(reference[key]) || 'none'}`,
      );
    }
  }
  for (const key of Object.keys(messages)) if (!(key in reference)) report(`extra ${key}`);
}

console.log(
  `${Object.keys(reference).length} messages, ${languages.length + 1} languages, ${problems} problems`,
);
process.exit(problems > 0 ? 1 : 0);
