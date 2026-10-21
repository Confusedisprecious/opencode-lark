// opencode v2 HTTP 客户端
// 直接调用 v2 API（/api/*），替代旧版 @opencode-ai/sdk。
// 对外保持与旧实现一致的方法签名和事件名，避免桥接其他模块大改。

import { opencodeConfig, modelConfig } from '../config.js';
import { EventEmitter } from 'events';
import type {
  Session,
  Message,
  Part,
  Project,
  ProviderInfo,
} from './types.js';
import { normalizeSession, normalizeProject } from './types.js';

// 权限请求事件类型
export interface PermissionRequestEvent {
  sessionId: string;
  permissionId: string;
  tool: string;
  description: string;
  risk?: string;
  parentSessionId?: string;
  relatedSessionId?: string;
  messageId?: string;
  callId?: string;
}

export interface PermissionResponseOptions {
  directory?: string;
  fallbackDirectories?: string[];
}

interface PermissionEventProperties {
  sessionID?: string;
  sessionId?: string;
  session_id?: string;
  id?: string;
  requestId?: string;
  requestID?: string;
  request_id?: string;
  permissionId?: string;
  permissionID?: string;
  permission_id?: string;
  tool?: unknown;
  permission?: unknown;
  description?: string;
  risk?: string;
  metadata?: Record<string, unknown>;
}

type PermissionCorrelation = {
  parentSessionId?: string;
  relatedSessionId?: string;
  messageId?: string;
  callId?: string;
};

type DirectoryEventStreamEntry = {
  controller: AbortController;
  active: boolean;
  reconnectTimer: NodeJS.Timeout | null;
};

function getPermissionLabel(props: PermissionEventProperties): string {
  if (typeof props.permission === 'string' && props.permission.trim()) {
    return props.permission;
  }

  if (typeof props.tool === 'string' && props.tool.trim()) {
    return props.tool;
  }

  if (props.tool && typeof props.tool === 'object') {
    const toolObj = props.tool as Record<string, unknown>;
    if (typeof toolObj.name === 'string' && toolObj.name.trim()) {
      return toolObj.name;
    }
  }

  return 'unknown';
}

function getFirstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getFirstStringFromRecord(record: Record<string, unknown> | undefined, keys: string[]): string {
  if (!record) {
    return '';
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function extractPermissionCorrelation(props: PermissionEventProperties): PermissionCorrelation {
  const propsRecord = props as Record<string, unknown>;
  const toolRecord = toRecord(props.tool);
  const metadataRecord = toRecord(props.metadata);

  const parentSessionId = getFirstString(
    getFirstStringFromRecord(propsRecord, ['parentSessionID', 'parentSessionId', 'parent_session_id']),
    getFirstStringFromRecord(toolRecord, ['parentSessionID', 'parentSessionId', 'parent_session_id']),
    getFirstStringFromRecord(metadataRecord, ['parentSessionID', 'parentSessionId', 'parent_session_id'])
  );

  const relatedSessionId = getFirstString(
    getFirstStringFromRecord(propsRecord, [
      'originSessionID',
      'originSessionId',
      'origin_session_id',
      'rootSessionID',
      'rootSessionId',
      'root_session_id',
      'sourceSessionID',
      'sourceSessionId',
      'source_session_id',
    ]),
    getFirstStringFromRecord(toolRecord, [
      'originSessionID',
      'originSessionId',
      'origin_session_id',
      'rootSessionID',
      'rootSessionId',
      'root_session_id',
      'sourceSessionID',
      'sourceSessionId',
      'source_session_id',
    ]),
    getFirstStringFromRecord(metadataRecord, [
      'originSessionID',
      'originSessionId',
      'origin_session_id',
      'rootSessionID',
      'rootSessionId',
      'root_session_id',
      'sourceSessionID',
      'sourceSessionId',
      'source_session_id',
    ])
  );

  const messageId = getFirstString(
    getFirstStringFromRecord(propsRecord, ['messageID', 'messageId', 'message_id']),
    getFirstStringFromRecord(toolRecord, ['messageID', 'messageId', 'message_id']),
    getFirstStringFromRecord(metadataRecord, ['messageID', 'messageId', 'message_id'])
  );

  const callId = getFirstString(
    getFirstStringFromRecord(propsRecord, ['callID', 'callId', 'call_id', 'toolCallID', 'toolCallId', 'tool_call_id']),
    getFirstStringFromRecord(toolRecord, ['callID', 'callId', 'call_id', 'toolCallID', 'toolCallId', 'tool_call_id']),
    getFirstStringFromRecord(metadataRecord, ['callID', 'callId', 'call_id', 'toolCallID', 'toolCallId', 'tool_call_id'])
  );

  return {
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(relatedSessionId ? { relatedSessionId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(callId ? { callId } : {}),
  };
}

function isPermissionRequestEventType(eventType: string): boolean {
  const normalized = eventType.toLowerCase();
  if (!normalized.includes('permission')) {
    return false;
  }

  if (
    normalized.includes('replied') ||
    normalized.includes('reply') ||
    normalized.includes('granted') ||
    normalized.includes('denied') ||
    normalized.includes('resolved')
  ) {
    return false;
  }

  return (
    normalized.includes('request') ||
    normalized.includes('asked') ||
    normalized.includes('require') ||
    normalized.includes('pending')
  );
}

function formatSdkError(error: unknown): string {
  if (!error) return '未知错误';

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }
    try {
      return JSON.stringify(record);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

// 消息部分类型
export interface MessagePart {
  type: string;
  text?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
}

export type AgentMode = 'primary' | 'subagent' | 'all';

export interface OpencodeAgentInfo {
  name: string;
  description?: string;
  mode?: AgentMode;
  hidden?: boolean;
  builtIn?: boolean;
  native?: boolean;
}

export interface OpencodeCommandInfo {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  template: string;
  subtask?: boolean;
  hints: string[];
}

export interface OpencodeAgentConfig {
  description?: string;
  mode?: AgentMode;
  prompt?: string;
  tools?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface OpencodeRuntimeConfig {
  agent?: Record<string, OpencodeAgentConfig>;
  [key: string]: unknown;
}

export interface ShellExecutionResult {
  info?: Message;
  parts: Part[];
}

export interface SessionQueryOptions {
  directory?: string;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return undefined;
}

function parseAgentMode(value: unknown): AgentMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'primary' || normalized === 'subagent' || normalized === 'all') {
    return normalized;
  }
  return undefined;
}

function buildOpencodeAuthorizationHeaderValue(): string | undefined {
  const password = opencodeConfig.serverPassword;
  if (!password) {
    return undefined;
  }

  const username = opencodeConfig.serverUsername || 'opencode';
  const encoded = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${encoded}`;
}

function withOpencodeAuthorizationHeaders(headers?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {
    ...(headers || {}),
  };
  const authorization = buildOpencodeAuthorizationHeaderValue();
  if (authorization) {
    merged.Authorization = authorization;
  }
  return merged;
}

function isUnauthorizedStatusCode(statusCode?: number): boolean {
  return statusCode === 401 || statusCode === 403;
}

function buildAuthEnvHint(): string {
  return '请检查 OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD 是否与 OpenCode 服务端一致';
}

function appendAuthHint(message: string, statusCode?: number): string {
  if (!isUnauthorizedStatusCode(statusCode)) {
    return message;
  }
  return `${message}；${buildAuthEnvHint()}`;
}

class OpencodeClientWrapper extends EventEmitter {
  private eventAbortController: AbortController | null = null;
  private eventReconnectTimer: NodeJS.Timeout | null = null;
  private eventReconnectAttempt = 0;
  private eventListeningEnabled = false;
  private eventStreamActive = false;
  private directoryEventStreams: Map<string, DirectoryEventStreamEntry> = new Map();
  // 防止并发调用 ensureDirectoryEventStream 对同一目录建立多条 SSE 连接
  private pendingDirectoryStreams: Map<string, Promise<void>> = new Map();

  // v2 form.id -> sessionID 映射（form.created 事件时记录，replyQuestion 使用）
  private formSessionByFormId: Map<string, string> = new Map();

  // 命令列表缓存（5 分钟 TTL）
  private commandsCache: OpencodeCommandInfo[] | null = null;
  private commandsCacheTimestamp: number = 0;
  private readonly COMMANDS_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

  // OpenCode 版本信息缓存
  private opencodeVersion: string | null = null;
  private versionChecked = false;

  constructor() {
    super();
  }

  // ───────────────────────── HTTP 基础 ─────────────────────────

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${opencodeConfig.baseUrl}${path}`;
    const headers = withOpencodeAuthorizationHeaders({
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init?.headers as Record<string, string>) || {}),
    });
    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      const status = response.status;
      const message = `HTTP ${status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
      const error = new Error(appendAuthHint(message, status)) as Error & { status?: number; statusCode?: number };
      error.status = status;
      throw error;
    }
    if (response.status === 204) {
      return undefined as unknown as T;
    }
    return (await response.json()) as T;
  }

  private async requestData<T>(path: string, init?: RequestInit): Promise<T> {
    const payload = await this.request<{ data?: T } | T[] | T>(path, init);
    if (Array.isArray(payload)) {
      return payload as T;
    }
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data;
    }
    return payload as T;
  }

  // ───────────────────────── 连接与事件流 ─────────────────────────

  // 连接到OpenCode服务器
  async connect(): Promise<boolean> {
    console.log(`[OpenCode] 正在连接到 ${opencodeConfig.baseUrl}...`);

    try {
      // v2：通过 /api/info 或 /api/session 检查服务器状态与认证
      await this.request<unknown>('/api/info');
      console.log('[OpenCode] 已连接');
      this.opencodeVersion = null;
      this.eventListeningEnabled = true;

      // 启动事件监听
      void this.startEventListener();
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const statusCode = error instanceof Error && 'status' in error
        ? (error as { status?: number }).status
        : /\b(\d{3})\b/.exec(errorMessage)?.[1]
          ? parseInt(/\b(\d{3})\b/.exec(errorMessage)![1], 10)
          : undefined;

      const reason = appendAuthHint(
        `OpenCode 连接失败: ${errorMessage}`,
        statusCode
      );
      console.error(`[OpenCode] ${reason}`);
      return false;
    }
  }

  private clearEventReconnectTimer(): void {
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer);
      this.eventReconnectTimer = null;
    }
  }

  private scheduleEventReconnect(reason: string): void {
    if (!this.eventListeningEnabled) {
      return;
    }

    if (this.eventReconnectTimer) {
      return;
    }

    const maxBackoffMs = 15000;
    const baseBackoffMs = 2000;
    const step = Math.min(this.eventReconnectAttempt, 4);
    const delay = Math.min(baseBackoffMs * Math.pow(2, step), maxBackoffMs);
    this.eventReconnectAttempt += 1;

    console.warn(`[OpenCode] ${reason}，将在 ${Math.round(delay / 1000)} 秒后重连事件流（第 ${this.eventReconnectAttempt} 次）`);
    this.eventReconnectTimer = setTimeout(() => {
      this.eventReconnectTimer = null;
      void this.startEventListener();
    }, delay);
  }

  private clearDirectoryEventReconnectTimer(directory: string): void {
    const entry = this.directoryEventStreams.get(directory);
    if (!entry || !entry.reconnectTimer) {
      return;
    }
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  private scheduleDirectoryEventReconnect(directory: string, reason: string): void {
    if (!this.eventListeningEnabled) {
      return;
    }

    const entry = this.directoryEventStreams.get(directory);
    if (!entry || entry.reconnectTimer) {
      return;
    }

    const delay = 3000;
    console.warn(`[OpenCode] ${reason}，将在 ${Math.round(delay / 1000)} 秒后重连目录事件流: ${directory}`);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.ensureDirectoryEventStream(directory);
    }, delay);
  }

  private async ensureDirectoryEventStream(directory: string): Promise<void> {
    if (!this.eventListeningEnabled) {
      return;
    }

    const normalizedDirectory = directory.trim();
    if (!normalizedDirectory) {
      return;
    }

    // 防竞态：同一目录正在建立连接时，等待而非重复创建
    const pending = this.pendingDirectoryStreams.get(normalizedDirectory);
    if (pending) {
      await pending;
      return;
    }

    const promise = this._createDirectoryEventStream(normalizedDirectory);
    this.pendingDirectoryStreams.set(normalizedDirectory, promise);
    try {
      await promise;
    } finally {
      this.pendingDirectoryStreams.delete(normalizedDirectory);
    }
  }

  private async _createDirectoryEventStream(normalizedDirectory: string): Promise<void> {
    const existing = this.directoryEventStreams.get(normalizedDirectory);
    if (existing?.active) {
      return;
    }

    if (existing) {
      this.clearDirectoryEventReconnectTimer(normalizedDirectory);
      existing.controller.abort();
    }

    const controller = new AbortController();
    this.directoryEventStreams.set(normalizedDirectory, {
      controller,
      active: true,
      reconnectTimer: null,
    });

    try {
      await this.subscribeEventStream(controller, `?directory=${encodeURIComponent(normalizedDirectory)}`, (event) => {
        if (event.type.toLowerCase().includes('permission')) {
          console.log(`[OpenCode] 目录事件: ${event.type}`, JSON.stringify(event.data || {}).slice(0, 1200));
        }
        this.handleV2Event(event);
      });
      console.log(`[OpenCode] 目录事件流订阅成功: ${normalizedDirectory}`);
      // subscribeEventStream 内部异步消费；这里在连接建立后返回
    } catch (error) {
      console.error(`[OpenCode] 目录事件流订阅失败: ${normalizedDirectory}`, error);
      this.clearDirectoryEventReconnectTimer(normalizedDirectory);
      this.directoryEventStreams.delete(normalizedDirectory);
    }
  }

  // 启动SSE事件监听
  private async startEventListener(): Promise<void> {
    if (!this.eventListeningEnabled) return;
    if (this.eventStreamActive) return;

    this.eventStreamActive = true;
    this.clearEventReconnectTimer();

    const controller = new AbortController();
    if (this.eventAbortController) {
      this.eventAbortController.abort();
    }
    this.eventAbortController = controller;

    try {
      await this.subscribeEventStream(controller, '', (event) => {
        if (event.type.toLowerCase().includes('permission')) {
          console.log(`[OpenCode] 收到底层事件: ${event.type}`, JSON.stringify(event.data || {}).slice(0, 1200));
        }
        this.handleV2Event(event);
      });
      console.log('[OpenCode] 事件流订阅成功');
      this.eventReconnectAttempt = 0;
    } catch (error) {
      console.error('[OpenCode] 无法订阅事件:', error);
      this.eventStreamActive = false;
      if (!controller.signal.aborted && this.eventListeningEnabled) {
        this.scheduleEventReconnect('订阅失败');
      }
    }
  }

  // 订阅 /api/event SSE 并异步消费事件
  private async subscribeEventStream(
    controller: AbortController,
    query: string,
    onEvent: (event: { id?: string; type: string; data?: Record<string, unknown> }) => void
  ): Promise<void> {
    const response = await fetch(`${opencodeConfig.baseUrl}/api/event${query}`, {
      headers: withOpencodeAuthorizationHeaders({ Accept: 'text/event-stream' }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`事件流 HTTP ${response.status || '无响应体'}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    (async () => {
      try {
        while (!controller.signal.aborted && this.eventListeningEnabled) {
          const { done, value } = await reader.read();
          if (done) {
            console.warn(`[OpenCode] 事件流读取到结束标记: aborted=${controller.signal.aborted}, enabled=${this.eventListeningEnabled}, query=${query}`);
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let lineEnd;
          while ((lineEnd = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);
            if (line.startsWith('data:')) {
              const jsonText = line.slice(5).trim();
              if (jsonText) {
                try {
                  const parsed = JSON.parse(jsonText) as { id?: string; type: string; data?: Record<string, unknown> };
                  if (parsed && typeof parsed.type === 'string') {
                    onEvent(parsed);
                  }
                } catch (error) {
                  console.warn('[OpenCode] 事件解析失败:', error);
                }
              }
            }
          }
        }
        if (!controller.signal.aborted && this.eventListeningEnabled) {
          this.scheduleEventReconnect('事件流已结束');
        }
      } catch (error) {
        if (!controller.signal.aborted && this.eventListeningEnabled) {
          console.error('[OpenCode] 事件流中断:', error);
          this.scheduleEventReconnect('事件流中断');
        }
      } finally {
        const isMain = this.eventAbortController === controller;
        if (isMain) {
          this.eventAbortController = null;
          this.eventStreamActive = false;
        }
      }
    })();
  }

  // 处理 v2 SSE 事件 -> 桥接内部事件
  private handleV2Event(event: { id?: string; type: string; data?: Record<string, unknown> }): void {
    const eventType = event.type;
    const data = (event.data || {}) as Record<string, unknown>;

    // 权限请求
    if (eventType === 'permission.asked') {
      const sessionId = getFirstString(data.sessionID, data.sessionId);
      const permissionId = getFirstString(data.id, data.requestID, data.requestId);
      const tool = getFirstString(data.action, data.tool) || 'unknown';
      const description = getFirstString(data.message)
        || (Array.isArray(data.resources) ? `resources: ${data.resources.join(', ')}` : '');
      const source = toRecord(data.source);
      const messageId = source ? getFirstStringFromRecord(source, ['messageID', 'messageId']) : '';
      const callId = source ? getFirstStringFromRecord(source, ['id', 'callID', 'callId']) : '';

      if (sessionId && permissionId) {
        const permissionEvent: PermissionRequestEvent = {
          sessionId,
          permissionId,
          tool,
          description,
          ...(typeof data.risk === 'string' ? { risk: data.risk } : {}),
          ...(messageId ? { messageId } : {}),
          ...(callId ? { callId } : {}),
        };
        this.emit('permissionRequest', permissionEvent);
      }
      return;
    }

    // 会话状态 / 空闲
    if (eventType === 'session.status') {
      this.emit('sessionStatus', data);
      return;
    }
    if (eventType === 'session.idle') {
      this.emit('sessionIdle', data);
      return;
    }

    // 错误事件
    if (eventType === 'session.execution.failed' || eventType === 'session.step.failed') {
      this.emit('sessionError', data);
      return;
    }

    // 用户消息入队（用于消息回显过滤）
    if (eventType === 'session.inbox.enqueued') {
      const item = toRecord(data.item);
      if (item && item.type === 'user') {
        const id = getFirstString(data.inboxID);
        const sessionID = getFirstString(data.sessionID);
        if (id && sessionID) {
          this.emit('messageUpdated', {
            info: {
              id,
              sessionID,
              role: 'user',
              ...(item.payload ? { payload: item.payload } : {}),
            },
          });
        }
      }
      return;
    }

    // 流式文本
    if (eventType === 'session.text.started' || eventType === 'session.text.delta') {
      const sessionID = getFirstString(data.sessionID);
      const messageID = getFirstString(data.assistantMessageID, data.messageID);
      const ordinal = typeof data.ordinal === 'number' ? data.ordinal : 0;
      const delta = getFirstString(data.delta, data.text);
      const part: Record<string, unknown> = {
        type: 'text',
        id: `text:${ordinal}`,
        sessionID,
        messageID,
        text: delta,
      };
      this.emit('messagePartUpdated', { sessionID, part, delta });
      return;
    }

    // 流式推理
    if (eventType === 'session.reasoning.started' || eventType === 'session.reasoning.delta') {
      const sessionID = getFirstString(data.sessionID);
      const messageID = getFirstString(data.assistantMessageID, data.messageID);
      const ordinal = typeof data.ordinal === 'number' ? data.ordinal : 0;
      const delta = getFirstString(data.delta, data.text);
      const part: Record<string, unknown> = {
        type: 'reasoning',
        id: `reasoning:${ordinal}`,
        sessionID,
        messageID,
        text: delta,
      };
      this.emit('messagePartUpdated', { sessionID, part, delta });
      return;
    }

    // 工具事件：开始
    if (eventType === 'session.tool.input.started' || eventType === 'session.tool.called') {
      const sessionID = getFirstString(data.sessionID);
      const messageID = getFirstString(data.assistantMessageID);
      const callID = getFirstString(data.id);
      const toolName = getFirstString(data.name) || 'tool';
      const part: Record<string, unknown> = {
        type: 'tool',
        id: callID,
        sessionID,
        messageID,
        callID,
        tool: toolName,
        state: { status: 'running', input: data.input },
        input: data.input,
      };
      this.emit('messagePartUpdated', { sessionID, part, delta: null });
      return;
    }

    // 工具事件：成功
    if (eventType === 'session.tool.success') {
      const sessionID = getFirstString(data.sessionID);
      const messageID = getFirstString(data.assistantMessageID);
      const callID = getFirstString(data.id);
      const toolName = getFirstString(data.name) || 'tool';
      const content = Array.isArray(data.content) ? data.content : [];
      const output = content
        .map(item => {
          const record = toRecord(item);
          return record ? getFirstString(record.text, record.uri) : '';
        })
        .filter(Boolean)
        .join('\n');
      const part: Record<string, unknown> = {
        type: 'tool',
        id: callID,
        sessionID,
        messageID,
        callID,
        tool: toolName,
        state: { status: 'completed', output },
        output,
      };
      this.emit('messagePartUpdated', { sessionID, part, delta: null });
      return;
    }

    // 工具事件：失败
    if (eventType === 'session.tool.failed') {
      const sessionID = getFirstString(data.sessionID);
      const messageID = getFirstString(data.assistantMessageID);
      const callID = getFirstString(data.id);
      const toolName = getFirstString(data.name) || 'tool';
      const errorRecord = toRecord(data.error);
      const output = errorRecord ? getFirstString(errorRecord.message) || getFirstString(errorRecord.type) : '';
      const part: Record<string, unknown> = {
        type: 'tool',
        id: callID,
        sessionID,
        messageID,
        callID,
        tool: toolName,
        state: { status: 'failed', output },
        output,
      };
      this.emit('messagePartUpdated', { sessionID, part, delta: null });
      return;
    }

    // 表单 / 问答
    if (eventType === 'form.created') {
      const form = toRecord(data.form);
      if (form) {
        const formId = getFirstString(form.id);
        const sessionID = getFirstString(form.sessionID);
        const title = getFirstString(form.title) || '问题';
        const fields = Array.isArray(form.fields) ? form.fields : [];
        if (formId && sessionID) {
          this.formSessionByFormId.set(formId, sessionID);
          const questions = fields.map(field => {
            const fieldRecord = toRecord(field) || {};
            const key = getFirstString(fieldRecord.key) || 'question';
            const fieldTitle = getFirstString(fieldRecord.title)
              || getFirstString(fieldRecord.description)
              || key;
            const fieldType = getFirstString(fieldRecord.type);
            const options = Array.isArray(fieldRecord.options)
              ? (fieldRecord.options as unknown[]).map(opt => {
                  const optRecord = toRecord(opt) || {};
                  return {
                    label: getFirstString(optRecord.label, optRecord.name, optRecord.value) || String(opt),
                    description: getFirstString(optRecord.description) || '',
                  };
                })
              : [];
            return {
              header: title,
              question: fieldTitle,
              options,
              multiple: fieldType === 'multiselect',
              custom: fieldRecord.custom === true,
            };
          });
          this.emit('questionAsked', {
            id: formId,
            sessionID,
            questions,
          });
        }
      }
      return;
    }
  }

  // 兼容旧方法：获取客户端实例（返回自身）
  getClient(): OpencodeClientWrapper {
    return this;
  }

  // ───────────────────────── 会话 ─────────────────────────

  // 获取或创建会话
  async getOrCreateSession(title?: string): Promise<Session> {
    const sessions = await this.listSessions();
    if (sessions.length > 0) {
      return sessions[0];
    }
    return this.createSession(title || '飞书对话');
  }

  private resolveModelOption(options?: { providerId?: string; modelId?: string }): { providerID: string; modelID: string } | undefined {
    const providerId = options?.providerId?.trim();
    const modelId = options?.modelId?.trim();
    if (providerId && modelId) {
      return {
        providerID: providerId,
        modelID: modelId,
      };
    }

    const defaultProvider = modelConfig.defaultProvider;
    const defaultModel = modelConfig.defaultModel;
    if (defaultProvider && defaultModel) {
      return {
        providerID: defaultProvider,
        modelID: defaultModel,
      };
    }

    return undefined;
  }

  private normalizeDirectory(directory?: string): string | undefined {
    if (typeof directory !== 'string') {
      return undefined;
    }

    const normalized = directory.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private buildPermissionDirectoryCandidates(options?: PermissionResponseOptions): Array<string | undefined> {
    const candidates: Array<string | undefined> = [];
    const seen = new Set<string>();

    const pushDirectory = (directory?: string): void => {
      const normalized = this.normalizeDirectory(directory);
      if (!normalized) {
        if (!seen.has('__default__')) {
          seen.add('__default__');
          candidates.push(undefined);
        }
        return;
      }

      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      candidates.push(normalized);
    };

    pushDirectory(options?.directory);

    if (Array.isArray(options?.fallbackDirectories)) {
      for (const directory of options!.fallbackDirectories) {
        pushDirectory(directory);
      }
    }

    pushDirectory(undefined);

    return candidates;
  }

  // 发送 prompt（内部），返回 v2 的 inbox user 消息
  private async promptRaw(
    sessionId: string,
    parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }>,
    options?: {
      providerId?: string;
      modelId?: string;
      agent?: string;
      variant?: string;
      directory?: string;
    },
    delivery?: 'steer' | 'queue'
  ): Promise<Record<string, unknown>> {
    const model = this.resolveModelOption(options);

    if (options?.directory) {
      void this.ensureDirectoryEventStream(options.directory);
    }

    const body: Record<string, unknown> = {
      parts,
      ...(options?.agent ? { agent: options.agent } : {}),
      ...(model ? { model } : {}),
      ...(options?.variant ? { variant: options.variant } : {}),
      ...(delivery ? { delivery } : {}),
    };

    const payload = await this.request<{ data?: Record<string, unknown> }>(
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    return (payload?.data || {}) as Record<string, unknown>;
  }

  // 等待助手回复（轮询会话消息）
  private async waitForAssistantResponse(
    sessionId: string,
    afterMessageId: string | undefined,
    timeoutMs: number = 120000
  ): Promise<{ info: Message; parts: Part[] }> {
    const start = Date.now();
    const seen = new Set<string>();
    if (afterMessageId) seen.add(afterMessageId);

    while (Date.now() - start < timeoutMs) {
      try {
        const messages = await this.getSessionMessages(sessionId);
        for (const item of messages) {
          const id = item.info?.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const role = item.info?.role || item.info?.type || '';
          if (role === 'assistant' || item.info?.type === 'assistant') {
            return item;
          }
        }
      } catch (error) {
        console.warn('[OpenCode] 等待助手回复时拉取消息失败:', error);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.warn(`[OpenCode] 等待助手回复超时: session=${sessionId}`);
    return { info: {} as Message, parts: [] };
  }

  // 发送消息并等待响应
  async sendMessage(
    sessionId: string,
    text: string,
    options?: {
      providerId?: string;
      modelId?: string;
      agent?: string;
      variant?: string;
      directory?: string;
    }
  ): Promise<{ info: Message; parts: Part[] }> {
    const userMessage = await this.promptRaw(sessionId, [{ type: 'text', text }], options, 'steer');
    const userMessageId = getFirstString(userMessage.id);
    return this.waitForAssistantResponse(sessionId, userMessageId || undefined, 120000);
  }

  // 发送带多类型 parts 的消息
  async sendMessageParts(
    sessionId: string,
    parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }>,
    options?: {
      providerId?: string;
      modelId?: string;
      agent?: string;
      variant?: string;
      directory?: string;
    },
    _messageId?: string
  ): Promise<{ info: Message; parts: Part[] }> {
    const userMessage = await this.promptRaw(sessionId, parts, options, 'steer');
    const userMessageId = getFirstString(userMessage.id);
    return this.waitForAssistantResponse(sessionId, userMessageId || undefined, 120000);
  }

  // 异步发送消息（不等待响应）
  async sendMessageAsync(
    sessionId: string,
    text: string,
    options?: {
      providerId?: string;
      modelId?: string;
      agent?: string;
      variant?: string;
      directory?: string;
    }
  ): Promise<void> {
    await this.promptRaw(sessionId, [{ type: 'text', text }], options, 'queue');
  }

  // 异步发送多 parts 消息（立即返回，结果通过事件流推送）
  async sendMessagePartsAsync(
    sessionId: string,
    parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }>,
    options?: {
      providerId?: string;
      modelId?: string;
      agent?: string;
      variant?: string;
      directory?: string;
    }
  ): Promise<void> {
    await this.promptRaw(sessionId, parts, options, 'queue');
  }

  // 发送命令
  async sendCommand(
    sessionId: string,
    command: string,
    args: string,
    options?: { directory?: string }
  ): Promise<{ info: Message; parts: Part[] }> {
    if (options?.directory) {
      void this.ensureDirectoryEventStream(options.directory);
    }

    const payload = await this.request<{ data?: Record<string, unknown> }>(
      `/api/session/${encodeURIComponent(sessionId)}/command`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: command,
          text: args,
        }),
      }
    );
    const userMessage = (payload?.data || {}) as Record<string, unknown>;
    const userMessageId = getFirstString(userMessage.id);
    return this.waitForAssistantResponse(sessionId, userMessageId || undefined, 120000);
  }

  async sendShellCommand(
    sessionId: string,
    command: string,
    _agent: string,
    options?: { providerId?: string; modelId?: string; directory?: string }
  ): Promise<ShellExecutionResult> {
    if (options?.directory) {
      void this.ensureDirectoryEventStream(options.directory);
    }

    const payload = await this.request<{ data?: Record<string, unknown> }>(
      `/api/session/${encodeURIComponent(sessionId)}/shell`,
      {
        method: 'POST',
        body: JSON.stringify({ command }),
      }
    );
    const record = (payload?.data || {}) as Record<string, unknown>;
    const parts = Array.isArray(record.content)
      ? (record.content as unknown[]).map(item => toRecord(item) as unknown as Part).filter(Boolean)
      : [];
    const info: Message = {
      id: getFirstString(record.id),
      sessionID: getFirstString(record.sessionID),
      type: getFirstString(record.type) || 'assistant',
      role: getFirstString(record.role) || 'assistant',
    };
    return { info: info.id ? info : undefined, parts };
  }

  async summarizeSession(sessionId: string, _providerId: string, _modelId: string): Promise<boolean> {
    try {
      await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/compact`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return true;
    } catch (error) {
      console.error('[OpenCode] 会话压缩失败:', error);
      return false;
    }
  }

  // 撤回消息（v2：stage + commit）
  async revertMessage(sessionId: string, messageId: string): Promise<boolean> {
    try {
      await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/revert/stage`, {
        method: 'POST',
        body: JSON.stringify({ messageID: messageId }),
      });
      await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/revert/commit`, {
        method: 'POST',
      });
      return true;
    } catch (error) {
      console.error('[OpenCode] 撤回消息失败:', error);
      return false;
    }
  }

  // 中断会话执行
  async abortSession(sessionId: string): Promise<boolean> {
    try {
      await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
        method: 'POST',
      });
      return true;
    } catch (error) {
      console.error('[OpenCode] 中断会话失败:', error);
      return false;
    }
  }

  // 响应权限请求
  async respondToPermission(
    sessionId: string,
    permissionId: string,
    allow: boolean,
    remember: boolean = false,
    _options?: PermissionResponseOptions
  ): Promise<{ ok: boolean; expired?: boolean }> {
    const decision = allow ? (remember ? 'always' : 'once') : 'reject';
    try {
      const response = await this.request<unknown>(
        `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionId)}/reply`,
        {
          method: 'POST',
          body: JSON.stringify({ decision }),
        }
      );
      return { ok: true };
    } catch (error) {
      const status = error instanceof Error && 'status' in error ? (error as { status?: number }).status : undefined;
      if (status === 404 || status === 410) {
        console.warn(`[OpenCode] 权限请求已过期: session=${sessionId}, permission=${permissionId}`);
        return { ok: false, expired: true };
      }
      console.error(`[OpenCode] 权限响应失败: session=${sessionId}, permission=${permissionId}`, error);
      return { ok: false };
    }
  }

  // ───────────────────────── 项目 / 会话列表 ─────────────────────────

  // 获取工作区列表
  async listProjects(options?: SessionQueryOptions): Promise<Project[]> {
    const directory = this.normalizeDirectory(options?.directory);
    const path = directory ? `/api/project?directory=${encodeURIComponent(directory)}` : '/api/project';
    try {
      const payload = await this.request<unknown[]>(path);
      const raw = Array.isArray(payload) ? payload : [];
      return raw
        .map(item => normalizeProject(item as Record<string, unknown>))
        .filter((p): p is Project => p !== null);
    } catch (error) {
      console.warn('[OpenCode] 获取项目列表失败:', error);
      return [];
    }
  }

  // 获取会话列表（可按目录过滤）
  async listSessions(options?: SessionQueryOptions): Promise<Session[]> {
    const directory = this.normalizeDirectory(options?.directory);
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    try {
      const payload = await this.request<{ data?: unknown[] }>(`/api/session${query}`);
      const raw = Array.isArray(payload?.data) ? payload.data : [];
      return raw
        .map(item => normalizeSession(item as Record<string, unknown>))
        .filter((s): s is Session => s !== null);
    } catch (error) {
      console.warn('[OpenCode] 获取会话列表失败:', error);
      return [];
    }
  }

  // 跨工作区聚合会话列表
  async listSessionsAcrossProjects(): Promise<Session[]> {
    const merged = new Map<string, Session>();
    const upsertSessions = (sessions: Session[]): void => {
      for (const session of sessions) {
        const existing = merged.get(session.id);
        if (!existing) {
          merged.set(session.id, session);
          continue;
        }

        const existingUpdated = existing.time?.updated ?? existing.time?.created ?? 0;
        const nextUpdated = session.time?.updated ?? session.time?.created ?? 0;
        if (nextUpdated >= existingUpdated) {
          merged.set(session.id, session);
        }
      }
    };

    try {
      upsertSessions(await this.listSessions());
    } catch (error) {
      console.warn('[OpenCode] 获取默认作用域会话列表失败:', error);
    }

    const projects = await this.listProjects();
    const directories: string[] = [];
    const seenDirectories = new Set<string>();
    for (const project of projects) {
      const normalized = this.normalizeDirectory(project.worktree || project.canonical);
      if (!normalized || seenDirectories.has(normalized)) {
        continue;
      }
      seenDirectories.add(normalized);
      directories.push(normalized);
    }

    const sessionGroups = await Promise.all(
      directories.map(async directory => {
        try {
          return await this.listSessions({ directory });
        } catch (error) {
          console.warn(`[OpenCode] 获取目录会话列表失败: directory=${directory}`, error);
          return [] as Session[];
        }
      })
    );

    for (const sessions of sessionGroups) {
      upsertSessions(sessions);
    }

    return Array.from(merged.values());
  }

  // 聚合查询所有已知目录的 session
  async listAllSessions(knownDirectories: string[]): Promise<Session[]> {
    const allSessions: Session[] = [];
    const seen = new Set<string>();

    // 1. 默认 Instance
    try {
      const defaultSessions = await this.listSessions();
      for (const s of defaultSessions) {
        if (!seen.has(s.id)) { seen.add(s.id); allSessions.push(s); }
      }
    } catch {
      // 默认 Instance 查询失败不阻塞
    }

    // 2. 各自定义目录的 Instance
    for (const dir of knownDirectories) {
      try {
        const sessions = await this.listSessions({ directory: dir });
        for (const s of sessions) {
          if (!seen.has(s.id)) { seen.add(s.id); allSessions.push(s); }
        }
      } catch {
        // 单个目录查询失败不阻塞其他
      }
    }

    return allSessions;
  }

  // 通过 ID 获取会话
  async getSessionById(sessionId: string, _options?: SessionQueryOptions): Promise<Session | null> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return null;
    }

    try {
      const payload = await this.request<{ data?: unknown }>(`/api/session/${encodeURIComponent(normalizedSessionId)}`);
      return normalizeSession(payload?.data as Record<string, unknown> | undefined);
    } catch (error) {
      const status = error instanceof Error && 'status' in error ? (error as { status?: number }).status : undefined;
      if (status === 404) {
        return null;
      }
      throw error;
    }
  }

  // 跨工作区按 ID 查找会话
  async findSessionAcrossProjects(sessionId: string): Promise<Session | null> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return null;
    }

    const direct = await this.getSessionById(normalizedSessionId);
    if (direct) {
      return direct;
    }

    const projects = await this.listProjects();
    const directories: string[] = [];
    const seenDirectories = new Set<string>();
    for (const project of projects) {
      const normalized = this.normalizeDirectory(project.worktree || project.canonical);
      if (!normalized || seenDirectories.has(normalized)) {
        continue;
      }
      seenDirectories.add(normalized);
      directories.push(normalized);
    }

    for (const directory of directories) {
      const found = await this.getSessionById(normalizedSessionId, { directory });
      if (found) {
        return found;
      }
    }

    return null;
  }

  // 创建新会话
  async createSession(title?: string, directory?: string): Promise<Session> {
    const normalizedDir = this.normalizeDirectory(directory);
    if (normalizedDir) {
      void this.ensureDirectoryEventStream(normalizedDir);
    }

    const body: Record<string, unknown> = { title: title || '新对话' };
    if (normalizedDir) {
      body.location = { directory: normalizedDir };
    }

    const payload = await this.request<{ data?: unknown }>('/api/session', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const session = normalizeSession(payload?.data as Record<string, unknown> | undefined);
    if (!session) {
      throw new Error('创建会话失败：返回数据为空');
    }
    return session;
  }

  // 更新会话标题
  async updateSession(sessionId: string, title: string): Promise<boolean> {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      console.warn('[OpenCode] updateSession: 标题不能为空');
      return false;
    }

    try {
      await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmedTitle }),
      });
      return true;
    } catch (error) {
      console.error(`[OpenCode] 更新会话标题失败: ${sessionId}`, error);
      return false;
    }
  }

  // 删除会话
  async deleteSession(sessionId: string, _options?: SessionQueryOptions): Promise<boolean> {
    try {
      await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      console.log(`[OpenCode] 已删除会话: ${sessionId}`);
      return true;
    } catch (error) {
      console.error(`[OpenCode] 删除会话失败: ${sessionId}`, error);
      return false;
    }
  }

  // 获取会话消息
  async getSessionMessages(sessionId: string): Promise<Array<{ info: Message; parts: Part[] }>> {
    try {
      const payload = await this.request<{ data?: unknown[] }>(`/api/session/${encodeURIComponent(sessionId)}/message`);
      const raw = Array.isArray(payload?.data) ? payload.data : [];
      return raw.map(item => {
        const record = (item || {}) as Record<string, unknown>;
        const content = Array.isArray(record.content) ? record.content as unknown[] : [];
        const parts = content
          .map(part => toRecord(part))
          .filter((p): p is Record<string, unknown> => p !== null)
          .map(part => ({
            ...part,
            type: getFirstString(part.type) || 'text',
          }) as unknown as Part);
        const info: Message = {
          ...record,
          id: getFirstString(record.id),
          role: getFirstString(record.role) || getFirstString(record.type) || 'unknown',
        };
        return { info, parts };
      });
    } catch (error) {
      console.warn('[OpenCode] 获取会话消息失败:', error);
      return [];
    }
  }

  // ───────────────────────── 配置 / 提供方 / 模型 ─────────────────────────

  // 获取配置（含模型列表）
  async getProviders(): Promise<{
    providers: ProviderInfo[];
    default: Record<string, string>;
  }> {
    const providers: ProviderInfo[] = [];
    const defaultMap: Record<string, string> = {};

    try {
      const providerPayload = await this.request<{ data?: unknown[] }>('/api/provider');
      const rawProviders = Array.isArray(providerPayload?.data) ? providerPayload.data : [];
      for (const item of rawProviders) {
        const record = (item || {}) as Record<string, unknown>;
        const id = getFirstString(record.id);
        const name = getFirstString(record.name) || id;
        if (id) {
          providers.push({ id, name, models: [] });
        }
      }
    } catch (error) {
      console.warn('[OpenCode] 获取提供方列表失败:', error);
    }

    try {
      const modelPayload = await this.request<{ data?: unknown[] }>('/api/model');
      const rawModels = Array.isArray(modelPayload?.data) ? modelPayload.data : [];
      for (const item of rawModels) {
        const record = (item || {}) as Record<string, unknown>;
        const modelId = getFirstString(record.modelID, record.id);
        const providerId = getFirstString(record.providerID);
        const name = getFirstString(record.name) || modelId;
        if (modelId && providerId) {
          const provider = providers.find(p => p.id === providerId);
          if (provider) {
            if (!provider.models.some(m => m.id === modelId)) {
              provider.models.push({ id: modelId, name });
            }
          } else {
            providers.push({ id: providerId, name: providerId, models: [{ id: modelId, name }] });
          }
          defaultMap[providerId] = modelId;
        }
      }
    } catch (error) {
      console.warn('[OpenCode] 获取模型列表失败:', error);
    }

    try {
      const defaultPayload = await this.request<{ data?: unknown }>('/api/model/default');
      const defaultRecord = toRecord(defaultPayload?.data);
      if (defaultRecord) {
        const providerId = getFirstString(defaultRecord.providerID);
        const modelId = getFirstString(defaultRecord.modelID, defaultRecord.id);
        if (providerId && modelId) {
          defaultMap[providerId] = modelId;
        }
      }
    } catch (error) {
      // 忽略默认模型获取失败
    }

    return { providers, default: defaultMap };
  }

  // 获取完整配置
  async getConfig(): Promise<OpencodeRuntimeConfig> {
    try {
      const payload = await this.request<unknown[]>('/api/config');
      const entries = Array.isArray(payload) ? payload : [];
      const result: OpencodeRuntimeConfig = {};
      for (const entry of entries) {
        const record = toRecord(entry) || {};
        const info = toRecord(record.info);
        if (!info) continue;
        const defaultAgent = getFirstString(info.default_agent, info.defaultAgent, info.defaultAgentName);
        if (defaultAgent) {
          result.default_agent = defaultAgent;
        }
        const agents = toRecord(info.agent);
        if (agents) {
          result.agent = agents as OpencodeRuntimeConfig['agent'];
        }
      }
      return result;
    } catch (error) {
      console.warn('[OpenCode] 获取配置失败:', error);
      return {};
    }
  }

  // 更新完整配置
  async updateConfig(config: OpencodeRuntimeConfig): Promise<OpencodeRuntimeConfig | null> {
    try {
      await this.request<unknown>('/api/experimental/config', {
        method: 'PATCH',
        body: JSON.stringify(config),
      });
      return config;
    } catch (error) {
      console.error('[OpenCode] 更新配置失败:', error);
      return null;
    }
  }

  // 获取可用 Agent 列表
  async getAgents(): Promise<OpencodeAgentInfo[]> {
    try {
      const payload = await this.request<{ data?: unknown[] }>('/api/agent');
      const rawAgents = Array.isArray(payload?.data) ? payload.data : [];
      const agents: OpencodeAgentInfo[] = [];

      for (const item of rawAgents) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!name) continue;

        const description = typeof record.description === 'string' && record.description.trim().length > 0
          ? record.description.trim()
          : undefined;
        const mode = parseAgentMode(record.mode);
        const hidden = parseBoolean(record.hidden);
        const builtIn = parseBoolean(record.builtIn);
        const native = parseBoolean(record.native);

        agents.push({
          name,
          description,
          mode,
          ...(hidden !== undefined ? { hidden } : {}),
          ...(builtIn !== undefined ? { builtIn } : {}),
          ...(native !== undefined ? { native } : {}),
        });
      }

      return agents;
    } catch (error) {
      console.warn('[OpenCode] 获取 Agent 列表失败:', error);
      return [];
    }
  }

  // 获取可用命令列表（slash command）
  async getCommands(): Promise<OpencodeCommandInfo[]> {
    // 1. 检查缓存是否有效
    const now = Date.now();
    if (this.commandsCache && (now - this.commandsCacheTimestamp) < this.COMMANDS_CACHE_TTL) {
      return this.commandsCache;
    }

    // 2. 版本兼容性检查（仅首次调用时）
    if (!this.versionChecked) {
      const versionOk = await this.checkOpenCodeVersion();
      if (!versionOk) {
        console.warn('[OpenCode] 当前版本可能不支持 command.list API，继续尝试调用...');
      }
      this.versionChecked = true;
    }

    // 3. 调用 API 获取命令列表
    try {
      const payload = await this.request<{ data?: unknown[] }>('/api/command');
      const raw = Array.isArray(payload?.data) ? payload.data : [];
      const commands: OpencodeCommandInfo[] = raw.map(item => {
        const record = (item || {}) as Record<string, unknown>;
        return {
          name: getFirstString(record.name),
          description: typeof record.description === 'string' ? record.description : undefined,
          template: getFirstString(record.template) || getFirstString(record.name),
          hints: [],
        };
      });

      // 4. 更新缓存
      this.commandsCache = commands;
      this.commandsCacheTimestamp = now;

      return commands;
    } catch (error) {
      console.error('[OpenCode] 获取命令列表失败:', error);
      throw error; // 抛出错误让调用者处理
    }
  }

  // 检查 OpenCode 版本兼容性
  private async checkOpenCodeVersion(): Promise<boolean> {
    try {
      const payload = await this.request<unknown>('/api/info');
      return payload !== undefined;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCode] /api/info 不可用:', errorMessage);
      return false;
    }
  }

  // 获取 OpenCode 版本信息（供外部调用）
  public getOpencodeVersion(): string | null {
    return this.opencodeVersion;
  }

  // 清除命令缓存（用于强制刷新）
  public clearCommandsCache(): void {
    this.commandsCache = null;
    this.commandsCacheTimestamp = 0;
  }

  // ───────────────────────── 问答（v2 form） ─────────────────────────

  // 回复问题 (form 工具)
  // answers 是一个二维数组: [[第一个问题的答案们], [第二个问题的答案们], ...]
  async replyQuestion(
    requestId: string,
    answers: string[][]
  ): Promise<{ ok: boolean; expired?: boolean }> {
    const sessionId = this.formSessionByFormId.get(requestId);
    if (!sessionId) {
      console.warn(`[OpenCode] 找不到表单对应的会话: requestId=${requestId}`);
      return { ok: false, expired: true };
    }

    try {
      // v2 Form.Reply: { answer: Record<string, string|number|boolean|string[]> }
      const answer: Record<string, unknown> = {};
      answers.forEach((ans, index) => {
        answer[String(index)] = ans.length === 1 ? ans[0] : ans;
      });
      await this.request<unknown>(
        `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}/reply`,
        {
          method: 'POST',
          body: JSON.stringify({ answer }),
        }
      );
      return { ok: true };
    } catch (error) {
      const status = error instanceof Error && 'status' in error ? (error as { status?: number }).status : undefined;
      if (status === 404 || status === 410) {
        console.warn(`[OpenCode] 表单已过期: requestId=${requestId}`);
        return { ok: false, expired: true };
      }
      console.error('[OpenCode] 回复问题失败:', error);
      return { ok: false };
    }
  }

  // 拒绝/跳过问题
  async rejectQuestion(requestId: string): Promise<{ ok: boolean; expired?: boolean }> {
    const sessionId = this.formSessionByFormId.get(requestId);
    if (!sessionId) {
      return { ok: false, expired: true };
    }

    try {
      await this.request<unknown>(
        `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}`,
        { method: 'DELETE' }
      );
      return { ok: true };
    } catch (error) {
      const status = error instanceof Error && 'status' in error ? (error as { status?: number }).status : undefined;
      if (status === 404 || status === 410) {
        return { ok: false, expired: true };
      }
      console.error('[OpenCode] 拒绝问题失败:', error);
      return { ok: false };
    }
  }

  // 断开连接
  disconnect(): void {
    this.eventListeningEnabled = false;
    this.eventStreamActive = false;
    this.clearEventReconnectTimer();
    this.eventReconnectAttempt = 0;
    if (this.eventAbortController) {
      this.eventAbortController.abort();
      this.eventAbortController = null;
    }
    for (const [directory, entry] of this.directoryEventStreams) {
      this.clearDirectoryEventReconnectTimer(directory);
      entry.controller.abort();
    }
    this.directoryEventStreams.clear();
    console.log('[OpenCode] 已断开连接');
  }
}

// 单例导出
export const opencodeClient = new OpencodeClientWrapper();