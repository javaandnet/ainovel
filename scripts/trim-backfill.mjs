#!/usr/bin/env node
/**
 * 一次性回填：把已缓存的 TTS 音频裁掉首尾静音，并把尾部留白记进库。
 *
 * 背景：微软边缘接口每条产物自带约 0.15s 头静音 + 0.67s 尾静音（按音色固定，实测 45 条），
 * 逐句朗读时每个句界白等约 0.84s —— 听感就是「两句之间断一下」。裁剪逻辑挂在合成路径上，
 * 但整本书的句子大多早已入库，命中缓存就不再走合成，所以老音频得在这里补一刀。
 * 不回填，读者听到的停顿和改之前一模一样。
 *
 * 裁法是「ffmpeg 只量静音边界 + 纯 JS 整帧丢弃」，不重编码（线上 ffmpeg 2.6.8 没有 mp3
 * 编码器），认不出就跳过，绝不会切掉一个字。
 *
 * 跑之前请先备份 data/tts（就地改写音频文件，出错没有回退点）：
 *   tar czf /tmp/tts-backup-$(date +%Y%m%d).tar.gz data/tts
 *
 * 用法：
 *   node scripts/trim-backfill.mjs                 # 干跑，只报告每条的量测与预计结果
 *   node scripts/trim-backfill.mjs --apply         # 真正裁剪并写库
 *   node scripts/trim-backfill.mjs --apply --limit=20
 *
 * 幂等：只处理 tail_pad_ms 为空的行，重跑不会二次裁剪。
 */
import { backfillTrim } from '../src/reader/ttsStore.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const limit = Number((argv.find((a) => a.startsWith('--limit=')) || '').slice(8) || 0) || 0;

const t0 = Date.now();
try {
  const r = await backfillTrim({ dryRun: !APPLY, limit });
  console.log([
    `${APPLY ? '回填' : '干跑'}完成：候选 ${r.scanned} 条`,
    `  ${APPLY ? '已裁剪' : '可裁剪'} ${r.trimmed} 条`,
    `  跳过 ${r.skipped} 条（认不出格式 / 探测不可信 / 文件缺失）`,
    `  ${APPLY ? '省下' : '预计省下'} ${(r.savedBytes / 1024).toFixed(1)} KB`,
    `  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  ].join('\n'));
  if (!APPLY) console.log('以上为干跑，未改动文件。确认无误后加 --apply 执行。');
} catch (err) {
  console.error(`回填失败：${err.message}`);
  process.exitCode = 1;
}
