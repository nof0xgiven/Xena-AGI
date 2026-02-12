import { NativeConnection, Worker } from "@temporalio/worker";
import { loadWorkerEnv } from "../env.js";
import { logger } from "../logger.js";
import * as activities from "./activities/index.js";
import { fileURLToPath } from "node:url";

async function main() {
  const env = loadWorkerEnv();

  const connection = await NativeConnection.connect({
    address: env.TEMPORAL_ADDRESS,
  });

  // file URL path can contain percent-encoding (e.g. spaces -> %20); Temporal expects a real fs path.
  const workflowsPath = fileURLToPath(new URL("./workflows/index.js", import.meta.url));

  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    workflowsPath,
    activities,
  });

  logger.info(
    {
      temporalAddress: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowsPath,
    },
    "Temporal worker starting",
  );

  await worker.run();
}

main().catch((err) => {
  logger.error({ err }, "Temporal worker failed");
  process.exitCode = 1;
});
