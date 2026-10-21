// 本地类型定义（对齐 opencode v2 API，同时保留桥接依赖的兼容字段）
// v2 的 Session 通过 location.directory 表达工作目录，这里映射为 bridge 常用的 directory。

export interface SessionTime {
  created: number;
  updated: number;
  idle?: number;
  viewed?: number;
  archived?: number;
}

export interface SessionModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface SessionTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface Session {
  id: string;
  projectID?: string;
  parentID?: string;
  agent?: string;
  model?: SessionModelRef | null;
  cost?: number;
  tokens?: SessionTokenUsage;
  time: SessionTime;
  title?: string;
  subpath?: string;
  // 兼容字段：来自 v2 location.directory
  directory?: string;
  location?: { directory: string; workspaceID?: string };
  [key: string]: unknown;
}

export interface PartText {
  type: 'text';
  id?: string;
  sessionID?: string;
  messageID?: string;
  text: string;
}

export interface PartReasoning {
  type: 'reasoning';
  id?: string;
  sessionID?: string;
  messageID?: string;
  text: string;
}

export interface PartTool {
  type: 'tool';
  id?: string;
  sessionID?: string;
  messageID?: string;
  callID?: string;
  tool?: string;
  state?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

export interface PartFile {
  type: 'file';
  id?: string;
  sessionID?: string;
  messageID?: string;
  uri?: string;
  mime?: string;
  name?: string;
}

// 通用 Part：兼容未知子类型
export type Part = PartText | PartReasoning | PartTool | PartFile | (Record<string, unknown> & { type: string });

export interface Message {
  id: string;
  sessionID?: string;
  role?: string;
  type?: string;
  time?: { created: number; completed?: number; streamed?: number };
  text?: string;
  content?: Part[];
  payload?: Record<string, unknown>;
  error?: unknown;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  // 兼容字段：来自 v2 canonical
  worktree?: string;
  canonical?: string;
  vcs?: string;
  name?: string;
  icon?: string;
  commands?: unknown[];
  time?: { created: number; updated: number };
  sandboxes?: string[];
  [key: string]: unknown;
}

export interface ProviderModel {
  id: string;
  name: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: ProviderModel[];
  [key: string]: unknown;
}

export function normalizeSession(session: Record<string, unknown> | null | undefined): Session | null {
  if (!session || typeof session !== 'object') return null;
  const record = session as Record<string, unknown>;
  const location = toObject(record.location);
  const directory = typeof record.directory === 'string' && record.directory.trim()
    ? record.directory.trim()
    : typeof location?.directory === 'string'
      ? location.directory
      : undefined;
  const result: Session = {
    ...record,
    id: typeof record.id === 'string' ? record.id : '',
    time: (record.time || {}) as SessionTime,
  };
  if (directory) result.directory = directory;
  if (location) result.location = location as Session['location'];
  return result;
}

export function normalizeProject(project: Record<string, unknown> | null | undefined): Project | null {
  if (!project || typeof project !== 'object') return null;
  const record = project as Record<string, unknown>;
  const result: Project = { ...record, id: typeof record.id === 'string' ? record.id : '' };
  const canonical = typeof record.canonical === 'string' ? record.canonical : undefined;
  if (canonical) {
    result.worktree = canonical;
    result.canonical = canonical;
  }
  if (!result.time) {
    result.time = { created: Date.now(), updated: Date.now() };
  }
  return result;
}

function toObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}