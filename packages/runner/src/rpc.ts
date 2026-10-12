// Minimal client for `pi --mode rpc`: JSON lines over stdin/stdout.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

export type PiProcessOptions = {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  uid?: number;
  gid?: number;
};

export class PiRpc {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, { resolve: (response: Json) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Set<(event: Json) => void>();
  #nextId = 0;
  #exited: Promise<number | null>;
  #failure?: Error;
  #stopped?: Promise<void>;
  stderrTail = "";

  constructor(options: PiProcessOptions) {
    this.#child = spawn(options.bin, ["--mode", "rpc", ...options.args], {
      cwd: options.cwd,
      env: options.env,
      uid: options.uid,
      gid: options.gid,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.#exited = new Promise((resolve) => {
      this.#child.on("error", (error) => {
        this.#fail(error);
        resolve(null);
      });
      this.#child.on("exit", (code) => {
        this.#fail(new Error(`pi exited with code ${code}: ${this.stderrTail.slice(-500)}`));
        resolve(code);
      });
    });
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        return;
      }
      if (message.type === "response" && typeof message.id === "string") {
        this.#pending.get(message.id)?.resolve(message);
        this.#pending.delete(message.id);
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
  }

  onEvent(listener: (event: Json) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async command(command: Json, timeoutMs = 30_000): Promise<Json> {
    if (this.#failure) throw this.#failure;
    const id = `req-${this.#nextId++}`;
    const response = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`pi rpc ${String(command.type)} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    const value = await response;
    if (value.success !== true) throw new Error(`pi rpc ${String(command.type)} failed: ${JSON.stringify(value.error ?? value)}`);
    return value;
  }

  /** Resolves when the session settles (no more automatic continuation). */
  waitSettled(): Promise<void> {
    return new Promise((resolve, reject) => {
      const off = this.onEvent((event) => {
        if (event.type === "agent_settled") {
          off();
          resolve();
        }
      });
      void this.#exited.then((code) => {
        off();
        reject(this.#failure ?? new Error(`pi exited with code ${code}`));
      });
    });
  }

  stop(): Promise<void> {
    this.#stopped ??= this.#stop();
    return this.#stopped;
  }

  async #stop(): Promise<void> {
    if (!this.#failure) this.#child.stdin.end();
    const killGroup = () => {
      try {
        if (this.#child.pid) process.kill(-this.#child.pid, "SIGKILL");
      } catch {
        this.#child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(killGroup, 5_000);
    await this.#exited;
    clearTimeout(timer);
    killGroup();
  }
}
