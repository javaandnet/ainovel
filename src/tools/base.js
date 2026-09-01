/**
 * BaseTool shim - ainovel 独立版
 *
 * writerTool.js 继承自 BaseTool，实际仅用到：super(name, desc)、this.name/description、
 * this.parameters、this.context（可注入）。原 galaclaw 版 BaseTool 深耦合 loader/logger，
 * 这里以最小实现替代，保持 writerTool 逐字不改即可运行。
 */
export class BaseTool {
  constructor(name, description) {
    this.name = name;
    this.description = description;
    this.parameters = {};
    this.context = {}; // 运行上下文：{ model, temperature, maxTokens, sessionId, agentName, sessionWorkspace, requestConfirmation, ... }
  }

  /** 设置运行上下文（供 execute 前注入 model / context 等） */
  setContext(ctx = {}) {
    this.context = { ...this.context, ...ctx };
  }
}

export default BaseTool;
