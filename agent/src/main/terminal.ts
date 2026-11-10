import * as pty from 'node-pty';
import os from 'node:os';

interface TerminalSession {
  id: string;
  pty: pty.IPty;
}

const sessions = new Map<string, TerminalSession>();

function defaultShell(): string {
  switch (process.platform) {
    case 'win32':
      return 'powershell.exe';
    case 'darwin':
      return '/bin/zsh';
    default:
      return '/bin/bash';
  }
}

export function openTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  shell: string | undefined,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): void {
  closeTerminal(sessionId);

  const ptyProcess = pty.spawn(shell || defaultShell(), [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: process.env as Record<string, string>,
  });

  sessions.set(sessionId, { id: sessionId, pty: ptyProcess });

  ptyProcess.onData((data) => onData(data));
  ptyProcess.onExit(({ exitCode }) => {
    sessions.delete(sessionId);
    onExit(exitCode);
  });
}

export function writeTerminal(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  session?.pty.write(data);
}

export function resizeTerminal(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId);
  session?.pty.resize(cols, rows);
}

export function closeTerminal(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    try {
      session.pty.kill();
    } catch {
      // already dead
    }
    sessions.delete(sessionId);
  }
}

export function closeAllTerminals(): void {
  for (const id of [...sessions.keys()]) {
    closeTerminal(id);
  }
}
