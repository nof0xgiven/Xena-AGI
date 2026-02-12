import type { TicketArgs } from "../shared.js";
import { operatorWorkflow } from "./operatorWorkflow.js";

// Compatibility entrypoint retained for existing workflow name references.
// Operator-first runtime now owns ticket orchestration.
export async function ticketWorkflowV2(args: TicketArgs): Promise<void> {
  await operatorWorkflow(args);
}
