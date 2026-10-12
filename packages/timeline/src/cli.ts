// mise run timeline:export -- <point>   → jevcal JSONL on stdout
// Points: triage, criteria, recommendation, supervision.
import { DynamoStore } from "./dynamo.ts";
import { type DecisionPoint, exportJevcal } from "./index.ts";

const POINTS: DecisionPoint[] = ["triage", "criteria", "recommendation", "supervision"];
const point = process.argv[2] as DecisionPoint;
if (!POINTS.includes(point)) {
  console.error(`usage: timeline:export -- <${POINTS.join("|")}>`);
  process.exit(2);
}
const rows = await exportJevcal(new DynamoStore(process.env.MORK_TIMELINE_TABLE ?? "mork-timeline-test"), point);
for (const row of rows) console.log(JSON.stringify(row));
console.error(`${rows.length} rows, ${rows.filter((r) => Object.keys(r.labels).length).length} labelled`);
