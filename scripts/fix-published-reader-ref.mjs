#!/usr/bin/env node
/**
 * 一次性改写已发布书页里的阅读器外链前缀。
 *
 * 背景：章节页是发布时生成的静态产物，<script src="/tts/reader.js"> 被原样写进了 HTML。
 * 站点挂到 /novel 之后，根级 /tts/ 不再由本服务提供（会落到同域的 aiinterview 上 404），
 * 必须改成 <BASE>/tts/reader.js。
 *
 * 只做字符串替换，不重新调用 LLM、不动正文，因此不必「重新发布」——
 * 重发会重跑生词挑选与出题，既慢又会改写已有的内嵌预生成数据。
 *
 * 用法：
 *   node scripts/fix-published-reader-ref.mjs              # 干跑，只报告
 *   node scripts/fix-published-reader-ref.mjs --apply      # 真正改写（就地，逐文件）
 *   node scripts/fix-published-reader-ref.mjs --apply --root=public/novel
 */
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const BASE = (argv.find((a) => a.startsWith('--base=')) || '').slice(7) || '/novel';
const rootArg = (argv.find((a) => a.startsWith('--root=')) || '').slice(7) || 'public/novel';
const ROOT = path.resolve(process.cwd(), rootArg);

const FROM = '<script src="/tts/reader.js"></script>';
const TO = `<script src="${BASE}/tts/reader.js"></script>`;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

if (!fs.existsSync(ROOT)) {
  console.error(`目录不存在：${ROOT}`);
  process.exit(1);
}

const files = walk(ROOT);
let hit = 0, already = 0, written = 0;
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  if (html.includes(TO)) { already++; continue; }
  if (!html.includes(FROM)) continue;
  hit++;
  if (APPLY) {
    // split/join 做字面量全量替换：避开 String.replace 把正文里的 $& / $' 当替换模式展开
    fs.writeFileSync(f, html.split(FROM).join(TO), 'utf8');
    written++;
  } else {
    console.log(`  ${path.relative(process.cwd(), f)}`);
  }
}

console.log(`${APPLY ? '已改写' : '待改写'} ${written || hit} 个文件（扫描 ${files.length} 个 HTML，其中 ${already} 个已是新前缀）`);
if (!APPLY && hit) console.log('确认无误后加 --apply 执行');
