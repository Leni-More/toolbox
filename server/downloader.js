import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnYtDlp, cookieArgs, FFMPEG_DIR, DOWNLOAD_DIR, ROOT, UA_MOBILE } from './resolver.js';

function safeName(s) {
  return String(s || 'download').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}
export class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
  }

  create({ url, formatId, mode, items, title, directUrl, directUrls }) {
    const id = randomUUID().slice(0, 8);
    const task = {
      id,
      url,
      formatId: formatId || null,
      mode: mode || 'video', // video | audio | gallery
      items: items || null,  // 合集选择的条目序号数组
      directUrl: directUrl || null,
      directUrls: directUrls || null,
      status: 'queued',
      title: title || null,
      file: null,
      files: [],
      progress: 0,
      speed: null,
      eta: null,
      itemIndex: 0,
      itemCount: items ? items.length : (directUrls ? directUrls.length : 0),
      error: null,
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.emit('update', this.public(task));
    this.run(task).catch(() => {});
    return task;
  }

  public(t) {
    return { ...t };
  }

  patch(t, fields) {
    Object.assign(t, fields);
    this.emit('update', this.public(t));
  }

  async run(task) {
    // 抖音图集: 图片为静态 CDN 直链, Node 直连下载(文件名与进度可控), 不走 yt-dlp
    if (task.mode === 'gallery' && task.directUrls?.length) return this.runDirectGallery(task);
    const extra = await cookieArgs(task.url);
    const args = ['--newline', ...extra, '--no-warnings', '--ffmpeg-location', FFMPEG_DIR, '-P', DOWNLOAD_DIR];

    if (task.mode === 'audio') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (task.mode === 'video' && task.formatId && task.formatId !== 'best') {
      args.push('-f', `${task.formatId}+ba/b`, '--merge-output-format', 'mp4');
    }
    // 合集/图集: 输出到 "合集名/" 子目录; 单视频: 直接 downloads 根目录
    if (task.items) {
      args.push('-o', '%(playlist_title).60s/%(title).80s.%(ext)s');
      args.push('--playlist-items', task.items.join(','));
    } else if (!task.directUrl) {
      args.push('-o', '%(title).80s.%(ext)s');
    }
    // Windows 文件名自动清洗, 保留中文; 不用 --restrict-filenames(会把中文变下划线)
    args.push('--windows-filenames', '--no-mtime');
    // 抖音等自研解析平台: 下载直链(generic), 移动端 UA 防直链风控;
    // generic 的 %(title) 取自 CDN 路径(如 main.mp4), 直接指定字面文件名
    if (task.directUrl) {
      args.push('--user-agent', UA_MOBILE);
      args.push('-o', `${safeName(task.title || 'douyin_video')}.%(ext)s`);
      args.push(task.directUrl);
    } else {
      args.push(task.url);
    }

    this.patch(task, { status: 'downloading' });

    try {
      await spawnYtDlp(args, (line) => this.parseLine(task, line));
      this.patch(task, { status: 'done', progress: 100 });
      this.emit('done', this.public(task));
    } catch (e) {
      this.patch(task, { status: 'error', error: String(e.message || e).slice(0, 600) });
      this.emit('error', this.public(task));
    }
  }

  // 抖音图集直连下载: 逐张 fetch, 文件名 "序号.jpg" 落在 标题/ 目录
  async runDirectGallery(task) {
    const dir = path.join(DOWNLOAD_DIR, safeName(task.title || '抖音图集'));
    mkdirSync(dir, { recursive: true });
    this.patch(task, { status: 'downloading' });
    const urls = task.directUrls || [];
    try {
      let i = 0;
      for (const u of urls) {
        i++;
        const res = await fetch(u, { headers: { 'User-Agent': UA_MOBILE } });
        if (!res.ok) throw new Error(`图片 ${i} 下载失败: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const isPng = (res.headers.get('content-type') || '').includes('png');
        const file = path.join(dir, `${String(i).padStart(3, '0')}.${isPng ? 'png' : 'jpg'}`);
        writeFileSync(file, buf);
        this.patch(task, {
          itemIndex: i,
          file,
          files: [...task.files, file],
          progress: Math.round((i / urls.length) * 100),
        });
      }
      this.patch(task, { status: 'done', progress: 100, file: dir });
      this.emit('done', this.public(task));
    } catch (e) {
      this.patch(task, { status: 'error', error: String(e.message || e).slice(0, 600) });
      this.emit('error', this.public(task));
    }
  }

  parseLine(task, line) {
    let m;
    if ((m = line.match(/\[download\] Destination: (.+)/))) {
      const f = m[1];
      this.patch(task, { file: f, files: task.files.includes(f) ? task.files : [...task.files, f] });
    } else if ((m = line.match(/\[Merger\] Merging formats into "(.+)"/))) {
      this.patch(task, { status: 'merging', file: m[1] });
    } else if ((m = line.match(/\[ExtractAudio\] Destination: (.+)/))) {
      this.patch(task, { file: m[1], files: [...task.files, m[1]] });
    } else if ((m = line.match(/\[download\] Downloading item (\d+) of (\d+)/))) {
      this.patch(task, { itemIndex: Number(m[1]), itemCount: Number(m[2]) });
    } else if ((m = line.match(/\[download\] (.+) has already been downloaded/))) {
      // 跳过分支: yt-dlp 输出相对路径(downloads\xxx.mp4), 归一为绝对路径供历史/大小统计
      const abs = path.isAbsolute(m[1]) ? m[1] : path.resolve(ROOT, m[1]);
      this.patch(task, { file: abs, files: task.files.includes(abs) ? task.files : [...task.files, abs] });
    } else if ((m = line.match(/\[download\]\s+([\d.]+)% of\s+~?\s*([\d.]+\w+)(?: at\s+(\S+))?(?: ETA (\S+))?/))) {
      const base = task.itemCount > 1 ? ((task.itemIndex - 1) / task.itemCount) * 100 : 0;
      const span = task.itemCount > 1 ? 100 / task.itemCount : 100;
      this.patch(task, {
        progress: Math.min(100, Math.round(base + (Number(m[1]) * span) / 100)),
        speed: m[3] && m[3] !== 'Unknown speed' ? m[3] : task.speed,
        eta: m[4] || task.eta,
      });
    }
  }
}
