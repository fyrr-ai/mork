import { expect, test } from "bun:test";
import { OcrResult, ocrReview } from "./ocr.ts";

const result = OcrResult.parse({
  status: "complete",
  comments: [{ path: "math.mjs", start_line: 1, content: "Concatenates strings", existing_code: "return a + b;", severity: "high", category: "bug" }],
  summary: { total_tokens: 120 },
  tool_calls: { total: 4 },
  manifest: {
    input: { resolved_base: "a".repeat(40), resolved_head: "b".repeat(40) },
    coverage: { completed: [{ path: "math.mjs", item_id: "math" }], reused: [], failed: [] },
  },
});

test("OCR findings are claims awaiting verification, not automatically repairable P1s", () => {
  const review = ocrReview(result, [{ path: "math.mjs", added: 1, removed: 1 }]);
  expect(review.findings[0]).toMatchObject({ severity: "P1", verification: { status: "unknown" }, located: null });
  expect(review.unreviewed_files).toEqual([]);
});

test("partial coverage remains incomplete even with no comments", () => {
  const review = ocrReview(
    {
      ...result,
      status: "partial",
      comments: [],
      manifest: { ...result.manifest, coverage: { completed: [], reused: [], failed: [{ path: "math.mjs", item_id: "math" }] } },
    },
    [{ path: "math.mjs", added: 1, removed: 1 }],
  );
  expect(review.incomplete).toHaveLength(1);
  expect(review.unreviewed_files).toEqual(["math.mjs"]);
});

test("missing quotation cannot turn a reported line into checked evidence", () => {
  const review = ocrReview({ ...result, comments: result.comments.map((c) => ({ ...c, existing_code: "" })) }, []);
  expect(review.findings[0]?.quote).toBeTruthy();
  expect(review.findings[0]?.located).toBeNull();
});
