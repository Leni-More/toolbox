import { spawn } from 'node:child_process';
import { openSync, closeSync, readSync, readFileSync, fstatSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export { ROOT };
export const YTDLP = path.join(ROOT, 'bin', 'yt-dlp', 'yt-dlp.exe');
export const FFMPEG_DIR = path.join(ROOT, 'bin');
export const TMP_DIR = path.join(ROOT, 'tmp');
export const DOWNLOAD_DIR = path.join(ROOT, 'downloads');

mkdirSync(TMP_DIR, { recursive: true });

// 沙箱环境踩坑结论:
// 1) yt-dlp 子进程的 TEMP 必须指向 workspace 内可写目录
// 2) DSH 沙箱禁止 stdio 管道型 spawn(EPERM), 文件句柄重定向可行
//    => 输出写临时文件, 增量轮询按行回调, 接口语义与流式一致
// 3) yt-dlp.exe(PyInstaller) 的 stdout 恒为 GBK, PYTHONUTF8/PYTHONIOENCODING 均无效
//    => 统一按 GBK 解码(ASCII 与 -J 的 \uXXXX 转义 JSON 完全兼容), 尾字节防截断
const GBK = new TextDecoder('gbk');

export function spawnYtDlp(args, onLine) {
  return new Promise((resolvePromise, reject) => {
    const stamp = `${process.pid}-${Date.now()}`;
    const outPath = path.join(TMP_DIR, `ytdlp-${stamp}.out`);
    const errPath = path.join(TMP_DIR, `ytdlp-${stamp}.err`);
    const outFd = openSync(outPath, 'w');
    const errFd = openSync(errPath, 'w');

    const child = spawn(YTDLP, args, {
      cwd: ROOT,
      env: { ...process.env, TEMP: TMP_DIR, TMP: TMP_DIR, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });

    let outOffset = 0;
    const POLL_MS = 250;
    const timer = setInterval(() => {
      outOffset = pumpFile(outPath, outOffset, onLine);
    }, POLL_MS);

    child.on('error', (e) => { cleanup(); reject(e); });
    child.on('close', (code) => {
      clearInterval(timer);
      pumpFile(outPath, outOffset, onLine);
      const stderr = GBK.decode(readFileSync(errPath));
      cleanup();
      if (code === 0) resolvePromise({ code, stderr });
      else reject(new Error(`yt-dlp exit ${code}: ${(stderr || '').trim().slice(-800)}`));
    });

    function cleanup() {
      try { closeSync(outFd); closeSync(errFd); } catch { /* ignore */ }
      try { unlinkSync(outPath); unlinkSync(errPath); } catch { /* ignore */ }
    }
  });

  function pumpFile(file, offset, cb) {
    let fd;
    try { fd = openSync(file, 'r'); } catch { return offset; }
    try {
      let size = fstatSync(fd).size;
      // GBK 双字节汉字(首字节 0x81-0xFE)可能被轮询边界切断, 留给下一轮
      if (size > offset) {
        const tail = Buffer.alloc(1);
        readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] >= 0x81 && tail[0] <= 0xfe) size -= 1;
      }
      if (size <= offset) return offset;
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      cb(GBK.decode(buf));
      return size;
    } finally {
      closeSync(fd);
    }
  }
}

const PLATFORMS = [  { key: 'douyin', test: /douyin\.com|iesdouyin\.com/i, name: '抖音' },
  { key: 'bilibili', test: /bilibili\.com|b23\.tv/i, name: 'B站' },
  { key: 'xiaohongshu', test: /xiaohongshu\.com|xhslink\.com/i, name: '小红书' },
  { key: 'kuaishou', test: /kuaishou\.com/i, name: '快手' },
  { key: 'weibo', test: /weibo\.com|weibo\.cn/i, name: '微博' },
  { key: 'youtube', test: /youtube\.com|youtu\.be/i, name: 'YouTube' },
];

// 从抖音/B站分享口令文本中提取纯链接: "5.38 复制打开抖音 ... https://v.douyin.com/xxx/ 08/22 ..."
export function extractUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s"'<>【】（）()，。]+/i);
  if (!m) return null;
  // 剥离可能粘连在 URL 尾部的标点残留(保留合法的末尾斜杠)
  return m[0].replace(/[.,;:!?"')\]】」』、。,,;;!!??..]+$/, '');
}

// 抖音风控要求新鲜 cookies(仅需 ttwid 指纹, 无需登录)。
// 从字节官方 ttwid 服务申领后写成 Netscape cookies.txt 喂给 yt-dlp
async function getTtwid() {
  const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA_DESKTOP,
    },
    body: JSON.stringify({
      region: 'cn',
      aid: 1768,
      needFid: false,
      service: 'www.ixigua.com',
      migrate_info: { ticket: '', source: 'node' },
      cbUrlProtocol: 'https',
      union: true,
    }),
  });
  let ttwid = null;
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const m = c.match(/ttwid=([^;]+)/);
    if (m) ttwid = m[1];
  }
  if (!ttwid) {
    try { ttwid = (await res.json())?.data?.ttwid || null; } catch { /* ignore */ }
  }
  if (!ttwid) throw new Error('ttwid 申领失败');
  return ttwid;
}

function writeNetscapeCookies(file, domain, cookies) {
  const exp = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
  const lines = Object.entries(cookies).map(([k, v]) => [domain, 'TRUE', '/', 'FALSE', String(exp), k, v].join('\t'));
  writeFileSync(file, `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`, 'utf8');
}

// B站 412 修复: 裸请求缺 b_nut(首访时间戳)被风控判异常;
// 首页采集 Set-Cookie + spi 接口补 buvid3/buvid4, 与真浏览器首访行为一致
let biliCookieCache = null;
async function biliCookies() {
  if (biliCookieCache && Date.now() - biliCookieCache.at < 30 * 60 * 1000) return biliCookieCache.file;
  const jar = {};
  const home = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA_DESKTOP } });
  await home.text().catch(() => '');
  for (const c of (home.headers.getSetCookie?.() || [])) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m && m[2]) jar[m[1].trim()] = m[2];
  }
  const spi = await (await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://www.bilibili.com/' },
  })).json().catch(() => null);
  if (spi?.data?.b_3) jar.buvid3 = spi.data.b_3;
  if (spi?.data?.b_4) jar.buvid4 = spi.data.b_4;
  const file = path.join(TMP_DIR, 'bili-cookies.txt');
  writeNetscapeCookies(file, '.bilibili.com', jar);
  biliCookieCache = { at: Date.now(), file };
  return file;
}

// 需要 cookies 的平台返回注入参数; 其余返回空数组
export async function cookieArgs(url) {
  if (/douyin\.com|iesdouyin\.com/i.test(url)) {
    const ttwid = await getTtwid();
    const file = path.join(TMP_DIR, 'douyin-cookies.txt');
    writeNetscapeCookies(file, '.douyin.com', { ttwid });
    return ['--cookies', file];
  }
  if (/bilibili\.com|b23\.tv/i.test(url)) {
    return ['--cookies', await biliCookies()];
  }
  return [];
}

export function detectPlatform(url) {
  for (const p of PLATFORMS) if (p.test.test(url)) return p;
  return { key: 'other', name: '未知平台' };
}

function pickFormats(formats) {
  // 只保留含视频的流，去重按分辨率从高到低; 另加 bestaudio 供合并
  const seen = new Map();
  for (const f of formats || []) {
    if (!f.vcodec || f.vcodec === 'none') continue;
    if (f.protocol && /m3u8/.test(f.protocol)) continue;
    const key = f.height || 0;
    const prev = seen.get(key);
    if (!prev || (f.tbr || 0) > (prev.tbr || 0)) seen.set(key, f);
  }
  const list = [...seen.values()]
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .map((f) => ({
      format_id: f.format_id,
      label: f.height ? `${f.height}P` : f.format_id,
      ext: f.ext,
      fps: f.fps || null,
      vcodec: f.vcodec,
      filesize: f.filesize || f.filesize_approx || null,
      note: f.format_note || '',
    }));
  return list;
}

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
export { UA_MOBILE };

// yt-dlp 官方 Douyin extractor 需要 s_v_web_id 签名 cookie(源码标注 TODO 未实现),
// 改走社区验证路线: 跟随短链 → 带 ttwid 拉 iesdouyin 分享页 → 抠 _ROUTER_DATA 的 item_list
export async function resolveDouyin(url) {
  const ttwid = await getTtwid();
  // 两步走: fetch 跟随跨域 302 时不转发 Cookie, 先拿最终地址, 再显式带 ttwid 请求分享页
  const probe = await fetch(url, { headers: { 'User-Agent': UA_MOBILE }, redirect: 'follow' });
  await probe.text().catch(() => '');
  const finalUrl = probe.url || url;
  const idMatch = finalUrl.match(/\/(?:share\/)?(?:video|note|slides)\/(\d+)/);
  const itemId = idMatch ? idMatch[1] : null;
  const shareUrl = itemId
    ? `https://www.iesdouyin.com/share/video/${itemId}/`
    : finalUrl;
  const r = await fetch(shareUrl, { headers: { 'User-Agent': UA_MOBILE, Cookie: `ttwid=${ttwid}` }, redirect: 'follow' });
  const html = await r.text();
  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*<\/script>/s);
  if (!m) throw new Error('抖音解析失败: 未找到页面数据');
  const data = JSON.parse(m[1]);
  const loader = data.loaderData || {};
  // loader 含多个 video* 键(video_layout 等), 定位真正带数据的那个
  const pageKey = Object.keys(loader).find((k) => loader[k]?.videoInfoRes?.item_list?.length);
  const item = pageKey ? loader[pageKey].videoInfoRes.item_list[0] : null;
  if (!item) throw new Error('抖音解析失败: 数据为空');

  const base = {
    platform: 'douyin',
    platformName: '抖音',
    webpage_url: url,
    title: (item.desc || '抖音作品').slice(0, 80),
    uploader: item.author?.nickname || null,
    duration: item.duration ? Math.round(item.duration / 1000) : null,
    thumbnail: item.video?.cover?.url_list?.[0] || null,
  };

  const images = item.images || [];
  if (images.length) {
    return {
      ...base,
      is_collection: true,
      kind: 'gallery',
      count: images.length,
      entries: images.map((img, i) => {
        const urls = img.url_list || [];
        return {
          index: i + 1,
          title: `${base.title} - ${i + 1}`,
          thumbnail: urls[0] || null,
          url: urls[urls.length - 1] || urls[0],
        };
      }),
    };
  }

  const urls = item.video?.play_addr?.url_list || [];
  const directUrl = urls[0] || null;
  if (!directUrl) throw new Error('抖音解析失败: 未取得播放地址');
  return {
    ...base,
    is_collection: false,
    kind: 'video',
    directUrl,
    formats: [{ format_id: 'origin', label: '原画质', ext: 'mp4' }],
  };
}

export async function resolveUrl(url) {
  const platform = detectPlatform(url);
  if (platform.key === 'douyin') return resolveDouyin(url);
  const { json } = await dumpJson(url);
  const base = {
    platform: platform.key,
    platformName: platform.name,
    webpage_url: json.webpage_url || url,
    title: json.title || '未命名',
    uploader: json.uploader || json.channel || null,
    duration: json.duration || null,
    thumbnail: json.thumbnail || null,
    is_collection: Boolean(json._type === 'playlist'),
  };
  if (json._type === 'playlist') {
    const entries = (json.entries || []).map((e, i) => ({
      index: i + 1,
      id: e.id,
      title: e.title || `条目 ${i + 1}`,
      thumbnail: e.thumbnails?.length ? e.thumbnails[e.thumbnails.length - 1].url : null,
      duration: e.duration || null,
    }));
    return {
      ...base,
      collection_title: json.title,
      count: entries.length,
      entries,
      // 图集类型(抖音图片)每条都是一张图, 视频合集每条是一个视频
      kind: /gallery|图集/.test(json.title || '') ? 'gallery' : 'collection',
    };
  }
  return {
    ...base,
    is_collection: false,
    kind: 'video',
    formats: pickFormats(json.formats),
    best: {
      format_id: 'bv*+ba/b',
      label: '最佳画质',
    },
  };
}

async function dumpJson(url) {
  let out = '';
  const extra = await cookieArgs(url);
  await spawnYtDlp(['-J', '--flat-playlist', '--no-warnings', ...extra, url], (line) => {
    out += line + '\n';
  });
  // -J 的 JSON 是完整多行输出, 找到第一个 { 开始解析
  const start = out.indexOf('{');
  if (start < 0) throw new Error('解析失败: 未获得 JSON 输出');
  const json = JSON.parse(out.slice(start));
  return { json };
}
