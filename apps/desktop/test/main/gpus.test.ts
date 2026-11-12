import { describe, expect, it, vi } from 'vitest';
import { app } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));

const { graphicsCards } = await import('../../src/main/gpus');

describe('graphicsCards', () => {
  it('lists the cards of brands that encode video, by name', async () => {
    app.getGPUInfo.mockResolvedValueOnce({
      gpuDevice: [
        { vendorId: 0x10de, deviceId: 1, deviceString: 'NVIDIA GeForce RTX 3070' },
        { vendorId: 0x8086, deviceId: 2, deviceString: '' },
        // Microsoft Basic Render Driver, and the same card twice.
        { vendorId: 0x1414, deviceId: 3, deviceString: 'Microsoft Basic Render Driver' },
        { vendorId: 0x10de, deviceId: 1, deviceString: 'NVIDIA GeForce RTX 3070' },
        { vendorId: 0x1002, deviceId: 4 },
      ],
    });
    expect(await graphicsCards()).toEqual([
      { name: 'NVIDIA GeForce RTX 3070', brand: 'nvidia' },
      { name: 'Intel graphics card', brand: 'intel' },
      { name: 'AMD graphics card', brand: 'amd' },
    ]);
    expect(app.getGPUInfo).toHaveBeenCalledWith('complete');
  });

  it('lists nothing when the GPU cannot be queried', async () => {
    app.getGPUInfo.mockRejectedValueOnce(new Error('GPU process crashed'));
    expect(await graphicsCards()).toEqual([]);
    app.getGPUInfo.mockResolvedValueOnce({});
    expect(await graphicsCards()).toEqual([]);
  });
});
