import { Client, Connection } from "@temporalio/client";
import type { TemporalEnv } from "../env.js";

export async function createTemporalClient(env: TemporalEnv): Promise<Client> {
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });
  const client = new Client({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
  });

  try {
    await client.workflowService.describeNamespace({
      namespace: env.TEMPORAL_NAMESPACE,
    });
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    throw new Error(
      `Temporal namespace "${env.TEMPORAL_NAMESPACE}" is not available (address ${env.TEMPORAL_ADDRESS}).\n` +
        `Create it with:\n` +
        `  temporal operator namespace create --address 127.0.0.1:7233 --namespace ${env.TEMPORAL_NAMESPACE}\n\n` +
        `Original error: ${msg}`,
    );
  }

  return client;
}
