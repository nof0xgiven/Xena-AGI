import { buildExecutionPlan } from "../../operator/kernel.js";
import type { BuildExecutionPlanInput } from "../../operator/kernel.js";
import type { ExecutionPlan } from "../../operator/types.js";
import { loadRegistryBundle } from "../../registry/loader.js";

export type RegistryBuildExecutionPlanInput = Omit<BuildExecutionPlanInput, "registry"> & {
  registryBaseDir?: string;
};

export async function registryBuildExecutionPlan(
  opts: RegistryBuildExecutionPlanInput,
): Promise<ExecutionPlan> {
  const registry = await loadRegistryBundle({
    baseDir: opts.registryBaseDir,
    requireFiles: true,
  });

  return buildExecutionPlan({
    ...opts,
    registry,
  });
}
