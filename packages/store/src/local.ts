// Filesystem outputs for trusted local workflows. No S3 requests are sent.
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Store } from "./index.ts";

export class LocalStore extends Store {
  readonly directory: string;

  constructor(directory: string) {
    super("local");
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  #path(key: string): string {
    if (!key || isAbsolute(key) || key.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Invalid local object key: ${key}`);
    }
    return join(this.directory, key);
  }

  #write(path: string, body: string | Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  override async put(key: string, body: string | Uint8Array): Promise<string> {
    this.#write(this.#path(key), body);
    return key;
  }

  override async bytes(key: string): Promise<Buffer> {
    try {
      return readFileSync(this.#path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw Object.assign(new Error(`Missing local object: ${key}`), { name: "NoSuchKey" });
    }
  }

  override async claim(key: string, value: unknown): Promise<boolean> {
    const path = this.#path(key);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  override async updateJson(key: string, update: (current: unknown | undefined) => unknown): Promise<string> {
    const path = this.#path(key);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Contention and a stale lock both fail closed. The workflow owns its output
    // directory; separate local tasks never share one.
    const lock = `${path}.lock`;
    const fd = openSync(lock, "wx", 0o600);
    try {
      let current: unknown;
      try {
        current = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = update(current);
      if (next !== current) this.#write(path, JSON.stringify(next));
      return key;
    } finally {
      closeSync(fd);
      rmSync(lock);
    }
  }
}
