// The agent's session (Pi JSONL) is the record of what it did. It is saved to
// the Mork bucket while the station runs, at the end and on shutdown, with
// every secret the container holds redacted, plus an HTML export for people.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redact } from "@mork/sources";
import type { Store } from "@mork/store";
import { readAgentFile, writeFresh } from "./agentfs.ts";
import { exec } from "./git.ts";

const THROTTLE_MS = 30_000;

/** Replaces every occurrence of a secret value; short values are skipped to avoid mangling text. */
export class SessionLog {
  /** Path Pi writes the session to (inside the agent's home, so never trusted by root). */
  readonly file: string;
  /** Root-owned directory where the redacted copy is exported to HTML. */
  readonly #staging: string;
  readonly key: string;
  readonly #store: Store;
  readonly #secrets: () => string[];
  readonly #piBin: string;
  readonly #piEnv: Record<string, string>;
  #lastUpload = 0;
  #uploading: Promise<void> | undefined;

  constructor(opts: {
    file: string;
    key: string;
    store: Store;
    secrets: () => string[];
    piBin: string;
    piEnv: Record<string, string>;
    staging: string;
  }) {
    this.file = opts.file;
    this.#staging = opts.staging;
    this.key = opts.key;
    this.#store = opts.store;
    this.#secrets = opts.secrets;
    this.#piBin = opts.piBin;
    this.#piEnv = opts.piEnv;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  /** Puts a saved session in place so Pi continues it. Returns false when there is none. */
  async restore(): Promise<boolean> {
    const saved = await this.#store.bytes(`${this.key}.jsonl`).catch(() => undefined);
    if (!saved) return false;
    writeFresh(this.file, saved, 0o600);
    return true;
  }

  /** Uploads at most every 30 s while the station runs. */
  tick(): void {
    if (this.#uploading || Date.now() - this.#lastUpload < THROTTLE_MS) return;
    this.#uploading = this.#upload(false)
      .catch((error) => console.error(JSON.stringify({ kind: "session.upload_failed", key: this.key, error: (error as Error).message })))
      .finally(() => {
        this.#uploading = undefined;
      });
  }

  /** Final upload with the HTML export. */
  async finish(): Promise<void> {
    await this.#uploading;
    await this.#upload(true);
  }

  async #upload(withHtml: boolean): Promise<void> {
    const raw = readAgentFile(this.file);
    if (raw === undefined) return;
    this.#lastUpload = Date.now();
    const clean = redact(raw, this.#secrets());
    await this.#store.put(`${this.key}.jsonl`, clean, "application/x-ndjson");
    if (!withHtml) return;
    // Export the redacted copy, so the HTML cannot contain what the JSONL no longer does. The export
    // happens in a root-owned directory: nothing the agent controls is written to or followed.
    const dir = join(this.#staging, basename(this.file, ".jsonl"));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const redacted = join(dir, "redacted.jsonl");
    const html = join(dir, "session.html");
    writeFileSync(redacted, clean);
    const exported = exec(this.#piBin, ["--export", redacted, html], { env: this.#piEnv, timeoutMs: 120_000 });
    if (exported.code === 0 && existsSync(html)) {
      await this.#store.put(`${this.key}.html`, redact(readFileSync(html, "utf8"), this.#secrets()), "text/html");
    } else {
      console.error(JSON.stringify({ kind: "session.export_failed", key: this.key, output: exported.output.slice(-300) }));
    }
  }
}
