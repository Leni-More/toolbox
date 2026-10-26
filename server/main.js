import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUrl, extractUrl, YTDLP, DOWNLOAD_DIR, TMP_DIR } from './resolver.js';
import { DownloadManager } from './downloader.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PORT = 8600;

for (const d of [DOWNLOAD_DIR, TMP_DIR, DATA_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const app = express();
app.use(express.json());
app.use(express.static(WEB_DIR));

const manager = new DownloadManager();

// ---------- history ----------
function loadHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { downloads: [] };
  }
}
function saveHistory(h) {
  writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf8');
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      total += st.isDirectory() ? dirSize(p) : st.size;
    }
  } catch { /* ignore */ }
  return total;
}

manager.on('done', (task) => {
  const h = loadHistory();
  const file = task.file && task.file.startsWith(DOWNLOAD_DIR) ? task.file : task.files[0] || null;
  let size = null;
  try {
    if (file) {
      const st = statSync(file);
      size = st.isDirectory() ? dirSize(file) : st.size;
    }
  } catch { /* ignore */ }
  h.downloads.unshift({
    id: task.id,
    time: new Date().toISOString(),
    title: task.title || path.basename(file || '未命名'),
    file: file ? path.relative(ROOT, file) : null,
    size,
  });
  if (h.downloads.length > 200) h.downloads.length = 200;
  saveHistory(h);
});

// ---------- SSE ----------
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', tasks: [...manager.tasks.values()].map((t) => manager.public(t)) })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event) {
  for (const res of sseClients) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
manager.on('update', (t) => broadcast({ type: 'task', task: t }));
manager.on('done', (t) => broadcast({ type: 'done', task: t }));
manager.on('error', (t) => broadcast({ type: 'error', task: t }));

// ---------- api ----------
app.post('/api/resolve', async (req, res) => {
  try {
    const url = extractUrl(req.body?.url);
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: '未在输入中找到合法链接' });
    const info = await resolveUrl(url.trim());
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 600) });
  }
});

app.post('/api/download', (req, res) => {
  const raw = req.body || {};
  const url = extractUrl(raw.url);
  const { formatId, mode, items, title, directUrl, directUrls } = raw;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: '未在输入中找到合法链接' });
  if (mode === 'gallery' && (!Array.isArray(items) || !items.length)) {
    return res.status(400).json({ error: '请至少选择一张图片' });
  }
  const task = manager.create({ url: url.trim(), formatId, mode, items, title, directUrl, directUrls });
  res.json({ id: task.id });
});

app.get('/api/tasks', (req, res) => {
  res.json([...manager.tasks.values()].map((t) => manager.public(t)));
});

app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

app.post('/api/reveal', (req, res) => {
  const { target } = req.body || {};
  const abs = target ? path.resolve(ROOT, target) : DOWNLOAD_DIR;
  if (!abs.startsWith(ROOT)) return res.status(400).json({ error: '路径越界' });
  const child = spawn('explorer', ['/select,', abs], { stdio: 'ignore', detached: true });
  child.unref();
  res.json({ ok: true });
});

app.get('/api/meta', (req, res) => {
  res.json({
    version: '0.1.0',
    downloadDir: DOWNLOAD_DIR,
    ytDlp: existsSync(YTDLP),
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`toolbox ready: http://127.0.0.1:${PORT}`);
});
