/**
 * MP3 帧级无损裁剪
 *
 * 只做一件事：把开头/结尾若干**整帧**丢掉，其余字节原样拼回去。不解码、不重编码，
 * 所以既不需要服务器上有 mp3 编码器（线上 ffmpeg 2.6.8 只有 aac，没有 libmp3lame），
 * 也不会因为二次压缩再掉一档音质。切点落在静音里，听不到任何痕迹。
 *
 * 一律「认不出就放弃」而不是「尽力裁」：帧接不上、带 Xing/Info（VBR 得同步改帧数表）、
 * 自由码率、裁完不足两帧、或者要削掉一半以上时长 —— 都返回 null 让调用方保留原产物。
 * 音频是给用户听的，宁可留着 0.8 秒静音，也不能切掉一个字。
 */

/* ISO/IEC 11172-3 / 13818-3 Layer III 码率表（kbps），索引 0=自由、15=非法 */
const BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR_V1 = [44100, 48000, 32000];
const SR_V2 = [22050, 24000, 16000];
const SR_V25 = [11025, 12000, 8000];

/** 解析一帧的固定头；返回 null 表示这里不是一帧头（同步错/层不符/码率非法）。 */
function parseHeader(buf, p) {
  if (p + 4 > buf.length) return null;
  /* 注意位运算是有符号 int32：帧头首字节 0xFF 时与出来的数是负数，
     必须 >>>0 变回无符号再比，否则永远判不出同步（真实帧头 FF F3 64 C4 就被误拒）。 */
  const h = buf.readUInt32BE(p) >>> 0;
  if (((h & 0xffe00000) >>> 0) !== 0xffe00000) return null; /* 11 位帧同步 */
  const verBits = (h >>> 19) & 0x03;                        /* 00=2.5 10=2 11=1 01=保留 */
  const layerBits = (h >>> 17) & 0x03;                      /* 01=Layer III */
  if (layerBits !== 0x01 || verBits === 0x01) return null;
  const bri = (h >>> 12) & 0x0f;
  const sri = (h >>> 10) & 0x03;
  const pad = (h >>> 9) & 0x01;
  if (bri === 0 || bri === 15 || sri === 3) return null;   /* 自由码率/保留采样率：算不出长度 */
  const mpeg1 = verBits === 0x03;
  const bitrate = (mpeg1 ? BR_V1L3 : BR_V2L3)[bri] * 1000;
  const sampleRate = (mpeg1 ? SR_V1 : verBits === 0x02 ? SR_V2 : SR_V25)[sri];
  const samples = mpeg1 ? 1152 : 576;                      /* Layer III 每帧样点数 */
  const size = Math.floor((mpeg1 ? 144 : 72) * bitrate / sampleRate) + pad;
  if (size < 24 || size > 2000) return null;
  return { size, sampleRate, samples, mpeg1, ver: mpeg1 ? 1 : verBits === 0x02 ? 2 : 25 };
}

/** ID3v2 头长度（synchsafe），没有则 0。 */
function id3v2Len(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  return 10 + size;
}

/**
 * 把整个文件拆成帧序列。
 * @returns {{frames:{off:number,size:number,ms:number}[], totalMs:number, lead:number,
 *            trail:number, sampleRate:number}|null} 解析失败返回 null
 */
export function parse(buf) {
  const lead = id3v2Len(buf);
  let trail = 0;
  if (buf.length - lead > 128 && buf.toString('latin1', buf.length - 128, buf.length - 125) === 'TAG') trail = 128;
  const end = buf.length - trail;
  const frames = [];
  let p = lead;
  let first = null;
  while (p < end) {
    const h = parseHeader(buf, p);
    if (!h) return null;                                   /* 有一帧接不上就说明不是我们能处理的流 */
    if (!first) {
      first = h;
      /* Xing/Info 坐在首帧的边信息区里 ⇒ 这是带 VBR 头的流，改帧数就得改它的总帧表，
         我们没有重编码能力去维护它，直接放弃裁剪。 */
      const span = 4 + (h.mpeg1 ? 32 : 17) + 4;
      if (/Xing|Info/.test(buf.toString('latin1', p + 4, Math.min(end, p + span)))) return null;
    }
    frames.push({ off: p, size: h.size, ms: (h.samples / h.sampleRate) * 1000 });
    p += h.size;
  }
  if (!frames.length || p !== end) return null;            /* 尾部有零头字节：不裁 */
  let totalMs = 0;
  for (const f of frames) totalMs += f.ms;
  return { frames, totalMs, lead, trail, sampleRate: first.sampleRate };
}

/**
 * 按时间裁剪。
 * @param {Buffer} buf 原始 mp3
 * @param {{dropHeadMs?:number, dropTailMs?:number}} opt 头/尾各丢多少毫秒（向下取整到帧边界）
 * @returns {{buf:Buffer, removedHeadMs:number, removedTailMs:number, totalMs:number}|null}
 *          null = 不该裁（调用方保留原文件）
 */
export function cut(buf, { dropHeadMs = 0, dropTailMs = 0 } = {}) {
  const info = parse(buf);
  if (!info) return null;
  const { frames, totalMs, trail } = info;

  let headN = 0;
  let removedHeadMs = 0;
  while (headN < frames.length - 1 && removedHeadMs + frames[headN].ms <= dropHeadMs) {
    removedHeadMs += frames[headN].ms;
    headN++;
  }
  /* 头尾从两端往中间数，彼此不许重叠：短句（一帧说一个字）时尾部就少裁点 */
  let tailN = 0;
  let removedTailMs = 0;
  while (tailN < frames.length - headN - 1) {
    const f = frames[frames.length - 1 - tailN];
    if (removedTailMs + f.ms > dropTailMs) break;
    removedTailMs += f.ms;
    tailN++;
  }

  const keepN = frames.length - headN - tailN;
  /* 保留下限：不足 4 帧不裁；头尾合计削掉四分之三以上也不裁（宁可留着静音，不能切掉字）。 */
  if (keepN < 4 || (headN + tailN) * 4 > frames.length * 3) return null;

  const from = frames[headN].off;
  const to = frames[frames.length - tailN - 1].off + frames[frames.length - tailN - 1].size;
  const parts = [buf.subarray(from, to)];
  if (trail) parts.push(buf.subarray(buf.length - trail));  /* ID3v1 永远跟在最后 128 字节 */
  return { buf: Buffer.concat(parts), removedHeadMs, removedTailMs, totalMs: totalMs - removedHeadMs - removedTailMs };
}
