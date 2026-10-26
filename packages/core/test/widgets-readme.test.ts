import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BUILTIN_WIDGET_TYPES } from '../src/widgets/registry.js';

it('documents every built-in widget type', () => {
  const readme = readFileSync(new URL('../src/widgets/README.md', import.meta.url), 'utf8');
  for (const type of BUILTIN_WIDGET_TYPES) {
    // Table row: | `type-id` | Name | (columns may be padded by the formatter)
    expect(readme).toMatch(new RegExp(`\\|\\s*\`${type.type}\`\\s*\\|\\s*${type.name}\\s*\\|`));
  }
});
