// 下载/升级 yt-dlp 与 ffmpeg 二进制，全部走已验证的 OpenSSL 通道
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(rootDir, 'bin');

const YTDLP_MIRRORS = [
  'https://gh-proxy.com/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip',
  'https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip',
];
const FFMPEG_URL =
  'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64';

async function download(url, dest) {
  const tmp = dest + '.tmp';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -10;
  const nodeStream = Readable.fromWeb(res.body);
  nodeStream.on('data', (c) => {
    got += c.length;
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  ${path.basename(dest)}: ${pct}%\n`);
      }
    }
  });
  await pipeline(nodeStream, createWriteStream(tmp));
  if (existsSync(dest + '.old')) unlinkSync(dest + '.old');
  if (existsSync(dest)) renameSync(dest, dest + '.old');
  renameSync(tmp, dest);
  return got;
}

async function fetchWithFallback(urls, dest) {
  let lastErr;
  for (const u of urls) {
    try {
      console.log(`try: ${u}`);
      const bytes = await download(u, dest);
      console.log(`OK  ${path.basename(dest)} <- ${(bytes / 1e6).toFixed(1)} MB`);
      return;
    } catch (e) {
      console.log(`FAIL ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

const ytdlp = process.argv.includes('--yt-dlp');
const ffmpeg = process.argv.includes('--ffmpeg');
const all = !ytdlp && !ffmpeg;

if (all || ytdlp) {
  const zipPath = path.join(binDir, 'yt-dlp_win.zip');
  await fetchWithFallback(YTDLP_MIRRORS, zipPath);
  const targetDir = path.join(binDir, 'yt-dlp');
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${targetDir}' -Force`,
  ], { stdio: 'inherit' });
  unlinkSync(zipPath);
  console.log(`OK  yt-dlp extracted -> ${targetDir}`);
}
if (all || ffmpeg) await fetchWithFallback([FFMPEG_URL], path.join(binDir, 'ffmpeg.exe'));
console.log('done');
