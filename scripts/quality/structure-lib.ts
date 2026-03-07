import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

export type StructureIssueKind = "export_count" | "line_count";

export type StructureIssue = {
  actual: number;
  filePath: string;
  kind: StructureIssueKind;
  limit: number;
};

type StructureOverride = {
  filePath: string;
  maxExportsPerFile?: number;
  maxLines?: number;
};

export type StructurePolicy = {
  maxExportsPerFile: number;
  productionMaxLines: number;
  testMaxLines: number;
  overrides: StructureOverride[];
};

export const DEFAULT_STRUCTURE_POLICY: StructurePolicy = {
  maxExportsPerFile: 12,
  overrides: [
    {
      filePath: "src/contracts/common.ts",
      maxExportsPerFile: 20
    },
    {
      filePath: "src/contracts/index.ts",
      maxExportsPerFile: 24
    },
    {
      filePath: "src/ingress/process-webhook.ts",
      maxLines: 450
    },
    {
      filePath: "src/persistence/repositories/durable-store.ts",
      maxLines: 1200
    },
    {
      filePath: "src/providers/openai-provider.ts",
      maxLines: 500
    }
  ],
  productionMaxLines: 400,
  testMaxLines: 550
};

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function findOverride(
  filePath: string,
  overrides: readonly StructureOverride[]
): StructureOverride | undefined {
  const normalizedPath = toPosix(filePath);

  return overrides.find((override) => toPosix(override.filePath) === normalizedPath);
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }

  return (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  );
}

export function countLines(sourceText: string): number {
  const normalized = sourceText.replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n")
    ? normalized.slice(0, normalized.length - 1)
    : normalized;

  if (trimmed.length === 0) {
    return 0;
  }

  return trimmed.split("\n").length;
}

export function countExports(sourceText: string): number {
  const sourceFile = ts.createSourceFile(
    "structure-check.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let exportCount = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isExportAssignment(node)) {
      exportCount += 1;
      return;
    }

    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        exportCount += node.exportClause.elements.length;
      } else {
        exportCount += 1;
      }

      return;
    }

    if (hasExportModifier(node)) {
      if (ts.isVariableStatement(node)) {
        exportCount += node.declarationList.declarations.length;
      } else {
        exportCount += 1;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  return exportCount;
}

export function analyzeSourceFile(input: {
  filePath: string;
  policy: StructurePolicy;
  sourceText: string;
}): StructureIssue[] {
  const normalizedPath = toPosix(input.filePath);
  const override = findOverride(normalizedPath, input.policy.overrides);
  const lineCount = countLines(input.sourceText);
  const exportCount = countExports(input.sourceText);
  const maxLines =
    override?.maxLines ??
    (normalizedPath.startsWith("tests/")
      ? input.policy.testMaxLines
      : input.policy.productionMaxLines);
  const maxExports = override?.maxExportsPerFile ?? input.policy.maxExportsPerFile;
  const issues: StructureIssue[] = [];

  if (lineCount > maxLines) {
    issues.push({
      actual: lineCount,
      filePath: normalizedPath,
      kind: "line_count",
      limit: maxLines
    });
  }

  if (!normalizedPath.startsWith("tests/") && exportCount > maxExports) {
    issues.push({
      actual: exportCount,
      filePath: normalizedPath,
      kind: "export_count",
      limit: maxExports
    });
  }

  return issues;
}

async function collectTsFiles(
  rootDir: string,
  directory: string
): Promise<string[]> {
  const entries = await readdir(path.join(rootDir, directory), {
    withFileTypes: true
  });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectTsFiles(rootDir, relativePath);
      }

      if (!entry.isFile() || !relativePath.endsWith(".ts")) {
        return [];
      }

      return [toPosix(relativePath)];
    })
  );

  return files.flat().sort();
}

export async function runStructureCheck(input: {
  policy?: StructurePolicy;
  rootDir?: string;
} = {}): Promise<StructureIssue[]> {
  const rootDir = input.rootDir ?? process.cwd();
  const policy = input.policy ?? DEFAULT_STRUCTURE_POLICY;
  const files = (
    await Promise.all(["scripts", "src", "tests"].map((directory) => collectTsFiles(rootDir, directory)))
  ).flat();
  const issues = await Promise.all(
    files.map(async (filePath) => {
      const sourceText = await readFile(path.join(rootDir, filePath), "utf8");

      return analyzeSourceFile({
        filePath,
        policy,
        sourceText
      });
    })
  );

  return issues.flat().sort((left, right) => {
    if (left.filePath === right.filePath) {
      return left.kind.localeCompare(right.kind);
    }

    return left.filePath.localeCompare(right.filePath);
  });
}

export function formatStructureIssues(issues: readonly StructureIssue[]): string {
  return issues
    .map((issue) => {
      const rule =
        issue.kind === "line_count" ? "max lines exceeded" : "max exports exceeded";

      return `${issue.filePath}: ${rule} (${String(issue.actual)} > ${String(issue.limit)})`;
    })
    .join("\n");
}
