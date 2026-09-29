/**
 * 静音探针：借 ffmpeg 只**测量**人声起止点，不动音频一个字节。
 *
 * 为什么不让 ffmpeg 顺手把静音裁了：它必须重编码才出得来文件，而线上那份 ffmpeg 2.6.8
 * 根本没编 mp3 的能力（只有 libfaac / libfdk_aac），退化成 aac 就要连容器、Content-Type、
 * 前端 <audio> 假设一起改。何况二次压缩还要再掉一档音质。
 * 所以这里只拿 silencedetect 的时间戳，真正剪由 mp3Cut 做无损整帧丢弃。
 *
 * 版本口径要盯紧（2.6.8 与 8.x 输出不同）：对从 0 秒就开始的那段静音，
 * 旧版只报 silence_end、不报 silence_start，新版两个都报 —— 两种都得认。
 */
import { spawn, spawnSync } from 'child_process';

const DEFAULTS = { noiseDb: -40, minSilenceS: 0.04 };

let _ready;   /* undefined=没查过，null=没有 ffmpeg，true=可用 */

/** ffmpeg 是否可用（只查一次，避免每句都 fork 一个探测进程）。 */
export function ffmpegAvailable() {
  if (_ready !== undefined) return _ready;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 8000, encoding: 'utf8' });
    _ready = !r.error && r.status === 0;
  } catch {
    _ready = false;
  }
  if (!_ready) console.warn('[silenceProbe] 未找到可用的 ffmpeg，句首句尾静音将不裁剪（不影响朗读，只是空档保留）');
  return _ready;
}

/** 跑一次 silencedetect，抓 stderr 里的事件序列。 */
function detect(absPath, { noiseDb, minSilenceS }) {
  return new Promise((resolve) => {
    let err = '';
    let child;
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-v', 'info', '-i', absPath,
        '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceS}`, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { resolve({ error: e.message }); return; }
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 15000);
    child.stderr.on('data', (c) => { err += c.toString(); if (err.length > 200000) err = err.slice(-100000); });
    child.on('error', (e) => { clearTimeout(kill); resolve({ error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code !== 0 && !/silence_/.test(err)) resolve({ error: `ffmpeg 退出码 ${code}：${err.slice(-160).replace(/\s+/g, ' ')}` });
      else resolve({ events: [...err.matchAll(/silence_(start|end):\s*([0-9.]+)/g)].map((m) => [m[1], parseFloat(m[2])]) });
    });
  });
}

/**
 * 量出这一段音频的头/尾静音时长。
 * @param {string} absPath 音频绝对路径
 * @param {{totalMs:number}} opt 总时长（由 mp3Cut 帧数算出，不必再起 ffprobe）
 * @returns {Promise<{headMs:number, tailMs:number}|null>} 探不出来返回 null（调用方就不裁）
 */
export async function probeSilence(absPath, { totalMs, ...opt } = {}) {
  if (!ffmpegAvailable()) return null;
  const o = { ...DEFAULTS, ...opt };
  const r = await detect(absPath, o);
  if (!r || r.error || !Array.isArray(r.events)) {
    if (r && r.error) console.warn(`[silenceProbe] 探测失败（本条不裁剪）：${r.error}`);
    return null;
  }
  const ev = r.events;
  const totalS = totalMs / 1000;
  /* 先把 start/end 事件归并成一段一段的静音，再只看首尾两段。
     不能直接拿“最后一个事件是 start”判收尾：新版 ffmpeg 会在文件末尾补一条 end，
     旧版 2.6.8 则不补（留个开口的 start），两种口径都得认。同理旧版对 0 秒起点的
     那段静音只报 end、不报 start。 */
  const runs = [];
  let open = null;
  for (const [k, t] of ev) {
    if (k === 'start') { if (open) runs.push(open); open = { start: t }; }
    else if (open) { runs.push({ start: open.start, end: t }); open = null; }
    else runs.push({ start: 0, end: t });
  }
  if (open) runs.push({ start: open.start, end: totalS });

  let headMs = 0;
  let tailMs = 0;
  if (runs.length) {
    const first = runs[0];
    /* 旧版 ffmpeg 对 0 秒起点的静音会把 start 报成负数（实测 -0.016），取非负再算长度，
       否则头部会多裁掉十几毫秒。 */
    if (first.start <= 0.03) headMs = (first.end - Math.max(0, first.start)) * 1000;
    const last = runs[runs.length - 1];
    if (last.end >= totalS - 0.06) tailMs = (totalS - last.start) * 1000;   /* 末段一直延到结尾 */
  }
  /* 夹逼：单项不许为负、不许超 1.5s；再看“剩下多少人声”。
     不能简单拿“静音不得过半”当线：短句（如“什么？”）整句 1.0s 而尾部静音占 0.67s，
     恰恰是最该裁的那类。改成看裁完还剩多少有声部分：不足 200ms 就当探测不可信。 */
  const clamp = (v) => Math.max(0, Math.min(1500, v || 0));
  headMs = clamp(headMs);
  tailMs = clamp(tailMs);
  if (headMs + tailMs > totalMs * 0.75) return null;
  if (totalMs - headMs - tailMs < 200) return null;
  return { headMs, tailMs };
}
