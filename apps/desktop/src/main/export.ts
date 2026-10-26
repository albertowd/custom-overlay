import { Worker } from 'node:worker_threads';
import type { Project } from '@custom-overlay/core';
import { type ExportResult, exportProject } from '@custom-overlay/core/node';
import { projectMedia } from '@custom-overlay/ui/host';
import type { WebContents } from 'electron';
import { IpcChannel } from '../shared/ipc';
import workerPath from './export-worker?modulePath';
import { t } from './settings';

/** The running export, at most one at a time. */
let running: AbortController | null = null;

/** Render the project's export, sending progress to the window that asked. */
export async function startExport(sender: WebContents, project: Project): Promise<ExportResult> {
  if (running) throw new Error(t('main.errors.exportRunning'));
  const controller = new AbortController();
  running = controller;
  try {
    return await exportProject({
      project,
      media: projectMedia(project),
      signal: controller.signal,
      createWorker: () => new Worker(workerPath),
      onProgress: (progress) => {
        if (!sender.isDestroyed()) sender.send(IpcChannel.exportProgress, progress);
      },
    });
  } finally {
    running = null;
  }
}

export function cancelExport(): void {
  running?.abort();
}

/** Whether an export is running (to warn before quitting). */
export function exportRunning(): boolean {
  return running !== null;
}
