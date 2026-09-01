/**
 * 中文数字工具
 *
 * 小说里"第X部 / 第X章"这类标题必须用中文数字（"第十一章"而不是"第11章"），
 * 生成侧（writerTool）与发布侧（novelPublisher）都要用，故抽为公共模块，
 * 避免两处各写一份映射表而写法不一致。
 */

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/**
 * 阿拉伯数字转中文数字，支持 1–999
 * @param {number|string} num - 待转换的整数
 * @returns {string} 中文数字（如 1→一、11→十一、105→一百零五、110→一百一十）
 * @throws {Error} 超出 1–999 或非整数时直接报错，不做静默近似（近似会产出错误标题）
 */
export function toChinese(num) {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    throw new Error(`toChinese 仅支持 1–999 的整数，收到: ${JSON.stringify(num)}`);
  }

  if (n < 10) return DIGITS[n];

  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    // 10→十、11→十一（十位为 1 时省略"一"）
    return `${tens === 1 ? '' : DIGITS[tens]}十${ones ? DIGITS[ones] : ''}`;
  }

  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return `${DIGITS[hundreds]}百`;
  if (rest < 10) return `${DIGITS[hundreds]}百零${DIGITS[rest]}`;

  const tens = Math.floor(rest / 10);
  const ones = rest % 10;
  // 三位数里十位的“一”不能省略：110 是“一百一十”而不是“一百十”；
  // “十/十一”这种省略只适用于两位数本身（上面 n < 100 分支）
  return `${DIGITS[hundreds]}百${DIGITS[tens]}十${ones ? DIGITS[ones] : ''}`;
}

/**
 * 生成"第X部 / 第X章"形式标题
 * @param {number|string} num - 序号
 * @param {string} unit - 量词，默认"章"
 * @returns {string} 如"第三章"、"第一部"
 */
export function toChineseOrdinal(num, unit = '章') {
  return `第${toChinese(num)}${unit}`;
}

export default toChinese;
