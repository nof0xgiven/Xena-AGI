import { z } from "@hono/zod-openapi";

export const TaskRequestSchema = z.object({
  agent_id: z.string().min(1).openapi({
    example: "agent_html_page_builder"
  }),
  business_id: z.string().min(1).default("demo_business").openapi({
    example: "demo_business"
  }),
  idempotency_key: z.string().min(1).optional().openapi({
    example: "hello-world-demo"
  }),
  message: z.string().min(1).openapi({
    example: "Create hello world html page"
  }),
  project_id: z.string().min(1).default("demo_project").openapi({
    example: "demo_project"
  }),
  source_ref: z.string().min(1).nullable().optional(),
  title: z.string().min(1).openapi({
    example: "Hello World HTML"
  })
});

export const TaskAcceptedSchema = z.object({
  ingress_id: z.string(),
  proof_url: z.url().nullable(),
  run_id: z.string().nullable(),
  task_id: z.string(),
  webhook_status: z.number().int()
});

export const TaskProofSchema = z.object({
  agent: z.unknown().nullable(),
  api_input: z.unknown().nullable(),
  artifacts: z.array(z.unknown()),
  context_bundle: z.unknown().nullable(),
  events: z.array(z.unknown()),
  memory_records: z.array(z.unknown()),
  prompt: z.string().nullable(),
  result: z.unknown().nullable(),
  runs: z.array(z.unknown()),
  task: z.unknown(),
  tool_executions: z.array(z.unknown()),
  tool_registry: z.array(z.unknown())
});
