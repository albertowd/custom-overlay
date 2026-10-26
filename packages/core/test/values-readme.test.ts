import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileValueScript } from '../src/values/engine.js';

// Every ```js block of the values README must compile.
it('README examples compile', () => {
  const readme = readFileSync(new URL('../src/values/README.md', import.meta.url), 'utf8');
  const blocks = [...readme.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  expect(blocks.length).toBeGreaterThan(4);
  for (const code of blocks) {
    expect(() =>
      compileValueScript({ id: 'x', name: 'x', description: '', unit: '', initial: null, code }),
    ).not.toThrow();
  }
});
