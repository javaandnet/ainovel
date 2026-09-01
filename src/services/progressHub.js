/**
 * 全局进度事件总线（单例）
 *
 * 用途：Agent 执行链路（编排器 / 工作流 / spawnTool）在长任务执行期间
 * 发布阶段性进度事件；Web 服务器订阅后转发为 socket.io `chat:progress`
 * 事件，让前端在等待期间可见"正在做什么"。
 *
 * 设计约束：
 * - 纯事件转发，不持状态；发布方异常不得影响主执行链路（订阅方异常隔离）。
 * - Web 服务器与 Agent 同进程（npm run web 内嵌 Gala），故可用进程内总线；
 *   CLI 等无订阅方场景下事件自然丢弃，无副作用。
 */

import { EventEmitter } from 'events';

class ProgressHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * 发布进度事件
   * @param {string} sessionId - 会话ID（与 socket 房间名一致，如 web:session-xxx）
   * @param {string} text - 进度描述（用户可见文本）
   * @param {Object} [meta] - 附加元数据（stage、agent、tool 等）
   */
  publish(sessionId, text, meta = {}) {
    if (!sessionId || !text) return;
    const event = {
      sessionId,
      text: String(text),
      timestamp: new Date().toISOString(),
      ...meta
    };
    // 逐个调用并隔离异常：订阅方报错不得影响主执行链路与其他订阅方
    for (const listener of this.listeners('progress')) {
      try {
        listener(event);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[ProgressHub] 订阅方异常已隔离:', error?.message);
      }
    }
  }

  /**
   * 订阅进度事件
   * @param {(event: {sessionId: string, text: string, timestamp: string}) => void} listener
   * @returns {() => void} 取消订阅函数
   */
  subscribe(listener) {
    this.on('progress', listener);
    return () => this.off('progress', listener);
  }
}

export const progressHub = new ProgressHub();
