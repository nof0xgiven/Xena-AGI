import { AgentInvocationPayloadSchema } from "../contracts/index.js";
import type { JsonValue } from "../persistence/repositories/durable-store.js";

type ProviderExecuteInput = {
  invocation: unknown;
};

export type ProviderExecutionSuccess = {
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

  constructor(message: string, options: { classification: string; retryable: boolean }) {
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

function classifyHttpError(status: number, bodyText: string): ProviderExecutionError {
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
    const promptInput =
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

    try {
      const response = await this.#fetchImpl(`${this.#baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: invocation.agent.model,
          instructions,
          input: promptInput,
          metadata: {
            agent_id: invocation.agent.agent_id,
            run_id: invocation.run_id,
            task_id: invocation.task_id
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw classifyHttpError(response.status, await response.text());
      }

      const payload = (await response.json()) as Record<string, unknown>;
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
        tokenUsage: normalizeUsage(payload)
      };
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
