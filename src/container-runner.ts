/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Apple Container and handles IPC
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  GROUPS_DIR,
  DATA_DIR
} from './config.ts';
import { RegisteredGroup } from './types.ts';
import { validateAdditionalMounts } from './mount-security.ts';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error('Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty');
  }
  return home;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  currentTime: string;  // ISO string in host's local timezone
  isScheduledTask?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });

    // Global memory directory (read-only for non-main)
    // Apple Container only supports directory mounts, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false
  });

  // Environment file directory (workaround for Apple Container -i env var bug)
  // Only expose specific auth variables needed by Claude Code, not the entire .env
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');

  const envLines: string[] = [];

  // Add allowed vars from .env if it exists
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
    const filteredLines = envContent
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        return allowedVars.some(v => trimmed.startsWith(`${v}=`));
      });
    envLines.push(...filteredLines);
  }

  // Always add TZ from host system so container uses same timezone for scheduled tasks
  const hostTz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  envLines.push(`TZ=${hostTz}`);

  fs.writeFileSync(path.join(envDir, 'env'), envLines.join('\n') + '\n');
  mounts.push({
    hostPath: envDir,
    containerPath: '/workspace/env-dir',
    readonly: true
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[]): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  // Apple Container: --mount for readonly, -v for read-write
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const containerArgs = buildContainerArgs(mounts);

  logger.debug({
    group: group.name,
    mounts: mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
    containerArgs: containerArgs.join(' ')
  }, 'Container mount configuration');

  logger.info({
    group: group.name,
    mountCount: mounts.length,
    isMain: input.isMain
  }, 'Spawning container agent');

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const container = Bun.spawn(['container', ...containerArgs], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Write input to stdin
  container.stdin.write(JSON.stringify(input));
  container.stdin.end();

  // Set up timeout
  const timeoutMs = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    logger.error({ group: group.name }, 'Container timeout, killing');
    container.kill();
  }, timeoutMs);

  // Collect stdout and stderr with size limits
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const collectStream = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });

      if (isStdout) {
        if (stdoutTruncated) continue;
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn({ group: group.name, size: stdout.length }, 'Container stdout truncated due to size limit');
        } else {
          stdout += chunk;
        }
      } else {
        const lines = chunk.trim().split('\n');
        for (const line of lines) {
          if (line) {
            // Log time-related lines at info level for debugging timezone issues
            if (line.includes('Container time:') || line.includes('TZ env:')) {
              logger.info({ container: group.folder }, line);
            } else {
              logger.debug({ container: group.folder }, line);
            }
          }
        }
        if (stderrTruncated) continue;
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
          logger.warn({ group: group.name, size: stderr.length }, 'Container stderr truncated due to size limit');
        } else {
          stderr += chunk;
        }
      }
    }
  };

  // Collect streams in parallel and wait for exit
  await Promise.all([
    collectStream(container.stdout, true),
    collectStream(container.stderr, false),
  ]);

  const code = await container.exited;
  clearTimeout(timeoutId);

  if (timedOut) {
    return {
      status: 'error',
      result: null,
      error: `Container timed out after ${timeoutMs}ms`
    };
  }

  const duration = Date.now() - startTime;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `container-${timestamp}.log`);
  const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

  const logLines = [
    `=== Container Run Log ===`,
    `Timestamp: ${new Date().toISOString()}`,
    `Group: ${group.name}`,
    `IsMain: ${input.isMain}`,
    `Duration: ${duration}ms`,
    `Exit Code: ${code}`,
    `Stdout Truncated: ${stdoutTruncated}`,
    `Stderr Truncated: ${stderrTruncated}`,
    ``
  ];

  if (isVerbose) {
    logLines.push(
      `=== Input ===`,
      JSON.stringify(input, null, 2),
      ``,
      `=== Container Args ===`,
      containerArgs.join(' '),
      ``,
      `=== Mounts ===`,
      mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
      ``,
      `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
      stderr,
      ``,
      `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
      stdout
    );
  } else {
    logLines.push(
      `=== Input Summary ===`,
      `Prompt length: ${input.prompt.length} chars`,
      `Session ID: ${input.sessionId || 'new'}`,
      ``,
      `=== Mounts ===`,
      mounts.map(m => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
      ``
    );

    if (code !== 0) {
      logLines.push(
        `=== Stderr (last 500 chars) ===`,
        stderr.slice(-500),
        ``
      );
    }
  }

  fs.writeFileSync(logFile, logLines.join('\n'));
  logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

  if (code !== 0) {
    logger.error({
      group: group.name,
      code,
      duration,
      stderr: stderr.slice(-500),
      logFile
    }, 'Container exited with error');

    return {
      status: 'error',
      result: null,
      error: `Container exited with code ${code}: ${stderr.slice(-200)}`
    };
  }

  try {
    // Extract JSON between sentinel markers for robust parsing
    const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
    const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

    let jsonLine: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonLine = stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
    } else {
      // Fallback: last non-empty line (backwards compatibility)
      const lines = stdout.trim().split('\n');
      jsonLine = lines[lines.length - 1];
    }

    const output: ContainerOutput = JSON.parse(jsonLine);

    logger.info({
      group: group.name,
      duration,
      status: output.status,
      hasResult: !!output.result
    }, 'Container completed');

    return output;
  } catch (err) {
    logger.error({
      group: group.name,
      stdout: stdout.slice(-500),
      error: err
    }, 'Failed to parse container output');

    return {
      status: 'error',
      result: null,
      error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter(t => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(groupsFile, JSON.stringify({
    groups: visibleGroups,
    lastSync: new Date().toISOString()
  }, null, 2));
}
