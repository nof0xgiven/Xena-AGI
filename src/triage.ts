import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

export type TaskType = "discover" | "plan" | "code";

const TriageSchema = z.object({
  taskType: z.enum(["discover", "plan", "code"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export async function triageNextTask(opts: {
  openaiModel: string;
  issueTitle: string;
  issueDescription: string | null;
  hasDiscovery: boolean;
  hasPlan: boolean;
}): Promise<z.infer<typeof TriageSchema>> {
  const sys = [
    "You are Xena, a minimal orchestrator. You do not execute work; you only decide which task to schedule next.",
    "Choose exactly one next task type: discover, plan, or code.",
    "Rules:",
    "- If there is no plan yet, do NOT choose code.",
    "- If the issue is underspecified or unclear, prefer discover.",
    "- If the issue is clear but complex, prefer plan.",
    "- Keep reason short and concrete.",
    "Output must be a JSON object matching the schema.",
  ].join("\n");

  const user = JSON.stringify(
    {
      issueTitle: opts.issueTitle,
      issueDescription: opts.issueDescription ?? "",
      hasDiscovery: opts.hasDiscovery,
      hasPlan: opts.hasPlan,
    },
    null,
    2,
  );

  const res = await generateObject({
    model: openai(opts.openaiModel),
    schema: TriageSchema,
    system: sys,
    prompt: user,
  });

  return res.object;
}
