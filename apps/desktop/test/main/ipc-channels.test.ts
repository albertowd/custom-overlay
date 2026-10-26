import { describe, expect, it } from 'vitest';
import { IpcChannel } from '../../src/shared/ipc';

describe('IPC channels', () => {
  it('uses a distinct channel name for every request', () => {
    const names = Object.values(IpcChannel);
    expect(new Set(names).size).toBe(names.length);
  });
});
