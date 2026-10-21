// 飞书卡片动作处理器
// 处理 /panel 和 question 工具的卡片交互

import { opencodeClient } from '../opencode/client.js';
import { chatSessionStore } from '../store/chat-session.js';
import { outputBuffer } from '../opencode/output-buffer.js';
import { commandHandler } from './command.js';
import { feishuClient, type FeishuCardActionEvent } from '../feishu/client.js';
import { isCompletionNotFoundError } from '../feishu/client.js';
import {
  buildSessionPickerCard,
  SESSION_PICKER_ALL_VALUE,
  SESSION_PICKER_NONE_VALUE,
  SESSION_PICKER_MAX_OPTIONS,
  PANEL_PROVIDER_ALL_VALUE,
  PANEL_MODEL_NONE_VALUE,
  type SessionPickerOption,
} from '../feishu/cards.js';

export class CardActionHandler {
  private extractSelectedOption(value: unknown): string | undefined {
    if (typeof value === 'string') {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : undefined;
    }

    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const candidates = [record.value, record.key, record.label];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const normalized = candidate.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }

    return undefined;
  }

  async handle(event: FeishuCardActionEvent): Promise<object | void> {
    const actionValue = event.action.value as any;
    const action = actionValue?.action;

    console.log(`[CardAction] 收到动作: ${action}, value:`, JSON.stringify(actionValue));

    switch (action) {
      case 'stop':
        return this.handleStop(actionValue);
      case 'undo':
        return this.handleUndo(actionValue);
      case 'model_select':
        return this.handleModelSelect(actionValue, event);
      case 'agent_select':
        return this.handleAgentSelect(actionValue, event);
      case 'panel_provider_select':
        return this.handlePanelProviderSelect(actionValue, event);
      case 'toggle_thinking':
        return this.handleToggleThinking(actionValue, event);
      case 'session_project_select':
        return this.handleSessionProjectSelect(actionValue, event);
      case 'session_bind_select':
        return this.handleSessionBindSelect(actionValue, event);
      case 'create_chat':
        // P2P 创建会话，由 p2pHandler 处理
        return;
      case 'permission_allow':
      case 'permission_deny':
        // 权限确认，由 index.ts 直接处理
        return;
      default:
        console.warn(`[CardAction] 未知动作: ${action}`);
        return;
    }
  }

  private async handleStop(value: any): Promise<object> {
    const { conversationKey, chatId } = value;
    if (!conversationKey) return { msg: 'ok' };

    // 1. 中断本地输出缓冲
    outputBuffer.abort(conversationKey);

    // 2. 获取会话ID并中断OpenCode会话
    const session = chatId ? chatSessionStore.getSession(chatId) : null;
    if (session?.sessionId) {
      try {
        const aborted = await opencodeClient.abortSession(session.sessionId);
        if (aborted) {
          console.log(`[CardAction] 已中断会话: ${session.sessionId}`);
        } else {
          console.log(`[CardAction] 会话可能已结束: ${session.sessionId}`);
        }
      } catch (e) {
        // 检查是否为过期操作
        const errorData = typeof e === 'object' && e !== null && 'response' in e
          ? (e as { response?: { data?: unknown } }).response?.data
          : undefined;
        if (isCompletionNotFoundError(errorData)) {
          console.log(`[CardAction] 会话已过期: ${session.sessionId}`);
        } else {
          console.error('[CardAction] 中断会话失败:', e);
        }
      }
    }

    return {
      toast: {
        type: 'success',
        content: '已停止',
        i18n_content: { zh_cn: '已停止', en_us: 'Stopped' }
      }
    };
  }

  private async handleUndo(value: any): Promise<object> {
    const { chatId } = value;
    if (!chatId) return { msg: 'ok' };

    try {
      await commandHandler.handleUndo(chatId);
      return {
        toast: {
          type: 'success',
          content: '已撤回',
          i18n_content: { zh_cn: '已撤回', en_us: 'Undone' }
        }
      };
    } catch (error) {
      console.error('[CardAction] Undo failed:', error);
      // 检查是否为过期操作
      const errorData = typeof error === 'object' && error !== null && 'response' in error
        ? (error as { response?: { data?: unknown } }).response?.data
        : undefined;
      if (isCompletionNotFoundError(errorData)) {
        return {
          toast: {
            type: 'error',
            content: '操作已过期，请重新发起',
            i18n_content: { zh_cn: '操作已过期，请重新发起', en_us: 'Operation expired, please try again' }
          }
        };
      }
      return {
        toast: {
          type: 'error',
          content: '撤回失败',
          i18n_content: { zh_cn: '撤回失败', en_us: 'Undo failed' }
        }
      };
    }
  }

  private async handleModelSelect(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chatId } = value;
    const selectedOption = this.extractSelectedOption((event.action as Record<string, unknown>).option) || this.extractSelectedOption(value.selected);

    if (!chatId || !selectedOption) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    if (selectedOption === PANEL_MODEL_NONE_VALUE) {
      return { toast: { type: 'info', content: '当前厂商暂无可用模型，请切换其他厂商' } };
    }

    // 更新配置
    chatSessionStore.updateConfig(chatId, { preferredModel: selectedOption });
    console.log(`[CardAction] 已切换模型: ${selectedOption}`);

    const reconciled = await commandHandler.reconcilePreferredEffort(chatId);
    const effortNotice = reconciled.clearedEffort
      ? `；强度 ${reconciled.clearedEffort} 不兼容，已回退为默认`
      : '';
    const toastText = `已切换模型: ${selectedOption}${effortNotice}`;

    // 只返回toast，不更新卡片
    // 卡片更新可能失败（错误码200672），所以只返回toast确保用户知道操作成功
    return {
      toast: {
        type: 'success',
        content: toastText,
        i18n_content: { zh_cn: toastText, en_us: `Model changed: ${selectedOption}` }
      }
    };
  }

  private async handleAgentSelect(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chatId } = value;
    const selectedOption = this.extractSelectedOption((event.action as Record<string, unknown>).option) || this.extractSelectedOption(value.selected);

    if (!chatId) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    const agentName = selectedOption === 'none' ? undefined : selectedOption;
    chatSessionStore.updateConfig(chatId, { preferredAgent: agentName });
    console.log(`[CardAction] 已切换角色: ${agentName || '默认'}`);

    // 只返回toast，不更新卡片
    return {
      toast: {
        type: 'success',
        content: agentName ? `已切换角色: ${agentName}` : '已切换为默认角色',
        i18n_content: { zh_cn: agentName ? `已切换角色: ${agentName}` : '已切换为默认角色', en_us: agentName ? `Role changed: ${agentName}` : 'Role reset to default' }
      }
    };
  }

  private async handlePanelProviderSelect(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chatId, chatType } = value;
    const selectedProvider = this.extractSelectedOption((event.action as Record<string, unknown>).option)
      || this.extractSelectedOption(value.selected);

    if (!chatId || !selectedProvider || !event.messageId) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    try {
      console.log(`[CardAction] 厂商切换: provider=${selectedProvider}, chat=${chatId}, messageId=${event.messageId.slice(0, 16)}...`);
      const card = await commandHandler.buildPanelCard(chatId, chatType || 'group', selectedProvider);
      await feishuClient.updateCard(event.messageId, card);

      const toastText = selectedProvider === PANEL_PROVIDER_ALL_VALUE
        ? '已加载全部厂商的模型'
        : `已加载厂商 ${selectedProvider} 的模型`;
      return {
        toast: {
          type: 'success',
          content: toastText,
          i18n_content: { zh_cn: toastText, en_us: toastText },
        },
      };
    } catch (error) {
      console.error('[CardAction] 切换厂商失败:', error);
      return { toast: { type: 'error', content: '加载模型列表失败，请稍后重试' } };
    }
  }

  private async handleSessionProjectSelect(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chatId, chatType } = value;
    const selectedDirectory = this.extractSelectedOption((event.action as Record<string, unknown>).option)
      || this.extractSelectedOption(value.selected);

    if (!chatId || !selectedDirectory || !event.messageId) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    try {
      type SessionLike = Awaited<ReturnType<typeof opencodeClient.listSessions>>[number];

      let sessions: SessionLike[] = [];
      if (selectedDirectory === SESSION_PICKER_ALL_VALUE) {
        const storeKnownDirs = chatSessionStore.getKnownDirectories();
        sessions = await opencodeClient.listAllSessions(storeKnownDirs);
      } else {
        sessions = await opencodeClient.listSessions({ directory: selectedDirectory });
      }

      const sorted = [...sessions].sort((left, right) => {
        const leftUpdated = left.time?.updated ?? left.time?.created ?? 0;
        const rightUpdated = right.time?.updated ?? right.time?.created ?? 0;
        return rightUpdated - leftUpdated;
      });
      const top = sorted.slice(0, SESSION_PICKER_MAX_OPTIONS);

      const sessionOptions: SessionPickerOption[] = top.map(session => {
        const title = session.title && session.title.trim().length > 0 ? session.title.trim() : '未命名会话';
        return {
          label: `${title.slice(0, 40)} · ${session.id.slice(0, 8)}`,
          value: session.id,
        };
      });

      const directorySet = new Set<string>();
      for (const session of sessions) {
        const directory = session.directory?.trim();
        if (directory) directorySet.add(directory);
      }
      const directoryOptions: SessionPickerOption[] = [
        { label: '全部项目', value: SESSION_PICKER_ALL_VALUE },
        ...[...directorySet].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).map(directory => ({
          label: directory,
          value: directory,
        })),
      ];

      const isAll = selectedDirectory === SESSION_PICKER_ALL_VALUE;
      const card = buildSessionPickerCard({
        chatId,
        chatType: chatType || 'group',
        directories: directoryOptions,
        sessions: sessionOptions,
        currentDirectory: isAll ? undefined : selectedDirectory,
        selectedDirectoryLabel: isAll ? '全部项目' : selectedDirectory,
        totalSessions: sessions.length,
      });

      await feishuClient.updateCard(event.messageId, card);

      const toastText = isAll
        ? `已加载全部项目的会话（共 ${sessions.length} 个）`
        : `已加载 ${selectedDirectory} 的会话（共 ${sessions.length} 个）`;
      return {
        toast: {
          type: 'success',
          content: toastText,
          i18n_content: { zh_cn: toastText, en_us: toastText },
        },
      };
    } catch (error) {
      console.error('[CardAction] 加载会话列表失败:', error);
      return { toast: { type: 'error', content: '加载会话列表失败，请稍后重试' } };
    }
  }

  private async handleSessionBindSelect(value: any, event: FeishuCardActionEvent): Promise<object> {
    const { chatId, chatType } = value;
    const selectedOption = this.extractSelectedOption((event.action as Record<string, unknown>).option)
      || this.extractSelectedOption(value.selected);

    if (!chatId || !selectedOption) {
      return { toast: { type: 'error', content: '参数错误' } };
    }

    if (selectedOption === SESSION_PICKER_NONE_VALUE) {
      return { toast: { type: 'info', content: '当前目录暂无可用会话' } };
    }

    const result = await commandHandler.bindSessionToChat(chatId, selectedOption, event.openId, chatType || 'group');
    if (result.ok) {
      return {
        toast: {
          type: 'success',
          content: result.message,
          i18n_content: { zh_cn: result.message, en_us: result.message },
        },
      };
    }

    return {
      toast: {
        type: 'error',
        content: result.message,
        i18n_content: { zh_cn: result.message, en_us: result.message },
      },
    };
  }

  private async handleToggleThinking(_value: any, _event: FeishuCardActionEvent): Promise<object> {
      // 兼容历史卡片按钮：思考展开已改为飞书原生折叠面板，无需回调更新。
      return { msg: 'ok' };
  }
}

export const cardActionHandler = new CardActionHandler();
