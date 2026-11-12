import type { GraphicsCard } from '@custom-overlay/ui/api';
import { app } from 'electron';

/** PCI vendor ids of the brands with video encoders ffmpeg can use. */
const BRANDS: Record<number, GraphicsCard['brand']> = {
  4318: 'nvidia', // 0x10de
  4098: 'amd', // 0x1002
  4130: 'amd', // 0x1022
  32902: 'intel', // 0x8086
};

const BRAND_NAMES = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' } as const;

interface GpuDevice {
  vendorId?: number;
  deviceId?: number;
  deviceString?: string;
}

/** The graphics cards of this computer that can encode video (software adapters left out). */
export async function graphicsCards(): Promise<GraphicsCard[]> {
  let devices: GpuDevice[] = [];
  try {
    const info = (await app.getGPUInfo('complete')) as { gpuDevice?: GpuDevice[] };
    devices = info.gpuDevice ?? [];
  } catch {
    return [];
  }
  const cards: GraphicsCard[] = [];
  for (const device of devices) {
    const brand = BRANDS[device.vendorId ?? -1];
    if (!brand) continue;
    const name = device.deviceString?.trim() || `${BRAND_NAMES[brand]} graphics card`;
    if (!cards.some((card) => card.name === name)) cards.push({ name, brand });
  }
  return cards;
}
