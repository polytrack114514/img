/**
 * img 图床后端（Cloudflare Pages 的 _worker.js）
 *
 * 作用：把 GitHub 令牌藏在这里，网页端不需要任何令牌就能粘贴/拖拽上传图片。
 *
 * 需要配置的环境变量（Cloudflare 项目 Settings → Variables）：
 *   GH_TOKEN        （加密变量，必填）有 img 仓库 Contents 读写权限的 GitHub 令牌
 *   REPO_OWNER      （明文，必填）仓库所有者，例如 polytrack114514
 *   REPO_NAME       （明文，必填）仓库名称，例如 img
 *   BRANCH          （明文，可选）分支，默认 main
 *   ALLOW_ORIGIN    （明文，可选）允许的来源，默认 https://polytrack114514.github.io
 *   UPLOAD_PASSWORD （加密变量，可选）上传/删除口令
 */

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });

/** 仓库根目录的基础文件：禁止被覆盖或删除，防止站点被破坏 */
const PROTECTED = ['backend.json', 'index.html', 'README.md', 'worker.js'];
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOW_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tif', 'tiff', 'heic', 'apng', 'jfif'];

const isProtected = (p) => !String(p || '').includes('/') && PROTECTED.indexOf(p) >= 0;

const extOf = (name) => {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
};

/** 回收站目录：删除的图片先挪到这里，可以再恢复 */
const TRASH_DIR = '.trash';

/** 记录每张图的上传时间，供倒序排列与展示 */
const META_FILE = '.meta.json';

const b64encode = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const b64decode = (s) => {
  const bin = atob(String(s || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const encPath = (p) =>
  String(p || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');

/** 只保留安全的文件名：去掉目录与危险字符，中文和空格保留 */
const safeName = (raw) =>
  String(raw || '')
    .replace(/[\\/]+/g, '-')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);

/** 访问令牌存在 KV 里：key 为 t:令牌，value 为 { name, createdAt } */
const TOKEN_PREFIX = 't:';

/** 短链：s:短码 -> 文件名，sr:文件名 -> 短码 */
const SHORT_PREFIX = 's:';
const SHORT_REV = 'sr:';

const genShortCode = () => {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += chars[b[i] % chars.length];
  return s;
};

const genToken = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] + 256).toString(16).slice(1);
  return 'img_' + s;
};

/** 校验口令：主口令 UPLOAD_PASSWORD，或 KV 里未吊销的访问令牌，都算通过 */
const authOk = async (password, env) => {
  if (!env.UPLOAD_PASSWORD && !env.TOKENS) return true;
  const p = String(password || '');
  if (env.UPLOAD_PASSWORD && p === env.UPLOAD_PASSWORD) return true;
  if (env.TOKENS && p) {
    const rec = await env.TOKENS.get(TOKEN_PREFIX + p);
    if (rec) return true;
  }
  return false;
};

/** 隐藏图床：图片存在 KV（SECRET），不写公开仓库，所以没有可公开访问的直链 */
const SECRET_PREFIX = 'p:';
const SECRET_INDEX = 'i:index';
const SECRET_MAX_BYTES = 10 * 1024 * 1024;

const readSecretIndex = async (env) => {
  const raw = await env.SECRET.get(SECRET_INDEX);
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
};

const writeSecretIndex = (env, arr) => env.SECRET.put(SECRET_INDEX, JSON.stringify(arr));

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  avif: 'image/avif', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', apng: 'image/apng',
};

const b64ToBytes = (s) => {
  const bin = atob(String(s || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const owner = env.REPO_OWNER;
    const repo = env.REPO_NAME;
    const branch = env.BRANCH || 'main';

    if (!env.GH_TOKEN || !owner || !repo) {
      return json({ error: '后端未配置：缺少 GH_TOKEN / REPO_OWNER / REPO_NAME' }, 500, cors);
    }

    const gh = (path, opts = {}) =>
      fetch('https://api.github.com' + path, {
        ...opts,
        headers: {
          Authorization: 'Bearer ' + env.GH_TOKEN,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'img-bed-worker',
          ...(opts.headers || {}),
        },
      });

    const contentsPath = (p, withRef) => {
      let u = '/repos/' + owner + '/' + repo + '/contents';
      const enc = encPath(p);
      if (enc) u += '/' + enc;
      if (withRef !== false) u += '?ref=' + encodeURIComponent(branch);
      return u;
    };

    const readMeta = async () => {
      try {
        const r = await gh(contentsPath(META_FILE));
        if (!r.ok) return { data: {}, sha: null };
        const j = await r.json();
        const parsed = JSON.parse(b64decode(j.content) || '{}');
        return { data: parsed && typeof parsed === 'object' ? parsed : {}, sha: j.sha };
      } catch (e) {
        return { data: {}, sha: null };
      }
    };

    /** patch 里值为 null 表示删除该条记录 */
    const writeMeta = async (patch) => {
      const cur = await readMeta();
      const data = Object.assign({}, cur.data, patch);
      Object.keys(data).forEach((k) => { if (data[k] === null) delete data[k]; });
      const payload = {
        message: 'meta: 更新时间索引',
        content: b64encode(JSON.stringify(data, null, 2)),
        branch,
      };
      if (cur.sha) payload.sha = cur.sha;
      return gh(contentsPath(META_FILE, false), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    };

    /** 读取文件内容（大图走 blobs 接口），返回 { b64, sha } 或 null */
    const readFileB64 = async (path) => {
      const r = await gh(contentsPath(path));
      if (!r.ok) return null;
      const j = await r.json();
      if (Array.isArray(j)) return null;
      if (j.content) return { b64: String(j.content).replace(/\s/g, ''), sha: j.sha };
      const br = await gh('/repos/' + owner + '/' + repo + '/git/blobs/' + j.sha);
      if (!br.ok) return null;
      const bj = await br.json();
      if (!bj.content) return null;
      return { b64: String(bj.content).replace(/\s/g, ''), sha: j.sha };
    };

    const putFile = async (path, b64, message) => {
      const head = await gh(contentsPath(path));
      let sha = null;
      if (head.ok) {
        const j = await head.json();
        if (j && j.sha) sha = j.sha;
      }
      const payload = { message, content: b64, branch };
      if (sha) payload.sha = sha;
      return gh(contentsPath(path, false), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    };

    const removeFile = async (path, sha) => {
      let s = sha;
      if (!s) {
        const h = await gh(contentsPath(path));
        if (!h.ok) return h;
        const j = await h.json();
        s = j && j.sha;
      }
      return gh(contentsPath(path, false), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'delete: ' + path, sha: s, branch }),
      });
    };

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (e) { body = {}; }
    }

    try {
      // ---------- 图片直链加速：反代 GitHub raw，交给 Cloudflare 边缘缓存 ----------
      if (request.method === 'GET' && route.indexOf('/i/') === 0) {
        let key = '';
        try { key = decodeURIComponent(route.slice(3)); } catch (e) { key = route.slice(3); }
        if (!key || key.indexOf('/') >= 0) return json({ error: '图片不存在' }, 404, cors);

        // 没有扩展名的视为短码，去 KV 换回真实文件名
        let name = key;
        if (ALLOW_EXT.indexOf(extOf(name)) < 0) {
          const mapped = env.SECRET ? await env.SECRET.get(SHORT_PREFIX + key) : null;
          if (!mapped) return json({ error: '图片不存在' }, 404, cors);
          name = mapped;
        }
        if (ALLOW_EXT.indexOf(extOf(name)) < 0) return json({ error: '图片不存在' }, 404, cors);

        const raw = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' +
          encodeURIComponent(branch) + '/' + encodeURIComponent(name);
        const r = await fetch(raw, {
          cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 3600, '404-499': 60 } },
        });
        if (!r.ok) return json({ error: '图片不存在' }, r.status, cors);

        return new Response(r.body, {
          status: 200,
          headers: {
            ...cors,
            'Content-Type': MIME[extOf(name)] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }

      // ---------- 短链：给图片生成 /i/xxxxxx 这样的短地址 ----------
      if (request.method === 'POST' && route === '/short') {
        if (!env.SECRET) return json({ error: '后端未绑定 KV 命名空间，短链不可用' }, 500, cors);
        if (!(await authOk(body.password, env))) return json({ error: '口令或令牌无效' }, 403, cors);

        const name = safeName(body.name);
        if (!name) return json({ error: '缺少文件名' }, 400, cors);
        if (isProtected(name)) return json({ error: '基础文件不能生成短链' }, 403, cors);

        let code = await env.SECRET.get(SHORT_REV + name);
        if (code) {
          const back = await env.SECRET.get(SHORT_PREFIX + code);
          if (back === name) return json({ ok: true, code, name, reused: true }, 200, cors);
        }

        const exists = await gh(contentsPath(name));
        if (!exists.ok) return json({ error: '图片不存在' }, 404, cors);

        code = null;
        for (let i = 0; i < 12 && !code; i++) {
          const candidate = genShortCode();
          const taken = await env.SECRET.get(SHORT_PREFIX + candidate);
          if (!taken) {
            await env.SECRET.put(SHORT_PREFIX + candidate, name);
            await env.SECRET.put(SHORT_REV + name, candidate);
            code = candidate;
          }
        }
        if (!code) return json({ error: '生成短码失败，请重试' }, 500, cors);

        return json({ ok: true, code, name }, 201, cors);
      }

      // ---------- 图片列表 ----------
      if (request.method === 'GET' && route === '/list') {
        const r = await gh(contentsPath(''));
        if (r.status === 404) return json([], 200, cors);
        const data = await r.json();
        if (!Array.isArray(data)) return json({ error: '仓库为空或未初始化' }, 500, cors);

        const meta = (await readMeta()).data;
        const items = data
          .filter((it) => it.type === 'file' && it.name !== META_FILE && !isProtected(it.name))
          .map((it) => Object.assign({}, it, { uploadedAt: meta[it.path] || null }))
          .sort((a, b) => {
            const ta = a.uploadedAt ? Date.parse(a.uploadedAt) : 0;
            const tb = b.uploadedAt ? Date.parse(b.uploadedAt) : 0;
            if (ta !== tb) return tb - ta;
            return a.name.localeCompare(b.name);
          });
        return json(items, 200, cors);
      }

      // ---------- 统计 ----------
      if (request.method === 'GET' && route === '/stats') {
        const r = await gh(
          '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
        );
        if (!r.ok) return json({ error: '读取仓库信息失败' }, r.status, cors);
        const j = await r.json();
        const files = (j.tree || []).filter(
          (it) =>
            it.type === 'blob' &&
            it.path !== META_FILE &&
            it.path.indexOf(TRASH_DIR + '/') !== 0 &&
            !isProtected(it.path)
        );
        const bytes = files.reduce((sum, it) => sum + (it.size || 0), 0);
        return json({ images: files.length, bytes, passwordRequired: !!(env.UPLOAD_PASSWORD || env.TOKENS) }, 200, cors);
      }

      // ---------- 访问令牌管理（只能用主口令操作） ----------
      if (request.method === 'POST' && route === '/tokens') {
        if (!env.TOKENS) return json({ error: '后端未绑定 KV 命名空间，令牌功能不可用' }, 500, cors);
        if (!env.UPLOAD_PASSWORD) return json({ error: '请先在环境变量里配置 UPLOAD_PASSWORD 作为管理口令' }, 500, cors);
        if (body.password !== env.UPLOAD_PASSWORD) return json({ error: '管理口令错误' }, 403, cors);

        if (body.action === 'list') {
          const listed = await env.TOKENS.list({ prefix: TOKEN_PREFIX, limit: 100 });
          const items = [];
          for (const k of listed.keys || []) {
            const raw = await env.TOKENS.get(k.name);
            let info = {};
            try { info = JSON.parse(raw || '{}') || {}; } catch (e) { info = {}; }
            items.push({
              token: k.name.slice(TOKEN_PREFIX.length),
              name: info.name || '',
              createdAt: info.createdAt || (k.metadata && k.metadata.createdAt) || null,
            });
          }
          items.sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));
          return json(items, 200, cors);
        }

        if (body.action === 'create') {
          const token = genToken();
          const label = String(body.name || '').trim().slice(0, 40) ||
            ('令牌 ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
          const createdAt = new Date().toISOString();
          await env.TOKENS.put(TOKEN_PREFIX + token, JSON.stringify({ name: label, createdAt }));
          return json({ ok: true, token, name: label, createdAt }, 201, cors);
        }

        if (body.action === 'revoke') {
          const token = String(body.token || '').trim();
          if (!token) return json({ error: '缺少令牌' }, 400, cors);
          await env.TOKENS.delete(TOKEN_PREFIX + token);
          return json({ ok: true, revoked: token }, 200, cors);
        }

        return json({ error: '未知操作' }, 400, cors);
      }

      // ---------- 隐藏的图床（私有，存 KV，需口令） ----------
      if (request.method === 'POST' && route.indexOf('/secret/') === 0) {
        if (!env.SECRET) return json({ error: '后端未绑定 KV 命名空间 SECRET，隐藏图床不可用' }, 500, cors);
        if (!(await authOk(body.password, env))) return json({ error: '口令或令牌无效' }, 403, cors);

        if (route === '/secret/list') {
          const items = (await readSecretIndex(env)).slice();
          items.sort((a, b) => (Date.parse(b.uploadedAt || 0) || 0) - (Date.parse(a.uploadedAt || 0) || 0));
          return json(items, 200, cors);
        }

        if (route === '/secret/upload') {
          const name = safeName(body.name);
          if (!name) return json({ error: '缺少文件名' }, 400, cors);
          if (ALLOW_EXT.indexOf(extOf(name)) < 0) {
            return json({ error: '只支持图片格式：' + ALLOW_EXT.join(' / ') }, 415, cors);
          }
          const b64 = String(body.content || '').replace(/\s/g, '');
          if (!b64) return json({ error: '缺少图片内容' }, 400, cors);
          const size = b64ToBytes(b64).length;
          if (size > SECRET_MAX_BYTES) return json({ error: '隐藏图床单张不能超过 10 MB' }, 413, cors);

          const index = await readSecretIndex(env);
          const taken = {};
          index.forEach((it) => { taken[it.name] = true; });

          let finalName = name;
          if (taken[name]) {
            const dot = name.lastIndexOf('.');
            const ext = dot > 0 ? name.slice(dot) : '';
            const stem = (dot > 0 ? name.slice(0, dot) : name).slice(0, Math.max(1, 116 - ext.length));
            finalName = '';
            for (let i = 1; i <= 60; i++) {
              const candidate = stem + '-' + i + ext;
              if (!taken[candidate]) { finalName = candidate; break; }
            }
            if (!finalName) return json({ error: '同名图片已经有太多份，请换个名字' }, 409, cors);
          }

          const at = new Date().toISOString();
          await env.SECRET.put(SECRET_PREFIX + finalName, b64, {
            metadata: { size, uploadedAt: at },
          });
          index.push({ name: finalName, size, uploadedAt: at });
          await writeSecretIndex(env, index);
          return json({ ok: true, name: finalName, renamed: finalName !== name, size, uploadedAt: at }, 201, cors);
        }

        if (route === '/secret/image') {
          const name = safeName(body.name);
          if (!name) return json({ error: '缺少文件名' }, 400, cors);
          const b64 = await env.SECRET.get(SECRET_PREFIX + name);
          if (!b64) return json({ error: '图片不存在' }, 404, cors);
          return new Response(b64ToBytes(b64), {
            status: 200,
            headers: {
              ...cors,
              'Content-Type': MIME[extOf(name)] || 'application/octet-stream',
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        }

        if (route === '/secret/delete') {
          const name = safeName(body.name);
          if (!name) return json({ error: '缺少文件名' }, 400, cors);
          await env.SECRET.delete(SECRET_PREFIX + name);
          const index = (await readSecretIndex(env)).filter((it) => it.name !== name);
          await writeSecretIndex(env, index);
          return json({ ok: true }, 200, cors);
        }

        return json({ error: '未知操作' }, 400, cors);
      }

      // ---------- 回收站列表 ----------
      if (request.method === 'GET' && route === '/trash') {
        const r = await gh(
          '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
        );
        if (!r.ok) return json({ error: '读取回收站失败' }, r.status, cors);
        const j = await r.json();
        const meta = (await readMeta()).data;
        const items = (j.tree || [])
          .filter((it) => it.type === 'blob' && it.path.indexOf(TRASH_DIR + '/') === 0)
          .map((it) => ({
            name: it.path.slice(TRASH_DIR.length + 1),
            size: it.size || 0,
            deletedAt: meta[it.path] || null,
          }))
          .sort((a, b) => (Date.parse(b.deletedAt || 0) || 0) - (Date.parse(a.deletedAt || 0) || 0));
        return json(items, 200, cors);
      }

      // ---------- 上传 ----------
      if (request.method === 'POST' && route === '/upload') {
        if (!(await authOk(body.password, env))) {
          return json({ error: '口令或令牌无效' }, 403, cors);
        }
        const name = safeName(body.name);
        if (!name) return json({ error: '缺少文件名' }, 400, cors);
        if (isProtected(name)) {
          return json({ error: '「' + name + '」是基础文件，不能覆盖', protected: true }, 403, cors);
        }
        if (ALLOW_EXT.indexOf(extOf(name)) < 0) {
          return json({ error: '只支持图片格式：' + ALLOW_EXT.join(' / ') }, 415, cors);
        }

        const b64 = String(body.content || '').replace(/\s/g, '');
        if (!b64) return json({ error: '缺少图片内容' }, 400, cors);

        const bytes = Math.floor((b64.length * 3) / 4);
        if (bytes > MAX_BYTES) return json({ error: '单张图片不能超过 20 MB' }, 413, cors);

        // 同名图片不覆盖：自动改成「名字-1 / 名字-2 …」，保证老图和已分享的链接都不失效
        let finalName = name;
        const head = await gh(contentsPath(name));
        if (head.ok) {
          const dot = name.lastIndexOf('.');
          const ext = dot > 0 ? name.slice(dot) : '';
          const stem = (dot > 0 ? name.slice(0, dot) : name).slice(0, Math.max(1, 116 - ext.length));
          finalName = '';
          for (let i = 1; i <= 60; i++) {
            const candidate = stem + '-' + i + ext;
            const h = await gh(contentsPath(candidate));
            if (!h.ok) { finalName = candidate; break; }
          }
          if (!finalName) return json({ error: '同名图片已经有太多份，请换个名字', exists: true }, 409, cors);
        }

        const w = await putFile(finalName, b64, 'upload: ' + finalName);
        if (!w.ok) {
          const t = await w.text();
          return json({ error: '写入仓库失败（HTTP ' + w.status + '）', detail: t.slice(0, 200) }, w.status, cors);
        }

        const now = new Date().toISOString();
        await writeMeta({ [finalName]: now });
        return json({ ok: true, name: finalName, renamed: finalName !== name, size: bytes, uploadedAt: now }, 201, cors);
      }

      // ---------- 删除（软删除到回收站） ----------
      if (request.method === 'POST' && route === '/delete') {
        if (!(await authOk(body.password, env))) {
          return json({ error: '口令或令牌无效' }, 403, cors);
        }
        const name = safeName(body.name);
        if (!name) return json({ error: '缺少文件名' }, 400, cors);
        if (isProtected(name)) {
          return json({ error: '「' + name + '」是基础文件，不可删除', protected: true }, 403, cors);
        }

        const src = await readFileB64(name);
        if (!src) return json({ error: '图片不存在' }, 404, cors);

        const trashPath = TRASH_DIR + '/' + name;
        const moved = await putFile(trashPath, src.b64, 'trash: ' + name);
        if (!moved.ok) return json({ error: '移入回收站失败，图片未删除' }, 500, cors);

        const del = await removeFile(name, body.sha || src.sha);
        if (!del.ok) return json({ error: '原图删除失败，回收站已保留副本' }, del.status, cors);

        await writeMeta({ [name]: null, [trashPath]: new Date().toISOString() });

        // 删图时一并回收短链，避免短码指向已删除的图片
        if (env.SECRET) {
          const code = await env.SECRET.get(SHORT_REV + name);
          if (code) {
            await env.SECRET.delete(SHORT_PREFIX + code);
            await env.SECRET.delete(SHORT_REV + name);
          }
        }

        return json({ ok: true, trashedTo: trashPath }, 200, cors);
      }

      // ---------- 回收站操作：恢复 / 彻底删除 / 清空 ----------
      if (request.method === 'POST' && route === '/trash') {
        if (!(await authOk(body.password, env))) {
          return json({ error: '口令或令牌无效' }, 403, cors);
        }
        const name = safeName(body.name);

        if (body.action === 'restore') {
          if (!name) return json({ error: '缺少文件名' }, 400, cors);
          if (isProtected(name)) return json({ error: '「' + name + '」是基础文件，无需恢复' }, 403, cors);

          const exists = await gh(contentsPath(name));
          if (exists.ok) return json({ error: '「' + name + '」已存在，请先删除或改名后再恢复' }, 409, cors);

          const trashPath = TRASH_DIR + '/' + name;
          const src = await readFileB64(trashPath);
          if (!src) return json({ error: '回收站中没有这张图' }, 404, cors);

          const back = await putFile(name, src.b64, 'restore: ' + name);
          if (!back.ok) return json({ error: '恢复失败' }, 500, cors);
          await removeFile(trashPath, src.sha);

          const meta = (await readMeta()).data;
          await writeMeta({ [trashPath]: null, [name]: meta[trashPath] || new Date().toISOString() });
          return json({ ok: true, restored: name }, 200, cors);
        }

        if (body.action === 'purge') {
          if (!name) return json({ error: '缺少文件名' }, 400, cors);
          const trashPath = TRASH_DIR + '/' + name;
          const out = await removeFile(trashPath);
          if (!out.ok) return json({ error: '回收站中没有这张图' }, out.status, cors);
          await writeMeta({ [trashPath]: null });
          return json({ ok: true }, 200, cors);
        }

        if (body.action === 'empty') {
          const r = await gh(
            '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
          );
          if (!r.ok) return json({ error: '读取回收站失败' }, r.status, cors);
          const j = await r.json();
          const files = (j.tree || []).filter(
            (it) => it.type === 'blob' && it.path.indexOf(TRASH_DIR + '/') === 0
          );
          const patch = {};
          let n = 0;
          for (const f of files) {
            const out = await removeFile(f.path);
            if (out.ok) {
              n++;
              patch[f.path] = null;
            }
          }
          if (Object.keys(patch).length) await writeMeta(patch);
          return json({ ok: true, removed: n }, 200, cors);
        }

        return json({ error: '未知操作' }, 400, cors);
      }

      // ---------- 原图下载 ----------
      if (request.method === 'GET' && route === '/download') {
        const name = safeName(url.searchParams.get('name') || '');
        if (!name) return json({ error: '缺少文件名' }, 400, cors);
        const src = await readFileB64(name);
        if (!src) return json({ error: '图片不存在' }, 404, cors);

        const bin = atob(src.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        return new Response(bytes, {
          status: 200,
          headers: {
            ...cors,
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
          },
        });
      }

      return json({ error: '接口不存在', route }, 404, cors);
    } catch (e) {
      return json({ error: '后端异常：' + (e && e.message ? e.message : String(e)) }, 500, cors);
    }
  },
};
