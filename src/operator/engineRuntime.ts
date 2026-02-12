import type {
  EngineStage,
  EngineTransitionMetadata,
  EngineTransitionRecord,
} from "./types.js";

export type AppendEngineTransitionInput = {
  to: EngineStage;
  rationale: string;
  metadata?: EngineTransitionMetadata;
  occurredAt?: string;
};

export function appendEngineTransition(
  history: EngineTransitionRecord[],
  input: AppendEngineTransitionInput,
): EngineTransitionRecord {
  const from = history.length > 0 ? history[history.length - 1]!.to : null;
  const transition: EngineTransitionRecord = {
    from,
    to: input.to,
    rationale: input.rationale,
    occurredAt: input.occurredAt ?? new Date(Date.now()).toISOString(),
    metadata: input.metadata,
  };
  history.push(transition);
  return transition;
}

