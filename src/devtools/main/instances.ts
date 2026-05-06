import * as http from 'node:http';
import { enumerateWorktrees } from '../../main/git/worktree-list';
import { readLockfile, isLockfilePidAlive } from './lockfile';
import type {
  PreviewInfoResponse,
  PreviewInstanceRecord,
  PreviewLockfileStatus,
} from '../shared/types';

/**
 * Discovery for running `/preview` instances. Combines the product
 * worktree enumeration (`src/main/git/worktree-list`) with lockfile
 * presence + a fast `/info` ping to determine whether each worktree's
 * inspection bridge is currently responding.
 *
 * Status precedence per worktree:
 *   - `responding` - lockfile exists, PID alive, `/info` returned 200 in <250ms
 *   - `stale`      - lockfile exists, but either PID is dead OR the ping failed
 *   - `absent`     - no lockfile at all
 *
 * Used by the dev-only `kangentic_devtools_list_instances` MCP tool.
 */

const PING_TIMEOUT_MS = 250;

export async function enumeratePreviewInstances(): Promise<PreviewInstanceRecord[]> {
  const projects = await enumerateWorktrees();
  const records: PreviewInstanceRecord[] = [];

  // Each worktree is checked independently; the ping deadline is short
  // enough that running them sequentially is fine even with dozens of
  // worktrees. Promise.all would risk stampeding the OS for no real win.
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const lockfile = readLockfile(worktree.path);
      let status: PreviewLockfileStatus = 'absent';
      if (lockfile) {
        if (!isLockfilePidAlive(lockfile)) {
          status = 'stale';
        } else {
          const reachable = await pingInfo(lockfile.port);
          status = reachable ? 'responding' : 'stale';
        }
      }
      records.push({
        ...worktree,
        projectId: project.projectId,
        projectName: project.projectName,
        lockfile,
        lockfileStatus: status,
      });
    }
  }

  return records;
}

/**
 * GET http://127.0.0.1:<port>/info with a hard timeout. Returns true when
 * the server responds 200 (regardless of body shape). Used only for the
 * status enum - the actual body is fetched separately when a tool needs
 * the rich info.
 */
function pingInfo(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/info',
        method: 'GET',
        timeout: PING_TIMEOUT_MS,
      },
      (response) => {
        // Drain the body so the socket can close cleanly.
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

/**
 * Fetch the full `/info` payload from a specific instance's port. Used
 * by tools that need richer state than just the status enum (e.g.
 * `kangentic_devtools_engine_state`).
 */
export function fetchPreviewInfo(port: number): Promise<PreviewInfoResponse | null> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/info',
        method: 'GET',
        timeout: PING_TIMEOUT_MS,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as PreviewInfoResponse);
          } catch {
            resolve(null);
          }
        });
        response.on('error', () => resolve(null));
      },
    );
    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.end();
  });
}
