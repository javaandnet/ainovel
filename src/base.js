/**
 * 站点挂载前缀（BASE_PATH）—— 前缀感知的唯一权威来源
 *
 * 背景：生产环境 nginx 把 https://ai.fsr.co.jp/novel/ 按前缀**原样**转发到本服务
 * （proxy_pass 不带 URI，不剥前缀），因此本进程必须知道自己挂在 /novel 之下：
 * 对外暴露的 API / 登录页 / 朗读资源 / 管理页都要带这个前缀，否则请求会落到
 * 同域的 aiinterview（它按白名单守卫独占根级 /api/*，两套语义不能混用）。
 *
 * 不剥前缀 + 只给四个应用命名空间加前缀，是为了让书页路径保持原样：
 * 书页本就挂在内部 /novel 挂载点上（<BASE>/<uid>/<小说名>/chapter_x.html），
 * 与外部前缀重名，若一并平移会出现 /novel/novel/... 双前缀。
 *
 * 本地开发同样默认 /novel —— 开发态与线上态 URL 完全一致，
 * 避免「本机好使、过 nginx 就挂」这类只在代理后才暴露的缺陷。
 */

/** 归一化：去空白、去尾斜杠；显式传空串表示挂在根路径 */
const BASE_PATH = String(process.env.BASE_PATH ?? '/novel').trim().replace(/\/+$/, '');

// 书页的内部挂载点写死为 /novel（server.js 的 app.use('/novel', …)），且外部前缀
// 不剥除，所以 BASE_PATH 只能是『不挂』或『正好挂在 /novel』。其它值会让书页整站 404
// 而接口一切正常 —— 与其上线后查半天，不如启动即报错。
if (BASE_PATH !== '' && BASE_PATH !== '/novel') {
  throw new Error(
    `BASE_PATH 只能取 '' 或 '/novel'（当前: '${process.env.BASE_PATH}'）：` +
    '书页挂在内部 /novel 挂载点上，前缀原样透传时两者必须一致。'
  );
}

/**
 * 需要带前缀的应用命名空间（相对 BASE 的内部路径）。
 * 其余路径（书页 /<uid>/... 、根落地页 /）原样放行，不做平移。
 */
const APP_NAMESPACES = /^\/(api|login|tts|tts-audio|admin)(\/|\?|$)/;

/** 书页（已发布站点）的对外路径：书页直接挂在 BASE 下，不再叠加 /novel */
function sitePath(...segs) {
  return `${BASE_PATH}/${segs.join('/')}`.replace(/\/{2,}/g, '/');
}

export { BASE_PATH, APP_NAMESPACES, sitePath };
