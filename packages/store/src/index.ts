// The Mork bucket: one S3 bucket for every task's outputs.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export class Store {
  readonly #s3 = new S3Client({});
  readonly bucket: string;

  constructor(bucket: string) {
    this.bucket = bucket;
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

  /** Writes `key` only if it does not exist yet (S3 conditional write); false when someone else got there first. */
  async claim(key: string, value: unknown): Promise<boolean> {
    try {
      await this.#s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: JSON.stringify(value), ContentType: "application/json", IfNoneMatch: "*" }),
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 412 || status === 409) return false;
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
