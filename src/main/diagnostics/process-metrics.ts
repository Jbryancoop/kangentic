import { app } from 'electron';
import type { ProcessMetrics } from '../../shared/types';

/**
 * Snapshot of per-process resource usage. Wraps `app.getAppMetrics()` and
 * adds platform + version context for bug-report reproducibility. On-demand
 * only - no install hook, no persistent storage.
 */
export function getProcessMetrics(): ProcessMetrics {
  const metrics = app.getAppMetrics();
  return {
    ts: new Date().toISOString(),
    uptimeSec: process.uptime(),
    platform: process.platform,
    arch: process.arch,
    versions: {
      kangentic: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    processes: metrics.map((entry) => ({
      pid: entry.pid,
      type: entry.type,
      name: entry.name,
      cpu: { percentCPUUsage: entry.cpu.percentCPUUsage },
      memory: {
        workingSetSize: entry.memory.workingSetSize,
        peakWorkingSetSize: entry.memory.peakWorkingSetSize,
        privateBytes: entry.memory.privateBytes,
      },
      creationTime: entry.creationTime,
    })),
  };
}
