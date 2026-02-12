export type MatrixFailure<StrategyId extends string, Family extends string, ErrorKind extends string> = {
  strategyId: StrategyId;
  family: Family;
  toolId: string;
  errorKind: ErrorKind;
  errorMessage: string;
};

export function uniquePreserveOrder(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export function countFamilyAttempts<StrategyId extends string, Family extends string, ErrorKind extends string>(
  attempts: readonly MatrixFailure<StrategyId, Family, ErrorKind>[],
  family: Family,
): number {
  let count = 0;
  for (const attempt of attempts) {
    if (attempt.family === family) count += 1;
  }
  return count;
}

export function countStrategyAttempts<StrategyId extends string, Family extends string, ErrorKind extends string>(
  attempts: readonly MatrixFailure<StrategyId, Family, ErrorKind>[],
  strategyId: StrategyId,
): number {
  let count = 0;
  for (const attempt of attempts) {
    if (attempt.strategyId === strategyId) count += 1;
  }
  return count;
}

export function formatFailures<StrategyId extends string, Family extends string, ErrorKind extends string>(
  attempts: readonly MatrixFailure<StrategyId, Family, ErrorKind>[],
): string {
  return attempts
    .map(
      (attempt, index) =>
        `${index + 1}. strategy=${attempt.strategyId} family=${attempt.family} tool=${attempt.toolId} error_kind=${attempt.errorKind}\n${attempt.errorMessage}`,
    )
    .join("\n\n");
}

export function selectNextStrategy<StrategyId extends string, Family extends string, ErrorKind extends string>(opts: {
  attempts: readonly MatrixFailure<StrategyId, Family, ErrorKind>[];
  currentStrategy: StrategyId;
  currentFamily: Family;
  matrixCandidates: readonly StrategyId[];
  strategyFamilyFor: (strategyId: StrategyId) => Family;
  maxAttemptsPerFamily: number;
  forceFamilySwitchErrorKinds: readonly ErrorKind[];
  lastErrorKind: ErrorKind;
  fallbackOrder: readonly StrategyId[];
  fallbackOrderOnFamilySwitch?: readonly StrategyId[];
  allowSingleRetryOnNonzeroExit?: boolean;
  nonzeroExitErrorKind?: ErrorKind;
}): { nextStrategyId: StrategyId | null; reason: string } {
  const sameFamilyAttempts = countFamilyAttempts(opts.attempts, opts.currentFamily);
  const enoughIsEnough =
    sameFamilyAttempts >= opts.maxAttemptsPerFamily ||
    opts.forceFamilySwitchErrorKinds.includes(opts.lastErrorKind);

  if (
    opts.allowSingleRetryOnNonzeroExit &&
    opts.nonzeroExitErrorKind !== undefined &&
    !enoughIsEnough &&
    opts.lastErrorKind === opts.nonzeroExitErrorKind
  ) {
    const currentStrategyAttempts = countStrategyAttempts(opts.attempts, opts.currentStrategy);
    if (currentStrategyAttempts < 2) {
      return {
        nextStrategyId: opts.currentStrategy,
        reason: `Retrying ${opts.currentStrategy} once after ${opts.nonzeroExitErrorKind}.`,
      };
    }
  }

  const sameFamily = opts.matrixCandidates.filter((id) => opts.strategyFamilyFor(id) === opts.currentFamily);
  const otherFamily = opts.matrixCandidates.filter((id) => opts.strategyFamilyFor(id) !== opts.currentFamily);
  const orderedByMatrix = enoughIsEnough ? [...otherFamily, ...sameFamily] : [...sameFamily, ...otherFamily];

  const attemptedStrategyIds = opts.attempts.map((attempt) => attempt.strategyId);
  for (const strategyId of orderedByMatrix) {
    if (!attemptedStrategyIds.includes(strategyId)) {
      const reason = enoughIsEnough
        ? `Enough-is-enough triggered for ${opts.currentFamily} after error_kind=${opts.lastErrorKind}; switching family.`
        : `Matrix selected next strategy for error_kind=${opts.lastErrorKind}.`;
      return { nextStrategyId: strategyId, reason };
    }
  }

  const fallbackOrder = enoughIsEnough ? opts.fallbackOrderOnFamilySwitch ?? opts.fallbackOrder : opts.fallbackOrder;
  for (const strategyId of fallbackOrder) {
    if (!attemptedStrategyIds.includes(strategyId)) {
      return {
        nextStrategyId: strategyId,
        reason: `Matrix had no unused candidate; selected fallback strategy ${strategyId}.`,
      };
    }
  }

  return {
    nextStrategyId: null,
    reason: `No strategy remains after ${opts.attempts.length} attempt(s).`,
  };
}
