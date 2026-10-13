// DynamoDB-backed timeline store (table configured by MORK_TIMELINE_TABLE).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { TimelineItem, TimelineStore } from "./index.ts";

export class DynamoStore implements TimelineStore {
  readonly #db: DynamoDBDocumentClient;
  readonly #table: string;

  constructor(table: string, client = new DynamoDBClient({})) {
    this.#table = table;
    this.#db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true } });
  }

  static fromEnv(env: NodeJS.ProcessEnv): DynamoStore {
    const table = env.MORK_TIMELINE_TABLE;
    if (!table) throw new Error("MORK_TIMELINE_TABLE is required");
    return new DynamoStore(table);
  }

  async put(item: TimelineItem): Promise<void> {
    await this.#db.send(new PutCommand({ TableName: this.#table, Item: item }));
  }

  async get(pk: string, sk: string): Promise<TimelineItem | undefined> {
    const out = await this.#db.send(new GetCommand({ TableName: this.#table, Key: { pk, sk } }));
    return out.Item as TimelineItem | undefined;
  }

  async *scan(): AsyncIterable<TimelineItem> {
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.#db.send(new ScanCommand({ TableName: this.#table, ExclusiveStartKey: start }));
      yield* (out.Items ?? []) as TimelineItem[];
      start = out.LastEvaluatedKey;
    } while (start);
  }
}
