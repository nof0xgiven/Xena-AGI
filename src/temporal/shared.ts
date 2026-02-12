export type TaskType = "discover" | "plan" | "code";

export type LinearWebhookPayload = {
  type: string;
  action: string;
  data?: unknown;
  createdAt?: string;
  updatedAt?: string;
};

export type IssueRef = {
  id: string;
  identifier: string;
  teamKey: string;
};

export type ProjectRef = {
  projectKey: string;
  linearTeamKey: string;
  repoPath: string;
  worktreesRoot: string;
  cloneEnvScriptPath: string;
};

export type DiscoverArgs = {
  issueId: string;
  project: ProjectRef;
  playbookId?: string;
};

export type PlanArgs = {
  issueId: string;
  project: ProjectRef;
  playbookId?: string;
};

export type CodeArgs = {
  issueId: string;
  project: ProjectRef;
  playbookId?: string;
};

export type WorkflowArgs = DiscoverArgs | PlanArgs | CodeArgs;

export type CodeWorkflowResult =
  | {
      ok: true;
      issueIdentifier: string;
      worktreePath: string;
      branchName: string;
      review: string;
      reviewAttempts: number;
    }
  | {
      ok: false;
      issueIdentifier: string;
      reason: string;
      review?: string;
      reviewAttempts?: number;
      worktreePath?: string;
      branchName?: string;
    };

export type TicketArgs = {
  issueId: string;
  project: ProjectRef;
  startMode?: "normal" | "evaluate_only";
  playbookId?: string;
};

export type LinearCommentSignal = {
  deliveryId?: string;
  issueId: string;
  commentId: string;
  body: string;
  authorId?: string | null;
  createdAt?: string;
};

export type TicketWakeSignal = {
  deliveryId?: string;
  issueId: string;
};

export type GithubPrSignal = {
  deliveryId?: string;
  issueId: string;
  action: string;
  repositoryFullName: string;
  prNumber: number;
  prUrl: string;
  branchName: string;
  prTitle: string;
  prBody?: string | null;
  merged?: boolean;
};

export type AgentmailEventAttachment = {
  attachmentId: string;
  filename?: string;
  size?: number;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
};

export type AgentmailEventSignal = {
  deliveryId?: string;
  eventType: string;
  eventId?: string;
  inboxId?: string;
  messageId?: string;
  threadId?: string;
  fromEmail?: string;
  fromName?: string;
  fromRaw?: string;
  subject?: string;
  text?: string;
  html?: string;
  extractedText?: string;
  extractedHtml?: string;
  attachments?: AgentmailEventAttachment[];
  replyToEmails?: string[];
  toEmails?: string[];
  ccEmails?: string[];
  receivedAt?: string;
};

export type ManusEventAttachment = {
  fileName: string;
  url: string;
  sizeBytes?: number;
};

export type ManusEventSignal = {
  deliveryId?: string;
  eventType: string;
  eventId?: string;
  taskId?: string;
  taskTitle?: string;
  taskUrl?: string;
  stopReason?: "finish" | "ask" | string;
  message?: string;
  attachments?: ManusEventAttachment[];
  receivedAt?: string;
};
