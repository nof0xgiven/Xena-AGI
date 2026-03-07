import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createObjectStore } from "../artifacts/object-store.js";
import type { JsonValue } from "../persistence/repositories/durable-store.js";
import type {
  RuntimeToolDefinition,
  RuntimeToolMap,
  RuntimeToolResult
} from "../providers/tool-registry.js";

type FilesystemToolOptions = {
  rootDir?: string;
};

function generatedDir(rootDir = process.cwd()): string {
  return path.join(rootDir, "artifacts/generated");
}

function normalizeRelativePath(relativePath: string): string {
  let candidate = relativePath.replace(/\\/g, "/");

  if (candidate.startsWith("./")) {
    candidate = candidate.slice(2);
  }

  if (candidate === "artifacts/generated") {
    throw new Error("Path must point to a file within artifacts/generated");
  }

  if (candidate.startsWith("artifacts/generated/")) {
    candidate = candidate.slice("artifacts/generated/".length);
  }

  const normalized = path.posix.normalize(candidate);

  if (
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".."
  ) {
    throw new Error("Path must stay within artifacts/generated");
  }

  return normalized;
}

function jsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function readStringField(
  input: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const value = input[key];

  return typeof value === "string" ? value : fallback;
}

export function serializeToolDefinitions(
  tools: RuntimeToolDefinition[]
): RuntimeToolDefinition["definition"][] {
  return tools.map((tool) => tool.definition);
}

export function createFilesystemTools(
  options: FilesystemToolOptions = {}
): RuntimeToolMap {
  const workspaceRoot = options.rootDir ?? process.cwd();
  const root = generatedDir(workspaceRoot);
  const objectStore = createObjectStore();

  return {
    Read: {
      definition: {
        description: "Read a file from artifacts/generated.",
        name: "Read",
        parameters: {
          additionalProperties: false,
          properties: {
            path: {
              type: "string"
            }
          },
          required: ["path"],
          type: "object"
        }
      },
      async execute(input): Promise<RuntimeToolResult> {
        const relativePath = normalizeRelativePath(readStringField(input, "path"));
        const absolutePath = path.join(root, relativePath);
        const content = await readFile(absolutePath, "utf8");

        return {
          output: jsonValue({
            content,
            path: `artifacts/generated/${relativePath}`
          }),
          recordedAt: new Date().toISOString(),
          toolName: "Read",
          trace: jsonValue({
            input,
            output: {
              path: `artifacts/generated/${relativePath}`,
              size: Buffer.byteLength(content, "utf8")
            }
          })
        };
      }
    },
    Write: {
      definition: {
        description:
          "Write a file into artifacts/generated and record it as a durable artifact.",
        name: "Write",
        parameters: {
          additionalProperties: false,
          properties: {
            content: {
              type: "string"
            },
            mime_type: {
              type: "string"
            },
            path: {
              type: "string"
            }
          },
          required: ["path", "content"],
          type: "object"
        }
      },
      async execute(input, context): Promise<RuntimeToolResult> {
        const relativePath = normalizeRelativePath(readStringField(input, "path"));
        const absolutePath = path.join(root, relativePath);
        const content = readStringField(input, "content");
        const mimeType =
          typeof input.mime_type === "string" && input.mime_type.length > 0
            ? input.mime_type
            : "text/html";

        await mkdir(path.dirname(absolutePath), {
          recursive: true
        });
        await writeFile(absolutePath, content, "utf8");

        await objectStore.ensureBucket();
        await objectStore.putText({
          contentType: mimeType,
          key: `generated/${relativePath}`,
          metadata: {
            run_id: context.runId,
            task_id: context.taskId
          },
          text: content
        });

        const artifactPath = `artifacts/generated/${relativePath}`;

        return {
          artifacts: [
            {
              artifact_id: `artifact_${randomUUID()}`,
              created_at: new Date().toISOString(),
              inline_payload: null,
              metadata: jsonValue({
                generated_by_tool: "Write",
                object_store_key: `generated/${relativePath}`,
                workspace_path: artifactPath
              }),
              mime_type: mimeType,
              name: path.basename(relativePath),
              path: artifactPath,
              run_id: context.runId,
              schema_version: "1.0",
              task_id: context.taskId,
              type: "file",
              uri: null
            }
          ],
          output: jsonValue({
            bytes_written: Buffer.byteLength(content, "utf8"),
            path: artifactPath
          }),
          recordedAt: new Date().toISOString(),
          toolName: "Write",
          trace: jsonValue({
            input,
            output: {
              path: artifactPath
            }
          })
        };
      }
    }
  };
}
