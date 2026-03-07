import { AgentInvocationPayloadSchema } from "../contracts/index.js";
import type { JsonValue } from "../persistence/repositories/durable-store.js";
import type {
  RuntimeToolArtifact,
  RuntimeToolContext,
  RuntimeToolDefinition
} from "./tool-registry.js";

type ProviderExecuteInput = {
  invocation: unknown;
  runtimeTools?: RuntimeToolDefinition[];
  toolContext?: RuntimeToolContext;
};

export type ProviderExecutionSuccess = {
  toolExecutions?: {
    artifacts?: RuntimeToolArtifact[];
    input: JsonValue;
    output: JsonValue;
    recordedAt: string;
    toolName: string;
    trace: JsonValue;
  }[];
  result: unknown;
  tokenUsage?: JsonValue;
  costEstimate?: number | null;
  rawResponse?: JsonValue;
};

export type AgentProvider = {
  readonly name: string;
  execute(input: ProviderExecuteInput): Promise<ProviderExecutionSuccess>;
};

export class ProviderExecutionError extends Error {
  readonly classification: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { classification: string; retryable: boolean }
  ) {
    super(message);
    this.name = "ProviderExecutionError";
    this.classification = options.classification;
    this.retryable = options.retryable;
  }
}

export class ProviderTimeoutError extends ProviderExecutionError {
  constructor(message: string) {
    super(message, {
      classification: "provider_timeout",
      retryable: true
    });
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderAuthError extends ProviderExecutionError {
  constructor(message: string) {
    super(message, {
      classification: "provider_auth",
      retryable: false
    });
    this.name = "ProviderAuthError";
  }
}

export class ProviderMalformedResponseError extends ProviderExecutionError {
  constructor(message: string) {
    super(message, {
      classification: "provider_malformed_response",
      retryable: false
    });
    this.name = "ProviderMalformedResponseError";
  }
}

type OpenAIResponsesProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

function hasContentArray(value: unknown): value is { content: unknown[] } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { content?: unknown };

  return Array.isArray(candidate.content);
}

function hasText(value: unknown): value is { text: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { text?: unknown };

  return typeof candidate.text === "string";
}

function extractFunctionCalls(response: Record<string, unknown>): {
  arguments: string;
  callId: string;
  name: string;
}[] {
  const output = response.output;

  if (!Array.isArray(output)) {
    return [];
  }

  return output.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }

    const candidate = item as {
      arguments?: unknown;
      call_id?: unknown;
      name?: unknown;
      type?: unknown;
    };

    if (
      candidate.type !== "function_call" ||
      typeof candidate.call_id !== "string" ||
      typeof candidate.name !== "string"
    ) {
      return [];
    }

    return [
      {
        arguments:
          typeof candidate.arguments === "string" ? candidate.arguments : "{}",
        callId: candidate.call_id,
        name: candidate.name
      }
    ];
  });
}

function extractOutputText(response: Record<string, unknown>): string {
  const outputText = response.output_text;

  if (typeof outputText === "string" && outputText.length > 0) {
    return outputText;
  }

  const output = response.output;

  if (!Array.isArray(output)) {
    throw new ProviderMalformedResponseError(
      "OpenAI response did not include a usable output payload"
    );
  }

  const textChunks = output.flatMap((item) => {
    if (!hasContentArray(item)) {
      return [];
    }

    return item.content.flatMap((contentItem: unknown) => {
      if (!hasText(contentItem)) {
        return [];
      }

      return [contentItem.text];
    });
  });

  if (textChunks.length === 0) {
    throw new ProviderMalformedResponseError(
      "OpenAI response did not include any text output"
    );
  }

  return textChunks.join("\n");
}

function normalizeUsage(response: Record<string, unknown>): JsonValue {
  const usage = response.usage;

  if (typeof usage !== "object" || usage === null) {
    return null;
  }

  return usage as JsonValue;
}

function classifyHttpError(
  status: number,
  bodyText: string
): ProviderExecutionError {
  if (status === 401 || status === 403) {
    return new ProviderAuthError(bodyText || "OpenAI authentication failed");
  }

  if (status === 408) {
    return new ProviderTimeoutError(bodyText || "OpenAI request timed out");
  }

  if (status === 429 || status >= 500) {
    return new ProviderExecutionError(
      bodyText || `OpenAI temporarily unavailable (${String(status)})`,
      {
        classification: "provider_unavailable",
        retryable: true
      }
    );
  }

  return new ProviderExecutionError(
    bodyText || `OpenAI request failed with status ${String(status)}`,
    {
      classification: "provider_bad_request",
      retryable: false
    }
  );
}

export function classifyProviderError(error: unknown): {
  classification: string;
  retryable: boolean;
} {
  if (error instanceof ProviderExecutionError) {
    return {
      classification: error.classification,
      retryable: error.retryable
    };
  }

  return {
    classification: "provider_execution_failed",
    retryable: false
  };
}

export class OpenAIResponsesProvider implements AgentProvider {
  readonly name = "openai";

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;

  constructor(options: OpenAIResponsesProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(input: ProviderExecuteInput): Promise<ProviderExecutionSuccess> {
    const invocation = AgentInvocationPayloadSchema.parse(input.invocation);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, invocation.agent.timeout_ms);
    const prompt = invocation.prompt;
    const instructions =
      typeof prompt.instructions === "string"
        ? prompt.instructions
        : "Return a valid AgentResult JSON object.";
    const initialInput =
      "input" in prompt && prompt.input !== undefined
        ? prompt.input
        : JSON.stringify(
            {
              context_bundle: invocation.context_bundle,
              constraints: invocation.constraints,
              tool_registry: invocation.tool_registry
            },
            null,
            2
          );
    const runtimeToolMap = new Map(
      (input.runtimeTools ?? []).map((tool) => [tool.definition.name, tool])
    );
    const toolDefinitions = (input.runtimeTools ?? []).map((tool) => ({
      description: tool.definition.description,
      name: tool.definition.name,
      parameters: tool.definition.parameters,
      type: "function"
    }));
    const toolExecutions: ProviderExecutionSuccess["toolExecutions"] = [];
    let previousResponseId: string | undefined;
    let requestInput: unknown = initialInput;
    let toolCallCount = 0;

    try {
      for (;;) {
        const response = await this.#fetchImpl(`${this.#baseUrl}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ...(previousResponseId
              ? { previous_response_id: previousResponseId }
              : {}),
            input: requestInput,
            instructions,
            metadata: {
              agent_id: invocation.agent.agent_id,
              run_id: invocation.run_id,
              task_id: invocation.task_id
            },
            model: invocation.agent.model,
            tools: toolDefinitions
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw classifyHttpError(response.status, await response.text());
        }

        const payload = (await response.json()) as Record<string, unknown>;
        const functionCalls = extractFunctionCalls(payload);

        if (functionCalls.length > 0) {
          const toolContext = input.toolContext;

          if (!toolContext) {
            throw new ProviderExecutionError(
              "Tool execution requested without a runtime tool context",
              {
                classification: "tool_context_missing",
                retryable: false
              }
            );
          }

          toolCallCount += functionCalls.length;

          if (toolCallCount > invocation.agent.max_tool_calls) {
            throw new ProviderExecutionError(
              "Agent exceeded the maximum allowed tool calls",
              {
                classification: "tool_limit_exceeded",
                retryable: false
              }
            );
          }

          const toolOutputs = await Promise.all(
            functionCalls.map(async (functionCall) => {
              const runtimeTool = runtimeToolMap.get(functionCall.name);

              if (!runtimeTool) {
                throw new ProviderExecutionError(
                  `Tool ${functionCall.name} was requested but is not available`,
                  {
                    classification: "tool_not_available",
                    retryable: false
                  }
                );
              }

              let parsedArguments: Record<string, unknown>;

              try {
                parsedArguments = JSON.parse(functionCall.arguments) as Record<
                  string,
                  unknown
                >;
              } catch {
                throw new ProviderExecutionError(
                  `Tool ${functionCall.name} received invalid JSON arguments`,
                  {
                    classification: "tool_arguments_invalid",
                    retryable: false
                  }
                );
              }

              const toolResult = await runtimeTool.execute(
                parsedArguments,
                toolContext
              );

              const toolExecution = {
                input: parsedArguments as JsonValue,
                output: toolResult.output,
                recordedAt: toolResult.recordedAt,
                toolName: toolResult.toolName,
                trace: toolResult.trace
              } as {
                artifacts?: RuntimeToolArtifact[];
                input: JsonValue;
                output: JsonValue;
                recordedAt: string;
                toolName: string;
                trace: JsonValue;
              };

              if (toolResult.artifacts) {
                toolExecution.artifacts = toolResult.artifacts;
              }

              toolExecutions.push(toolExecution);

              return {
                call_id: functionCall.callId,
                output: JSON.stringify(toolResult.output),
                type: "function_call_output"
              };
            })
          );

          previousResponseId =
            typeof payload.id === "string" ? payload.id : previousResponseId;
          requestInput = toolOutputs;
          continue;
        }

        const text = extractOutputText(payload);
        let result: unknown;

        try {
          result = JSON.parse(text);
        } catch {
          throw new ProviderMalformedResponseError(
            "OpenAI did not return JSON AgentResult output"
          );
        }

        return {
          costEstimate: null,
          rawResponse: payload as JsonValue,
          result,
          tokenUsage: normalizeUsage(payload),
          toolExecutions
        };
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ProviderTimeoutError("OpenAI request timed out");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
