// 收集字节系全套指纹 cookie 后裸调 detail
const ID = '7592202770590324913';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function getTtwid(ua) {
  const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
    body: JSON.stringify({ region: 'cn', aid: 1768, needFid: false, service: 'www.ixigua.com', migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true }),
  });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const m = c.match(/ttwid=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

const jar = {};
function absorb(res) {
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m) jar[m[1].trim()] = m[2];
  }
}

const ttwidDesktop = await getTtwid(UA_DESKTOP);
const ttwidMobile = await getTtwid(UA_MOBILE);
if (ttwidDesktop) jar.ttwid = ttwidDesktop;

// 1) 访问 douyin.com 首页收指纹 cookie
const home = await fetch('https://www.douyin.com/', { headers: { 'User-Agent': UA_DESKTOP, Cookie: `ttwid=${ttwidDesktop}` } });
await home.text().catch(() => '');
absorb(home);
console.log('home status:', home.status, '| cookies now:', Object.keys(jar).join(', '));

// 2) 访问 share note 页(移动端域)收 cookie
const share = await fetch(`https://www.iesdouyin.com/share/note/${ID}/`, { headers: { 'User-Agent': UA_MOBILE, Cookie: `ttwid=${ttwidMobile}` } });
await share.text().catch(() => '');
absorb(share);
console.log('share cookies now:', Object.keys(jar).join(', '));

// 3) 组 cookie 罐裸调 detail
const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
console.log('cookie jar size:', cookieStr.length);
const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${ID}&device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC&downlink=10&effective_type=4g`;
const r = await fetch(url, {
  headers: { 'User-Agent': UA_DESKTOP, Cookie: cookieStr, Referer: 'https://www.douyin.com/', Accept: 'application/json, text/plain, */*' },
});
console.log('detail status:', r.status);
const t = await r.text();
console.log('head:', t.slice(0, 250).replace(/\s+/g, ' '));
if (r.ok) {
  const d = JSON.parse(t)?.aweme_detail;
  if (d?.images?.length) {
    const img0 = d.images[0];
    console.log('img0 keys:', Object.keys(img0).join(', '));
    console.log('live_photo:', img0.live_photo);
    if (img0.video) console.log('img0.video:', JSON.stringify(img0.video).slice(0, 300));
  }
}
