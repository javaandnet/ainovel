/**
 * 统一路径解析工具（SkillPathResolver）
 *
 * 收敛工具层 / 技能执行器 / 技能脚本中碎片化的路径处理逻辑，提供：
 * 1. expandHome       —— 统一的 ~ 展开（基于 os.homedir()）
 * 2. resolveSkillPath —— 占位符替换 + ~ 展开 + 相对路径基准解析
 * 3. checkPath        —— 存在性 / 类型预检，附相似文件名提示（便于 LLM 自纠）
 * 4. isPathWithin     —— 基于 path.relative 的安全边界判断（修复 startsWith 前缀漏洞）
 *
 * 纯函数导出为主，保证技能脚本（独立进程 / 动态导入）也能直接复用；
 * SkillPathResolver 类提供与旧 DefaultPathResolver 兼容的实例 API。
 */

import path from 'path';
import os from 'os';
import fs from 'fs-extra';

/**
 * 展开路径前缀中的 ~ 为用户主目录
 * 仅处理前缀位置的 ~，路径中间的 ~ 不做替换（避免误伤）
 * @param {string} inputPath - 输入路径
 * @returns {string} 展开后的路径；非字符串输入原样返回
 */
export function expandHome(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return inputPath;
  const trimmed = inputPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  return inputPath;
}

/**
 * 统一路径解析
 * 处理顺序：占位符替换（{baseDir}/{workspace}/{session}/{home}）→ ~ 展开 → 绝对化
 * 相对路径基准优先级：sessionDir > workspace > process.cwd()
 * 裸文件名（不含目录分隔符）落入 bareFileNameDir（默认与相对路径基准一致）
 *
 * @param {string} input - 原始路径输入
 * @param {Object} [options]
 * @param {string} [options.workspace] - 工作区目录（相对路径基准）
 * @param {string} [options.sessionDir] - 会话目录（优先级高于 workspace）
 * @param {string} [options.bareFileNameDir] - 裸文件名的目标目录，默认取相对路径基准
 * @param {Object} [options.placeholders] - 占位符值 { baseDir, workspace, session, home }
 * @param {boolean} [options.autoCreateTmp=false] - 空输入时是否自动生成临时文件名
 * @param {string} [options.tmpFileName='tmp'] - 临时文件名前缀
 * @returns {{fullPath: string|null, isDefault: boolean, isTemporary?: boolean,
 *            originalPath: string, tempFileName?: string, defaultDirUsed?: string}}
 *          fullPath 为 null 表示空输入且未启用 autoCreateTmp
 */
export function resolveSkillPath(input, options = {}) {
  const {
    workspace = null,
    sessionDir = null,
    bareFileNameDir = null,
    placeholders = {},
    autoCreateTmp = false,
    tmpFileName = 'tmp'
  } = options;

  const baseDir = path.resolve(expandHome(sessionDir || workspace || process.cwd()));

  // 空输入处理
  if (!input || typeof input !== 'string' || input.trim() === '') {
    if (autoCreateTmp) {
      const targetDir = bareFileNameDir ? path.resolve(expandHome(bareFileNameDir)) : baseDir;
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const tempFileName = `${tmpFileName}_${timestamp}_${randomSuffix}`;
      return {
        fullPath: path.join(targetDir, tempFileName),
        isDefault: true,
        isTemporary: true,
        originalPath: '',
        tempFileName,
        defaultDirUsed: targetDir
      };
    }
    return { fullPath: null, isDefault: false, originalPath: input || '' };
  }

  let resolved = input.trim();

  // 占位符替换：{baseDir}/{workspace}/{session}/{home}
  const placeholderValues = {
    baseDir: placeholders.baseDir,
    workspace: placeholders.workspace ?? workspace,
    session: placeholders.session ?? sessionDir,
    home: os.homedir()
  };
  resolved = resolved.replace(/\{(baseDir|workspace|session|home)\}/g, (match, key) => {
    const value = placeholderValues[key];
    return value != null ? String(value) : match;
  });

  // ~ 展开
  resolved = expandHome(resolved);

  // 绝对路径直接返回
  if (path.isAbsolute(resolved)) {
    return { fullPath: path.resolve(resolved), isDefault: false, originalPath: input };
  }

  // 裸文件名 → bareFileNameDir；含分隔符的相对路径 → baseDir
  const hasSeparator = resolved.includes('/') || resolved.includes('\\');
  if (!hasSeparator && bareFileNameDir) {
    const targetDir = path.resolve(expandHome(bareFileNameDir));
    return {
      fullPath: path.resolve(targetDir, resolved),
      isDefault: true,
      originalPath: input,
      defaultDirUsed: targetDir
    };
  }

  return {
    fullPath: path.resolve(baseDir, resolved),
    isDefault: !hasSeparator,
    originalPath: input,
    defaultDirUsed: !hasSeparator ? baseDir : undefined
  };
}

/**
 * 判断 fullPath 是否位于 boundary 目录内
 * 使用 path.relative 判定，修复 startsWith 的前缀匹配漏洞
 * （如 /workspace-evil 不应通过 /workspace 的检查）
 * @param {string} fullPath - 待检查路径
 * @param {string} boundary - 边界目录
 * @returns {boolean}
 */
export function isPathWithin(fullPath, boundary) {
  if (!fullPath || !boundary) return false;
  const relative = path.relative(path.resolve(boundary), path.resolve(fullPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 计算与目标文件名相似的候选文件（用于路径不存在时的纠错提示）
 * @private
 */
async function suggestSimilarFiles(fullPath, limit = 5) {
  try {
    const dir = path.dirname(fullPath);
    const target = path.basename(fullPath).toLowerCase();
    if (!target || target === '.' || target === '..') return [];

    const entries = await fs.readdir(dir);
    const candidates = entries.filter(entry => {
      const lower = entry.toLowerCase();
      if (lower === target) return false;
      // 子串包含，或共享足够长的前缀
      if (lower.includes(target) || target.includes(lower)) return true;
      let prefixLen = 0;
      while (prefixLen < lower.length && prefixLen < target.length && lower[prefixLen] === target[prefixLen]) {
        prefixLen++;
      }
      return prefixLen >= Math.max(3, Math.floor(target.length / 2));
    });
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 路径存在性 / 类型预检
 * @param {string} fullPath - 已解析的绝对路径
 * @param {Object} [options]
 * @param {boolean} [options.mustExist=false] - 不存在时是否判定为失败
 * @param {'file'|'dir'|'any'} [options.kind='any'] - 期望的路径类型
 * @param {string} [options.originalPath] - 原始输入路径（用于错误信息）
 * @returns {Promise<{ok: boolean, exists: boolean, isFile: boolean, isDir: boolean,
 *                    error: string|null, suggestions: string[]}>}
 */
export async function checkPath(fullPath, options = {}) {
  const { mustExist = false, kind = 'any', originalPath = null } = options;
  const result = { ok: true, exists: false, isFile: false, isDir: false, error: null, suggestions: [] };

  let stats = null;
  try {
    stats = await fs.stat(fullPath);
    result.exists = true;
  } catch {
    result.exists = false;
  }

  const displayPath = originalPath && originalPath !== fullPath
    ? `${originalPath} (resolved to: ${fullPath})`
    : fullPath;

  if (result.exists) {
    result.isFile = stats.isFile();
    result.isDir = stats.isDirectory();
    if (kind === 'file' && !result.isFile) {
      result.ok = false;
      result.error = `Error: Path is not a file: ${displayPath}`;
    } else if (kind === 'dir' && !result.isDir) {
      result.ok = false;
      result.error = `Error: Path is not a directory: ${displayPath}`;
    }
    return result;
  }

  if (mustExist) {
    result.ok = false;
    result.suggestions = await suggestSimilarFiles(fullPath);
    const label = kind === 'dir' ? 'Directory' : 'File';
    let message = `Error: ${label} not found: ${displayPath}`;
    if (result.suggestions.length > 0) {
      message += `. Similar files: ${result.suggestions.join(', ')}`;
    }
    result.error = message;
  }

  return result;
}

/**
 * 统一路径解析器（与旧 DefaultPathResolver 兼容的实例 API）
 * 供需要持有默认目录状态的场景使用（如技能脚本的默认输出目录）
 */
export class SkillPathResolver {
  /**
   * @param {Object} [options]
   * @param {string} [options.workspace] - 工作区目录
   * @param {string} [options.agentName='default'] - Agent 名称（用于 {agent} 占位符）
   * @param {string} [options.defaultBaseDir] - 默认基础目录（支持 ~ 与 {agent} 占位符），默认取 workspace
   * @param {boolean} [options.autoCreateTmp=true] - 空输入时是否自动生成临时文件名
   * @param {string} [options.tmpFileName='tmp'] - 临时文件名前缀
   */
  constructor({
    workspace = null,
    agentName = 'default',
    defaultBaseDir = null,
    autoCreateTmp = true,
    tmpFileName = 'tmp'
  } = {}) {
    this.workspace = workspace;
    this.agentName = agentName;
    this.autoCreateTmp = autoCreateTmp;
    this.tmpFileName = tmpFileName;
    this.defaultBaseDir = this._resolveDefaultBaseDir(defaultBaseDir ?? workspace ?? process.cwd());
  }

  /**
   * 解析默认基础目录（支持 {agent} 占位符与 ~ 展开）
   * @private
   */
  _resolveDefaultBaseDir(baseDirTemplate) {
    if (!baseDirTemplate) return process.cwd();
    let resolved = String(baseDirTemplate).replace(/\{agent\}/g, this.agentName);
    resolved = expandHome(resolved);
    return path.resolve(resolved);
  }

  /**
   * 解析文件路径（签名与旧 DefaultPathResolver.resolvePath 兼容）
   * @param {string} inputPath - 输入路径
   * @returns {Promise<Object>} 解析结果 { fullPath, isDefault, isTemporary, ... }
   */
  async resolvePath(inputPath) {
    const result = resolveSkillPath(inputPath, {
      workspace: this.workspace,
      bareFileNameDir: this.defaultBaseDir,
      autoCreateTmp: this.autoCreateTmp,
      tmpFileName: this.tmpFileName
    });

    if (!result.fullPath) {
      throw new Error('No file path specified and auto-create tmp is disabled');
    }

    // 临时文件场景确保目标目录可用
    if (result.isTemporary) {
      await fs.ensureDir(path.dirname(result.fullPath));
    }

    return result;
  }

  /**
   * 确保默认目录存在
   */
  async ensureDefaultDir() {
    try {
      await fs.ensureDir(this.defaultBaseDir);
      return this.defaultBaseDir;
    } catch (error) {
      throw new Error(`Failed to create default directory: ${error.message}`);
    }
  }

  /**
   * 获取默认目录下的子目录路径
   */
  getSubDir(subdirName) {
    return path.join(this.defaultBaseDir, subdirName);
  }

  /**
   * 确保默认目录下的子目录存在
   */
  async ensureSubDir(subdirName) {
    const subDir = this.getSubDir(subdirName);
    try {
      await fs.ensureDir(subDir);
      return subDir;
    } catch (error) {
      throw new Error(`Failed to create subdirectory: ${error.message}`);
    }
  }

  /**
   * 获取默认目录路径
   */
  getDefaultDir() {
    return this.defaultBaseDir;
  }

  /**
   * 判断输入路径是否会走默认目录
   */
  wouldUseDefault(inputPath) {
    if (!inputPath || inputPath.trim() === '') return true;
    const trimmed = expandHome(inputPath.trim());
    if (path.isAbsolute(trimmed)) return false;
    return !trimmed.includes('/') && !trimmed.includes('\\');
  }
}
