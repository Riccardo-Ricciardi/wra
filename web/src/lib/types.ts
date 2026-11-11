export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface Session {
  sessionId: string;
  name: string | null;
  projectPath: string;
  projectKey: string;
  mcpAllowed: boolean;
  mcpReachable: boolean;
  mcpBypassAt: string | null;
  permissionMode: PermissionMode;
  autoApprove: boolean | null;
  favorite: boolean;
  label: string | null;
  archived: boolean;
  imported: boolean;
  createdAt: string;
  lastActivityAt: string | null;
  state: 'running' | 'exited' | 'offline' | string;
  pid: number | null;
  cols: number;
  rows: number;
  transcript: string;
  busy: boolean;
}

export interface Project {
  key: string;
  path: string;
  realName: string;
  name: string;
  favorite: boolean;
  hidden: boolean;
  autoApprove: boolean;
  registered: boolean;
  createdAt: string | null;
  lastActivityAt: string | null;
  count: number;
  open: number;
  running: number;
}

export interface Approval {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  createdAt?: string;
  expiresAt?: string;
}

export interface ToolResult {
  text: string;
  truncated: boolean;
  isError: boolean;
  kind: string | null;
  filePath: string | null;
  patch?: { oldStart: number | null; newStart: number | null; lines: string[] }[];
  added?: number;
  removed?: number;
}

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; durationMs: number | null }
  | {
      kind: 'tool';
      id: string | null;
      name: string;
      input: unknown;
      inputTruncated: boolean;
      result: ToolResult | null;
      decision: { decision: string | null; source: string | null } | null;
    };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  at: string | null;
  model: string | null;
  parts: MessagePart[];
}

export interface SettingsPayload {
  saved: { defaultProject?: string; allowedRoots?: string[] };
  effective: {
    defaultProject: string;
    allowedRoots: string[];
    port: number;
    host: string;
    home: string;
    projectsRoot: string;
    claudeCmd: string;
    claudeArgs: number;
    platform: string;
    node: string;
  };
  restartNeeded: boolean;
}

export interface StatusPayload {
  ok: boolean;
  proto: number;
  mcp: boolean;
  sessions: Session[];
  mcpSelections: unknown[];
  turns: unknown;
  approvals: number;
  autoApprovals: number;
  journal: number;
  clients: { clients: number; sessions: number };
  oauth: { authorizationEndpoint: string; resource: string; host: string | null } | null;
}

export interface SessionsPayload {
  sessions: Session[];
  projects: Project[];
  selections: unknown[];
  approvals: Approval[];
  autoApprovals: unknown[];
}
