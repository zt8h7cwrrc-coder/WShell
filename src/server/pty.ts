// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * PTY abstraction.
 *
 * Prefers node-pty (real pseudo-terminal) so interactive programs
 * (vim, top, less, sudo) work and resize/signals are honoured. If the
 * native module cannot be loaded — e.g. a platform without prebuilt
 * binaries — it transparently falls back to child_process.spawn.
 */

import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import { createRequire } from "module";

export interface PtyHandle {
  /** Write user input to the terminal stdin. */
  write(data: string): void;
  /** Resize the terminal. No-op for the spawn fallback. */
  resize(cols: number, rows: number): void;
  /** Kill the underlying process. */
  kill(signal?: string): void;
  /** Register output/exit callbacks. Returns this for chaining. */
  onData(cb: (data: string) => void): this;
  onExit(cb: (info: { exitCode: number; signal?: string }) => void): this;
}

/* ── node-pty loader (best-effort) ────────────────────────────────────── */

interface NodePty {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) => {
    onData(cb: (d: string) => void): { dispose(): void };
    onExit(cb: (e: { exitCode: number; signal?: string }) => void): { dispose(): void };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    pid: number;
  };
}

let ptyMod: NodePty | null = null;
let ptyProbed = false;

function loadPty(): NodePty | null {
  if (ptyProbed) return ptyMod;
  ptyProbed = true;
  try {
    // node-pty ships as CJS; load it via createRequire from the ESM context.
    const req = createRequire(import.meta.url);
    ptyMod = req("node-pty") as NodePty;
  } catch {
    ptyMod = null;
  }
  return ptyMod;
}

/** True when node-pty loaded successfully (real PTY available). */
export function ptyAvailable(): boolean {
  return loadPty() !== null;
}

/* ── Handles ──────────────────────────────────────────────────────────── */

class PtyRealHandle implements PtyHandle {
  private term: ReturnType<NodePty["spawn"]>;
  constructor(term: ReturnType<NodePty["spawn"]>) {
    this.term = term;
  }
  write(data: string): void {
    this.term.write(data);
  }
  resize(cols: number, rows: number): void {
    try {
      this.term.resize(cols, rows);
    } catch {
      /* resize before start can throw; ignore */
    }
  }
  kill(signal?: string): void {
    try {
      this.term.kill(signal);
    } catch {
      /* already dead */
    }
  }
  onData(cb: (data: string) => void): this {
    this.term.onData(cb);
    return this;
  }
  onExit(cb: (info: { exitCode: number; signal?: string }) => void): this {
    this.term.onExit(cb);
    return this;
  }
}

class PtySpawnHandle implements PtyHandle {
  private proc: ChildProcess;
  constructor(proc: ChildProcess) {
    this.proc = proc;
  }
  write(data: string): void {
    this.proc.stdin?.write(data);
  }
  resize(): void {
    // No real resize without a PTY.
  }
  kill(signal?: string): void {
    try {
      this.proc.kill(signal as NodeJS.Signals);
    } catch {
      /* already dead */
    }
  }
  onData(cb: (data: string) => void): this {
    this.proc.stdout?.on("data", (d: Buffer) => cb(d.toString("utf8")));
    this.proc.stderr?.on("data", (d: Buffer) => cb(d.toString("utf8")));
    return this;
  }
  onExit(cb: (info: { exitCode: number; signal?: string }) => void): this {
    this.proc.on("close", (code, signal) => {
      cb({ exitCode: code === null ? -1 : code, signal: signal ?? undefined });
    });
    this.proc.on("error", () => cb({ exitCode: -1 }));
    return this;
  }
}

/* ── Public spawn ─────────────────────────────────────────────────────── */

export interface SpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn an interactive shell. Uses node-pty when available, otherwise
 * falls back to child_process.spawn.
 */
export function spawnPty(file: string, args: string[], opts: SpawnOptions): PtyHandle {
  const pty = loadPty();
  if (pty) {
    const term = pty.spawn(file, args, {
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    return new PtyRealHandle(term);
  }

  const proc = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new PtySpawnHandle(proc);
}
