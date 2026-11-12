import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = (process.env.GH_TOKEN || readFileSync('D:/workbuddy_work/spaces/2026_11_12_19-13-14/.ghtoken', 'utf8')).trim();
const OWNER = 'superzhang21';
const REPO = 'kiln-user';
const ROOT = 'D:/workbuddy_work/spaces/2026_11_12_19-13-14/kiln-user';
const API = 'https://api.github.com';
const BINARY = /\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|ttf|woff2?)$/i;

async function api(path, method = 'GET', body = undefined) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kiln-push',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json && (json.message || JSON.stringify(json).slice(0, 200)) || text.slice(0, 200);
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${msg}`);
  }
  return json;
}

function walk(dir, base = '') {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules' || e === '.kiln') continue;
    const p = join(dir, e);
    const rel = base ? base + '/' + e : e;
    if (statSync(p).isDirectory()) out.push(...walk(p, rel));
    else out.push(rel);
  }
  return out.sort();
}

async function main() {
  // 1) verify token
  const me = await api('/user');
  console.log('authenticated as:', me.login, '(id', me.id + ')');
  if (me.login !== OWNER) throw new Error('token owner mismatch: ' + me.login);

  // 2) create repo if missing
  let repo;
  try {
    repo = await api(`/repos/${OWNER}/${REPO}`);
    console.log('repo already exists:', repo.full_name, 'private=' + repo.private);
  } catch (e) {
    if (!String(e.message).includes('HTTP 404')) throw e;
    repo = await api(`/user/repos`, 'POST', {
      name: REPO,
      description: 'Kiln — 个人 AI 工具箱：把日常小应用通过 MCP 接入 agent，并提供普通用户开箱即用的一键包。零运行时依赖，Node ≥22.18。',
      homepage: `https://github.com/${OWNER}/${REPO}`,
      private: false,
      auto_init: false,
      license_template: 'apache-2.0',
      has_issues: true,
      has_wiki: false,
    });
    console.log('created repo:', repo.full_name, 'private=' + repo.private);
  }

  // 3) detect existing main ref (GitHub may auto-create one from license_template)
  let parentSha = null;
  let refExists = false;
  try {
    const ref = await api(`/repos/${OWNER}/${REPO}/git/refs/heads/main`);
    parentSha = ref.object.sha;
    refExists = true;
    console.log('existing main HEAD:', parentSha, '-> will fast-forward onto it');
  } catch (e) {
    if (!String(e.message).includes('HTTP 404')) throw e;
    console.log('no existing main branch; creating fresh');
  }

  // 4) upload blobs
  const files = walk(ROOT);
  console.log('files to upload:', files.length);
  const blobs = [];
  let bin = 0, txt = 0;
  for (const f of files) {
    const buf = readFileSync(join(ROOT, f));
    let body;
    if (BINARY.test(f)) { body = { content: buf.toString('base64'), encoding: 'base64' }; bin++; }
    else { body = { content: buf.toString('utf8'), encoding: 'utf-8' }; txt++; }
    const r = await api(`/repos/${OWNER}/${REPO}/git/blobs`, 'POST', body);
    blobs.push({ path: f, sha: r.sha });
  }
  console.log(`blobs created: ${blobs.length} (text=${txt}, binary=${bin})`);

  // 5) tree
  const tree = blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha }));
  const treeRes = await api(`/repos/${OWNER}/${REPO}/git/trees`, 'POST', { tree });
  console.log('tree sha:', treeRes.sha);

  // 6) commit
  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', {
    message: 'Initial commit: kiln 用户交付版（仅交付物，零运行时依赖）',
    tree: treeRes.sha,
    parents: parentSha ? [parentSha] : [],
  });
  console.log('commit sha:', commit.sha);

  // 7) ref (main)
  if (refExists) {
    await api(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, 'PATCH', { sha: commit.sha });
    console.log('ref refs/heads/main fast-forwarded');
  } else {
    await api(`/repos/${OWNER}/${REPO}/git/refs`, 'POST', { ref: 'refs/heads/main', sha: commit.sha });
    console.log('ref refs/heads/main created');
  }

  // 7) patch metadata
  await api(`/repos/${OWNER}/${REPO}`, 'PATCH', {
    description: 'Kiln — 个人 AI 工具箱：把日常小应用通过 MCP 接入 agent，并提供普通用户开箱即用的一键包。零运行时依赖，Node ≥22.18。',
    homepage: `https://github.com/${OWNER}/${REPO}`,
    topics: ['agent', 'personal-ai', 'mcp', 'tool-calling', 'ai-toolbox', 'typescript', 'zero-dependency', 'runtime'],
  });
  console.log('metadata updated');

  // 8) verify: list root tree of main
  const verify = await api(`/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`);
  const treeFiles = (verify.tree || []).filter((t) => t.type === 'blob');
  console.log(`VERIFY: repo ${verify.sha ? 'readable' : '??'} — blob count in main tree = ${treeFiles.length}`);
  console.log('DONE');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
