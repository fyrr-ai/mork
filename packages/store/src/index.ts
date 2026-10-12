// The Mork bucket: one S3 bucket for every task's outputs.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export class Store {
  readonly #s3: S3Client;
  readonly bucket: string;

  constructor(bucket: string, s3 = new S3Client({})) {
    this.bucket = bucket;
    this.#s3 = s3;
  }

  static fromEnv(env: NodeJS.ProcessEnv): Store {
    const bucket = env.MORK_BUCKET;
    if (!bucket) throw new Error("MORK_BUCKET is required");
    return new Store(bucket);
  }

  async put(key: string, body: string | Uint8Array, contentType = "application/json"): Promise<string> {
    await this.#s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return key;
  }

  putJson(key: string, value: unknown): Promise<string> {
    return this.put(key, JSON.stringify(value));
  }

  /** Compare-and-update JSON. The synchronous updater may run again after contention. */
  async updateJson(key: string, update: (current: unknown | undefined) => unknown): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      let current: unknown;
      let etag: string | undefined;
      try {
        const object = await this.#s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        etag = object.ETag;
        if (!etag) throw new Error(`S3 returned no ETag for ${key}`);
        current = JSON.parse(await (object.Body as { transformToString(): Promise<string> }).transformToString());
      } catch (error) {
        if ((error as { name?: string }).name !== "NoSuchKey") throw error;
      }
      const next = update(current);
      if (etag && next === current) return key;
      try {
        await this.#s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: JSON.stringify(next),
            ContentType: "application/json",
            ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
          }),
        );
        return key;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 409 && status !== 412) throw error;
      }
    }
    throw new Error(`Concurrent updates to ${key} did not converge`);
  }

  /** Writes `key` only if it does not exist yet (S3 conditional write); false when someone else got there first. */
  async claim(key: string, value: unknown): Promise<boolean> {
    try {
      await this.#s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: JSON.stringify(value), ContentType: "application/json", IfNoneMatch: "*" }),
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      // 409 does not establish that a winner's object exists. Keep it retryable
      // instead of letting callers mistake an uncreated claim for a duplicate.
      if (status === 412) return false;
      throw error;
    }
  }

  async bytes(key: string): Promise<Buffer> {
    const object = await this.#s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await (object.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  }

  async text(key: string): Promise<string> {
    return (await this.bytes(key)).toString("utf8");
  }

  async json(key: string): Promise<unknown> {
    return JSON.parse(await this.text(key));
  }
}
