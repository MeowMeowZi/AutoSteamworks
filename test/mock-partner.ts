// 模拟的 Steamworks 商店编辑页，结构按真实页面（2026-11 用 inspect 看到的）还原：
// - 一个 #gameform，所有语言的文本都在隐藏字段 app[content][...][<lang>] 里
// - 可见的 textarea 没有 name，只是界面；表单的 submit 事件会把它的内容写回隐藏字段
//   （用来证明我们的提交绕过了界面，不会被它覆盖）
// - 有 sessionid / serialized_app_data / *_compl 这些内部字段
// - 提交为 multipart（FormData），保存后 302 回编辑页
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const LANGS = ['english', 'schinese', 'japanese'];
type Row = Record<string, string>;
const db: Record<string, Row> = {};
let lastPost: Row | undefined;
export interface Upload { key: string; filename: string; size: number; allAges: string | null }
const uploads: Upload[] = [];
const deletes: string[] = [];
/** 和真实后台一样：serialized_app_data.assets[<类型 key>].image[<语言>] = '<hash>/<文件名>' */
const assets: Record<string, Record<string, unknown>> = {};

const fresh = (): Row => {
  const r: Row = {
    'app[name]': '邪神今天也在挂机', 'app[content][links][website]': '', 'app[platforms][win]': '1',
    'app[classification][primary_genre]': '', 'app[broadcast][chat_visibility]': 'hide', 'tags[]': 'coop',
  };
  for (const l of LANGS) {
    r[`app[content][about][${l}]`] = l === 'english' ? 'Old about\n[b]bold[/b]' : '';
    r[`app[content][short_description][${l}]`] = '';
    r[`app[content][sysreqs][windows][min][processor][${l}]`] = '';
  }
  return r;
};
const get = (id: string) => (db[id] ??= fresh());
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** 和真实后台一样：每张已上传的图旁边有一个“删除”链接，参数是要清空的字段 */
function deleteLinks(id: string) {
  const out: string[] = [];
  for (const [k, v] of Object.entries((assets[id] ?? {}) as Record<string, any>)) {
    for (const lang of Object.keys(v?.image ?? {})) {
      if (!v.image[lang]) continue;
      const f = Object.fromEntries(['image', 'image2x', 'image2x_raw'].map((x) => [`app[assets][${k}][${x}][${lang}]`, '']));
      out.push(`<div class="image_grid_col">(<a href="javascript:void(0)" onclick="${esc(`SubmitQuickMessageUpdate( ${JSON.stringify(f)} );`)}">删除</a>)</div>`);
    }
  }
  return out.join('\n');
}

function page(id: string) {
  const d = get(id);
  const hidden = Object.entries(d)
    .filter(([k]) => k.startsWith('app[content]') || k === 'app[platforms][win]')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');
  const tags = d['tags[]'].split(',');
  return `<!doctype html><html><body>
  <form><select name="publisher"><option>222306</option></select></form>
  <form id="gameform" method="post" action="/admin/game/save/${id}" enctype="multipart/form-data">
    <input type="hidden" name="sessionid" value="sess">
    <input type="hidden" name="serialized_app_data" value="${esc(JSON.stringify({ itemid: id, assets: assets[id] ?? {} }))}">
    <input type="hidden" name="activetab" value="tab_description">
    <input type="text" name="app[name]" value="${esc(d['app[name]'])}">
    <input type="text" name="app[content][links][website]_compl" value="">
    <select name="app[classification][primary_genre]"><option value=""></option><option value="1">Action</option><option value="23">Indie</option></select>
    <input type="radio" name="app[broadcast][chat_visibility]" value="hide"${d['app[broadcast][chat_visibility]'] === 'hide' ? ' checked' : ''}>
    <input type="radio" name="app[broadcast][chat_visibility]" value="show"${d['app[broadcast][chat_visibility]'] === 'show' ? ' checked' : ''}>
    ${['coop', 'pvp'].map((t) => `<input type="checkbox" name="tags[]" value="${t}"${tags.includes(t) ? ' checked' : ''}>`).join('')}
    <textarea id="app_content_short_description__textarea"></textarea>
    <input type="file" name="screenshot">
    ${hidden}
    <input type="submit" id="submitBtn" value="保存">
  </form>
  <input type="hidden" id="activetab" name="activetab" value="tab_graphicalassets">
  <form id="quick_message_update" method="post" action="/admin/game/save/${id}">
    <input type="hidden" name="sessionid" value="sess"><input type="hidden" id="save_redirect" name="save_redirect" value="edit">
  </form>
  ${deleteLinks(id)}
  <script>
    // 以下照抄真实页面（game_admin.js），用于图片上传测试
    var g_sessionID = 'sess';
    var g_ImageTypes = [
      { name: 'Header Capsule', label: '形象图片', width: 920, height: 430, path: 'header_image|header|assets|header_image|image', localized: true, tab: 'store' },
      { name: 'Small Capsule', label: '小宣传图', width: 462, height: 174, path: 'small_capsule|capsule|assets|small_capsule|image', localized: true, tab: 'store' },
      { name: 'Page Background', label: '页面背景', width: 1438, height: 810, path: 'page_background|page_bg_raw|assets|page_background_raw', localized: false, tab: 'store' },
      { name: 'Library Header', label: '库形象图片', width: 920, height: 430, path: 'library_header|library_header|assets|library_header|image', localized: true, tab: 'library' },
      { name: 'Screenshot', label: '截图', width: 1920, height: 1080, path: 'screenshot|assets|screenshots|', localized: false, enforce_min: true, tab: 'screenshot' },
      { name: 'ScreenshotLocalized', width: 0, height: 0, path: 'screenshot_localized|assets|screenshots|', localized: true, hidden: true, enforce_min: true, tab: 'screenshot' },
    ];
    function IsImageTypeValid( image, ImageType ) {
      var bSupports2X = ImageType.supports2x;
      if ( ImageType.enforce_min ) {
        if ( ImageType.width !== 0 && image.width < ImageType.width ) return false;
        if ( ImageType.height !== 0 && image.height < ImageType.height ) return false;
      } else if ( ImageType.contained ) {
        if ( image.width !== ImageType.width && image.height !== ImageType.height ) return false;
      } else {
        if ( ImageType.width != 0 && ImageType.width != image.width && ( !bSupports2X || ImageType.width * 2 != image.width ) ) return false;
        if ( ImageType.height != 0 && ImageType.height != image.height && ( !bSupports2X || ImageType.height * 2 != image.height ) ) return false;
      }
      return true;
    }
    document.querySelector('[name="app[classification][primary_genre]"]').value = ${JSON.stringify(d['app[classification][primary_genre]'])};
    // 模拟真实页面：点保存时界面会把当前 textarea（显示 english）写回隐藏字段
    document.getElementById('gameform').addEventListener('submit', () => {
      document.querySelector('[name="app[content][short_description][english]"]').value =
        document.getElementById('app_content_short_description__textarea').value;
    });
  </script></body></html>`;
}

export function start(port = 0) {
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    // 没登录时真实后台会跳回首页并带上 ?goto=。appid 999 模拟这种情况
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><body>home</body></html>');
    let m = url.pathname.match(/^\/admin\/game\/editbyappid\/(\d+)$/);
    if (m?.[1] === '999') return res.writeHead(302, { Location: `/?goto=${encodeURIComponent(url.pathname)}` }).end();
    if (m) return res.writeHead(302, { Location: `/admin/game/edit/${Number(m[1]) + 1000}?activetab=tab_description` }).end();
    m = url.pathname.match(/^\/admin\/game\/edit\/(\d+)$/);
    if (m) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(m[1]));
    m = url.pathname.match(/^\/admin\/game\/save\/(\d+)$/);
    if (m && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = await new Request('http://x', {
        method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks),
      }).formData();
      if (form.get('sessionid') !== 'sess') return res.writeHead(403).end('bad session');
      if (url.searchParams.get('json') === '1') {
        let rejected = false;
        for (const [key, v] of form) {
          if (typeof v === 'string') continue;
          const bytes = Buffer.from(await v.arrayBuffer());
          // 文件名带 reject 的：模拟后台拒收，不记录、不改数据
          if (v.name.includes('reject')) { rejected = true; continue; }
          uploads.push({ key, filename: v.name, size: bytes.length, allAges: form.get(`params[${v.name.replace('.AA1', '')}][all_ages]`) as string | null });
          const parts = key.split('|'), ak = parts[parts.indexOf('assets') + 1], lang = /\|([a-z]+)$/.exec(key)?.[1] ?? 'english';
          const a = (assets[m[1]] ??= {}) as Record<string, any>;
          (a[ak] ??= { image: {} }).image[lang] = `h${uploads.length}/${v.name}`;
        }
        // 真实后台的返回格式：成功带 SuccessMsg，失败带 ErrorMsg
        const msg = rejected ? 'ErrorMsg%5B0%5D=Image+rejected' : 'SuccessMsg%5B0%5D=Changes+saved';
        return res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ redirect: `https://partner.steamgames.com/admin/game/edit/${m[1]}?${msg}&activetab=tab_graphicalassets` }));
      }
      // 删除图片（#quick_message_update 提交）：app[assets][<key>][image][<lang>] = ''
      const cleared = [...form.keys()].map((k) => /^app\[assets\]\[(\w+)\]\[image\]\[(\w+)\]$/.exec(k)).filter((x) => x);
      if (cleared.length) {
        const a = (assets[m[1]] ?? {}) as Record<string, any>;
        // 删小宣传图（schinese）时模拟后台拒绝：不改数据，重定向地址里带 ErrorMsg
        const reject = cleared.some((x) => x![1] === 'small_capsule' && x![2] === 'schinese');
        if (!reject) {
          for (const [, k, lang] of cleared as RegExpExecArray[]) if (a[k]?.image) delete a[k].image[lang];
          deletes.push(...cleared.map((x) => x![0]));
        }
        const msg = reject ? 'ErrorMsg%5B0%5D=Delete+failed' : 'SuccessMsg%5B0%5D=Changes+saved';
        return res.writeHead(302, { Location: `/admin/game/edit/${m[1]}?${msg}&activetab=tab_graphicalassets` }).end();
      }
      const d = get(m[1]);
      lastPost = {};
      for (const [k, v] of form) if (typeof v === 'string') lastPost[k] = v;
      for (const k of Object.keys(d)) {
        if (k === 'tags[]') d[k] = form.getAll(k).join(',');
        else if (form.has(k)) d[k] = String(form.get(k));
      }
      return res.writeHead(302, { Location: `/admin/game/edit/${m[1]}?activetab=tab_description` }).end();
    }
    res.writeHead(404).end();
  });
  return new Promise<{ url: string; close: () => void; db: typeof db; lastPost: () => Row | undefined; uploads: Upload[]; deletes: string[] }>((r) =>
    srv.listen(port, '127.0.0.1', () => r({
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close(), db, lastPost: () => lastPost, uploads, deletes,
    })));
}

if (process.argv[1]?.endsWith('mock-partner.ts')) {
  start(Number(process.argv[2] ?? 8787)).then((s) => console.log(s.url));
}
