type RequiredChildRef = {
  task_id: string;
};

export function evaluateRequiredChildren(
  requiredChildren: readonly RequiredChildRef[],
  taskStateById: ReadonlyMap<string, string | undefined>
): {
  requiredFailed: boolean;
  requiredSatisfied: boolean;
} {
  const requiredFailed = requiredChildren.some((child) => {
    const state = taskStateById.get(child.task_id);

    return state === "failed" || state === "blocked";
  });
  const requiredSatisfied = requiredChildren.every((child) => {
    const state = taskStateById.get(child.task_id);

    return state === "completed";
  });

  return {
    requiredFailed,
    requiredSatisfied
  };
}
