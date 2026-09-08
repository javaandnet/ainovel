/**
 * 拼音转换工具：将汉字文本转为逐字拼音数组（用于 ruby 标注）
 * 发布时调用，结果嵌入章节 HTML 的 reader-data JSON 中。
 */
import { pinyin } from 'pinyin-pro';

/**
 * 去除单个字符串中的 Markdown 标记
 */
function stripInline(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/**
 * 为单个字符生成拼音（带声调符号）
 */
function charToPinyin(ch) {
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) {
    return pinyin(ch, { toneType: 'symbol', type: 'string' });
  }
  return '';
}

/**
 * 为一段纯文本生成逐字拼音数组。
 * @param {string} text - 纯文本段落
 * @returns {string[]} 与字符数组等长的拼音数组，非中文字符位置为 ''
 */
function lineToPinyin(text) {
  const clean = stripInline(text);
  if (!clean) return [];
  return [...clean].map(charToPinyin);
}

/**
 * 从章节 Markdown 正文生成按段划分的拼音数据。
 * 返回的数组长度 = 段落数，前端按 index 对应 <p> 元素。
 * @param {string} content - 章节 Markdown 正文
 * @returns {string[][]} 每个段落的拼音数组
 */
export function generatePinyinData(content) {
  const raw = String(content || '')
    .replace(/^#{1,6}\s+.*$/gm, '')  // 去标题行
    .replace(/<[^>]+>/g, '')          // 去 HTML 标签
    .trim();
  const paragraphs = raw.split(/\n\s*\n/); // 按空行分段
  return paragraphs
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(lineToPinyin);
}
