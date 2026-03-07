import { describe, expect, it } from "vitest";

import {
  DEFAULT_STRUCTURE_POLICY,
  analyzeSourceFile,
  countExports
} from "../../../scripts/quality/structure-lib.js";

describe("structure check", () => {
  it("flags production files that exceed the default line limit", () => {
    const issues = analyzeSourceFile({
      filePath: "src/runtime/example.ts",
      policy: DEFAULT_STRUCTURE_POLICY,
      sourceText: "const value = 1;\n".repeat(401)
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actual: 401,
          kind: "line_count",
          limit: 400
        })
      ])
    );
  });

  it("applies per-file line overrides", () => {
    const issues = analyzeSourceFile({
      filePath: "src/persistence/repositories/durable-store.ts",
      policy: DEFAULT_STRUCTURE_POLICY,
      sourceText: "const value = 1;\n".repeat(1109)
    });

    expect(issues).toEqual([]);
  });

  it("counts exported symbols from declarations and export lists", () => {
    const exportCount = countExports(`
      export const alpha = 1;
      const beta = 2;
      const gamma = 3;
      export { beta, gamma };
      export default function main() {
        return alpha + beta + gamma;
      }
    `);

    expect(exportCount).toBe(4);
  });

  it("flags files with too many exported symbols", () => {
    const issues = analyzeSourceFile({
      filePath: "src/contracts/example.ts",
      policy: DEFAULT_STRUCTURE_POLICY,
      sourceText: Array.from({ length: 13 }, (_, index) => `export const value${String(index)} = ${String(index)};`).join("\n")
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actual: 13,
          kind: "export_count",
          limit: 12
        })
      ])
    );
  });
});
