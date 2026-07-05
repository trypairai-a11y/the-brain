import { describe, expect, it } from "vitest";
import { detectSignals, operations } from "../ops/operations.js";

/**
 * Contract invariants. These pin the shape of the ops registry so a refactor
 * can't silently drop an operation, change a scope, or ship an example that
 * its own params schema rejects.
 */

const EXPECTED = {
  read: [
    "query",
    "get_entity",
    "list_entities",
    "graph_query",
    "timeline",
    "daily_briefing",
    "health",
  ],
  write: [
    "ingest_conversation",
    "upsert_entity",
    "capture",
    "link_entities",
    "log_event",
    "set_status",
  ],
  admin: ["schema", "reindex"],
};

describe("ops contract", () => {
  it("exposes exactly the 15 contracted operations", () => {
    const names = Object.keys(operations).sort();
    const expected = [...EXPECTED.read, ...EXPECTED.write, ...EXPECTED.admin].sort();
    expect(names).toEqual(expected);
  });

  it("assigns the contracted scope to every operation", () => {
    for (const [scope, names] of Object.entries(EXPECTED)) {
      for (const name of names) {
        expect(operations[name]?.scope, `${name} scope`).toBe(scope);
      }
    }
  });

  it("registry keys match op names and every op has a description", () => {
    for (const [key, op] of Object.entries(operations)) {
      expect(op.name).toBe(key);
      expect(op.description.length).toBeGreaterThan(20);
    }
  });

  it("every example passes its own params schema (placeholder uuids substituted)", () => {
    const uuid = "00000000-0000-4000-8000-000000000000";
    for (const op of Object.values(operations)) {
      const example = JSON.parse(JSON.stringify(op.example).replace(/<[a-z-]+uuid>/g, uuid));
      const parsed = op.params.safeParse(example);
      expect(
        parsed.success,
        `${op.name} example: ${parsed.success ? "" : parsed.error.message}`,
      ).toBe(true);
    }
  });

  it("rejects unknown status values and oversized limits", () => {
    expect(operations.list_entities!.params.safeParse({ type: "x", status: "bogus" }).success).toBe(
      false,
    );
    expect(operations.query!.params.safeParse({ question: "x", limit: 9999 }).success).toBe(false);
  });
});

describe("signal detection", () => {
  it("detects Arabic complaint and churn keywords", () => {
    expect(detectSignals("الكود ما اشتغل عندي")).toContain("complaint");
    expect(detectSignals("ابي الغاء الاشتراك")).toContain("churn_risk");
  });

  it("detects English sales intent", () => {
    expect(detectSignals("how much is the monthly plan?")).toContain("sales_intent");
  });

  it("returns empty for neutral text", () => {
    expect(detectSignals("شكرا جزيلا")).toEqual([]);
  });
});
