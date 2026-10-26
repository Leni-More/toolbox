# 工具箱 · 视频下载器

本地 Web 工具箱：粘贴链接，下载抖音 / B站等主流平台的视频与图片。

> 启动方法见 [启动方法.md](启动方法.md)

## 支持平台

- B站：视频（多清晰度选择）、番剧与合集（列表勾选）
- 抖音：视频、图集（九宫格勾选）——自研解析路线（见下）
- 快手 / 小红书 / 微博：通用解析管道
- YouTube：需系统代理时给 yt-dlp 传 `--proxy`

短链自动跟随：`v.douyin.com`、`b23.tv` 直接粘贴即可，抖音/B站的整段分享口令文本也能直接粘贴（自动提取链接）。

## 抖音实现路线（平台改版排查入口）

yt-dlp 官方 Douyin extractor 需要 `s_v_web_id` 签名 cookie（源码标注 TODO 未实现），故自研：

1. 从字节官方服务申领 `ttwid`：`POST https://ttwid.bytedance.com/ttwid/union/register/`
2. 跟随分享短链 302 拿最终 URL，抽出作品 ID（fetch 跨域重定向不转发 Cookie，必须两步）
3. 带 `Cookie: ttwid=...` 请求 `https://www.iesdouyin.com/share/video/{id}/`（移动 UA）
4. 从页面 `window._ROUTER_DATA` 里取 `loaderData['video_(id)/page'].videoInfoRes.item_list[0]`
5. 视频：`video.play_addr.url_list[0]` 直链交给 yt-dlp generic（移动 UA）；图集：`images[].url_list` Node 直连下载

已知边界：**实况图（Live Photo）只支持静态图部分**。实况的 MOV 视频段被字节从免签数据源（分享页）裁剪，
桌面版 detail 接口需要浏览器级指纹 + a_bogus 签名，本工具箱不引入该依赖链。

调试脚本：`scripts/test-douyin.mjs`。若抖音解析失效，先跑它定位失效在哪一层（ttwid / 分享页 / _ROUTER_DATA）。

## 架构

```
server/main.js       Express 入口: API + SSE + 静态托管 (端口 8600)
server/resolver.js   链接解析 (B站等走 yt-dlp -J; 抖音自研 share 页解析)
server/downloader.js 任务管理: 进度解析 / 合集分片 / 状态机
web/index.html       前端单页 (零构建)
bin/                 yt-dlp (目录式发行版) + ffmpeg 6.1.1
downloads/           下载输出目录
data/history.json    历史记录
```

## 内核升级

平台改版导致解析失败时，升级 yt-dlp 即可：

```powershell
npm run update-bin      # 或 node scripts/update-bin.mjs --yt-dlp
```

## 平台风控对策（重要）

- **B站 412 Precondition Failed**：B站要求请求携带首访 cookie（`b_nut` 时间戳 + `buvid3/buvid4` 指纹），裸请求直接被判异常。下载器会自动访问 bilibili.com 首页采集 Set-Cookie 并调 `x/frontend/finger/spi` 补 buvid，写入 `tmp/bili-cookies.txt` 喂给 yt-dlp（30 分钟缓存）。若 B站再次出现 412，先确认该 cookie 文件生成正常。
- **抖音 ttwid**：每次解析自动从 `ttwid.bytedance.com/ttwid/union/register/` 申领，写入 `tmp/douyin-cookies.txt`。

## 环境踩坑结论（本机特有）

1. 本机 Schannel 损坏（curl/git/.NET 的 HTTPS 全挂），所有下载走 Node 的 OpenSSL 通道
2. yt-dlp 用目录式发行版 `yt-dlp_win.zip`，不用 onefile exe——后者启动时解包 TEMP 会被沙箱拦截
3. yt-dlp 子进程的 stdout 恒为 GBK 且无视 `PYTHONUTF8`/`PYTHONIOENCODING`，Node 侧统一用 `TextDecoder('gbk')` 解码
4. 子进程 TEMP/TMP 固定指向 `toolbox\tmp`；沙箱禁止 stdio 管道型 spawn，子进程输出走文件重定向 + 增量轮询
