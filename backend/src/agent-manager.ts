import { spawn, ChildProcess } from 'child_process';
import path from 'path';

const AGENT_DIR = path.resolve(__dirname, '../../agent');
const running = new Map<string, ChildProcess>();

export function spawnAgent(interviewId: string, roomName: string): void {
  if (running.has(interviewId)) {
    console.warn(`[AgentManager] Agent already running for interview ${interviewId}`);
    return;
  }

  const isDev = process.env.NODE_ENV !== 'production';
  const command = isDev
    ? path.join(AGENT_DIR, 'node_modules', '.bin', 'ts-node')
    : 'node';
  const args = isDev ? ['src/index.ts'] : ['dist/index.js'];

  const child = spawn(command, args, {
    cwd: AGENT_DIR,
    env: { ...process.env, LIVEKIT_ROOM_NAME: roomName, INTERVIEW_ID: interviewId },
    stdio: 'pipe',
  });

  running.set(interviewId, child);
  console.log(`[AgentManager] Agent spawned for room "${roomName}" (pid ${child.pid})`);

  child.stdout?.on('data', (d: Buffer) =>
    process.stdout.write(`[Agent:${roomName}] ${d.toString()}`),
  );
  child.stderr?.on('data', (d: Buffer) =>
    process.stderr.write(`[Agent:${roomName}] ${d.toString()}`),
  );

  child.on('exit', (code) => {
    running.delete(interviewId);
    console.log(`[AgentManager] Agent for room "${roomName}" exited (code ${code ?? 'null'})`);
  });
}

export function killAgent(interviewId: string): void {
  const child = running.get(interviewId);
  if (child) {
    child.kill();
    running.delete(interviewId);
    console.log(`[AgentManager] Agent for interview ${interviewId} killed`);
  }
}

export function killAllAgents(): void {
  for (const [id, child] of running) {
    child.kill();
    console.log(`[AgentManager] Killed agent for interview ${id}`);
  }
  running.clear();
}

export function isAgentRunning(interviewId: string): boolean {
  return running.has(interviewId);
}

export function runningCount(): number {
  return running.size;
}
