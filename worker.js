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
        return json({ images: files.length, bytes, passwordRequired: !!env.UPLOAD_PASSWORD }, 200, cors);
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
        if (env.UPLOAD_PASSWORD && body.password !== env.UPLOAD_PASSWORD) {
          return json({ error: '口令错误' }, 403, cors);
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

        const head = await gh(contentsPath(name));
        if (head.ok) return json({ error: '「' + name + '」已存在，请换个名字', exists: true }, 409, cors);

        const w = await putFile(name, b64, 'upload: ' + name);
        if (!w.ok) {
          const t = await w.text();
          return json({ error: '写入仓库失败（HTTP ' + w.status + '）', detail: t.slice(0, 200) }, w.status, cors);
        }

        const now = new Date().toISOString();
        await writeMeta({ [name]: now });
        return json({ ok: true, name, size: bytes, uploadedAt: now }, 201, cors);
      }

      // ---------- 删除（软删除到回收站） ----------
      if (request.method === 'POST' && route === '/delete') {
        if (env.UPLOAD_PASSWORD && body.password !== env.UPLOAD_PASSWORD) {
          return json({ error: '口令错误' }, 403, cors);
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
        return json({ ok: true, trashedTo: trashPath }, 200, cors);
      }

      // ---------- 回收站操作：恢复 / 彻底删除 / 清空 ----------
      if (request.method === 'POST' && route === '/trash') {
        if (env.UPLOAD_PASSWORD && body.password !== env.UPLOAD_PASSWORD) {
          return json({ error: '口令错误' }, 403, cors);
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
