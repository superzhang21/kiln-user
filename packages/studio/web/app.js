const $ = (id) => document.getElementById(id);

const state = { casts: [], current: null, manifest: null };

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

async function api(path, init) {
  const res = await fetch(path, init);
  const payload = await res.json();
  if (!payload.ok) throw payload;
  return payload;
}

/* —— 左侧应用列表 —— */

function renderRail() {
  const list = $("castList");
  list.replaceChildren();
  $("castCount").textContent = String(state.casts.length);
  $("statusCount").textContent = `${state.casts.length} 个 cast`;

  for (const cast of state.casts) {
    const active = cast.id === state.current;
    list.append(
      h("button", { class: `cast${active ? " is-active" : ""}`, onclick: () => select(cast.id) }, [
        h("span", { class: "cast__title", text: cast.title }),
        h("span", { class: "cast__meta" }, [h("span", { text: cast.id }), h("span", { text: `${cast.tools} 个工具` })]),
      ]),
    );
  }
}

/* —— 详情 —— */

function chip(verb) {
  return h("span", { class: `chip chip--${verb}`, text: verb });
}

function renderDetail(payload) {
  const { manifest, catalog } = payload;
  state.manifest = manifest;

  $("empty").hidden = true;
  $("detail").hidden = false;
  $("castTitle").textContent = manifest.title;
  $("castVersion").textContent = `v${manifest.version}`;
  $("castShape").textContent = manifest.shape;
  $("castId").textContent = manifest.id;
  $("castSummary").textContent = manifest.summary;
  $("runCast").textContent = manifest.id;
  $("manifestOut").textContent = JSON.stringify(manifest, null, 2);

  const verbs = $("castVerbs");
  verbs.replaceChildren(...manifest.verbs.map(chip));
  for (const intent of manifest.intents) {
    verbs.append(h("span", { class: "chip chip--tag", text: intent }));
  }

  const body = $("toolTable").querySelector("tbody");
  body.replaceChildren();
  if (manifest.tools.length === 0) {
    body.append(h("tr", {}, [h("td", { colspan: "3", class: "muted", text: "该 cast 只提供 observe / act" })]));
  }
  for (const tool of manifest.tools) {
    const params = tool.args
      ? Object.entries(tool.args)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "—";
    const sample = tool.examples[0];
    const example = sample
      ? h("div", { class: "ex" }, [
          h("div", { class: "ex__line" }, [
            h("span", { class: "ex__k", text: "call" }),
            h("code", { text: JSON.stringify(sample.call) }),
          ]),
          h("div", { class: "ex__line" }, [
            h("span", { class: "ex__k", text: "result" }),
            h("code", { text: JSON.stringify(sample.result) }),
          ]),
        ])
      : null;
    body.append(
      h("tr", {}, [
        h("td", {}, [h("code", { text: tool.name })]),
        h("td", {}, [h("div", { text: tool.purpose }), example]),
        h("td", {}, [h("code", { class: "muted", text: params })]),
      ]),
    );
  }

  const actions = $("actionList");
  actions.replaceChildren();
  $("actionSection").hidden = manifest.actions.length === 0;
  for (const action of manifest.actions) {
    actions.append(
      h("div", { class: "row" }, [
        h("span", { class: "row__name", text: action.name }),
        h("span", { class: "row__desc", text: action.purpose }),
      ]),
    );
  }

  const grants = $("grantList");
  grants.replaceChildren();
  const entries = Object.entries(manifest.grants ?? {});
  if (entries.length === 0) grants.append(h("span", { class: "pill", text: "无" }));
  for (const [cap, spec] of entries) {
    const detailText =
      spec && typeof spec === "object" && Array.isArray(spec.allow) ? ` (${spec.allow.join(", ")})` : "";
    grants.append(h("span", { class: "pill", text: `${cap}${detailText}` }));
  }

  const cost = $("costList");
  cost.replaceChildren(
    h("span", { class: "pill", text: `${catalog.cost.tools} 个工具` }),
    h("span", { class: "pill", text: `${catalog.cost.bytes} B 目录` }),
  );

  renderRunForm(manifest);
}

function renderRunForm(manifest) {
  const verbSel = $("runVerb");
  verbSel.replaceChildren(
    ...manifest.verbs.filter((v) => v !== "describe").map((v) => h("option", { value: v, text: v })),
  );
  verbSel.value = manifest.verbs.includes("invoke") ? "invoke" : "observe";
  syncRunNames();
}

function syncRunNames() {
  const manifest = state.manifest;
  const verb = $("runVerb").value;
  const nameSel = $("runName");
  const sources = verb === "invoke" ? manifest.tools : verb === "act" ? manifest.actions : [];
  nameSel.replaceChildren(...sources.map((item) => h("option", { value: item.name, text: item.name })));
  nameSel.disabled = sources.length === 0;
  const first = sources[0];
  $("runArgs").value =
    verb === "invoke" && first?.examples?.[0] ? JSON.stringify(first.examples[0].call, null, 2) : "{}";
}

/* —— 运行 —— */

async function run() {
  const verb = $("runVerb").value;
  const name = $("runName").value;
  const raw = $("runArgs").value.trim() || "{}";
  let args;
  try {
    args = JSON.parse(raw);
  } catch (error) {
    $("runOutput").textContent = `参数不是合法 JSON\n${error.message}`;
    return;
  }

  const button = $("runBtn");
  button.disabled = true;
  $("runMeta").textContent = "运行中…";
  const started = performance.now();

  try {
    const payload = await api(`/api/casts/${state.current}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verb, name, args, policy: $("policy").value }),
    });
    const elapsed = Math.round(performance.now() - started);
    $("runMeta").textContent = `${verb}${name ? ` · ${name}` : ""} · ${elapsed} ms`;
    $("runOutput").textContent = JSON.stringify(payload.result ?? payload.observation ?? payload.outcome, null, 2);
  } catch (failure) {
    const elapsed = Math.round(performance.now() - started);
    $("runMeta").textContent = `拒绝 · ${elapsed} ms`;
    $("runOutput").textContent = JSON.stringify(failure.issues ?? failure, null, 2);
  } finally {
    button.disabled = false;
  }
}

/* —— 事件绑定 —— */

async function select(id) {
  state.current = id;
  renderRail();
  try {
    renderDetail(await api(`/api/casts/${id}`));
    writeHash();
  } catch (error) {
    $("empty").hidden = false;
    $("detail").hidden = true;
    $("emptyText").textContent = `读取失败：${error.issues?.[0]?.message ?? "未知错误"}`;
  }
}

function activateTab(name) {
  for (const other of document.querySelectorAll(".tab")) {
    other.classList.toggle("is-active", other.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

function readHash() {
  const [id, tab] = location.hash.replace(/^#\/?/, "").split("/");
  return { id: id || "", tab: tab || "contract" };
}

function writeHash() {
  const tab = document.querySelector(".tab.is-active")?.dataset.tab ?? "contract";
  if (state.current) location.hash = `#/${state.current}/${tab}`;
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    activateTab(tab.dataset.tab);
    writeHash();
    if (tab.dataset.tab === "grants") renderGrants();
    if (tab.dataset.tab === "audit") void renderAudit();
  });
}

/* —— 授权编辑 —— */

function field(label, control) {
  return h("label", { class: "field" }, [h("span", { text: label }), control]);
}

function lines(id, values, rows = 2) {
  return h("textarea", { id, rows: String(rows), spellcheck: "false", text: (values ?? []).join(", ") });
}

function renderGrants() {
  const manifest = state.manifest;
  const form = $("grantsForm");
  if (!manifest || !form) return;
  const grants = manifest.grants ?? {};
  form.replaceChildren(
    field("shell 允许的命令（逗号分隔）", lines("grantShell", grants.shell?.allow)),
    field("net 允许的主机（逗号分隔）", lines("grantNet", grants.net?.allow)),
    field(
      "store 范围",
      h("select", { id: "grantStore" }, [
        h("option", { value: "", text: "不申请" }),
        h("option", { value: "cast", text: "cast（仅本应用）" }),
        h("option", { value: "workspace", text: "workspace（工作区共享）" }),
      ]),
    ),
    field("file 读取路径（逗号分隔）", lines("grantRead", grants.file?.read)),
    field("file 写入路径（逗号分隔）", lines("grantWrite", grants.file?.write)),
    h("label", { class: "field field--row" }, [
      h("input", { id: "grantModel", type: "checkbox" }),
      h("span", { text: "申请 model 能力（离线驱动，默认不联网）" }),
    ]),
    h("label", { class: "field field--row" }, [
      h("input", { id: "grantAgent", type: "checkbox" }),
      h("span", { text: "申请 agent 能力（最多 4 轮）" }),
    ]),
  );
  if ($("grantStore")) $("grantStore").value = grants.store?.scope ?? "";
  if ($("grantModel")) $("grantModel").checked = Boolean(grants.model);
  if ($("grantAgent")) $("grantAgent").checked = Boolean(grants.agent);
  $("grantsPreview").textContent = JSON.stringify(grants, null, 2);
}

function buildGrants() {
  const split = (value) =>
    String(value ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== "");
  const grants = {};
  const shell = split($("grantShell")?.value);
  if (shell.length) grants.shell = { allow: shell };
  const net = split($("grantNet")?.value);
  if (net.length) grants.net = { allow: net };
  const scope = $("grantStore")?.value;
  if (scope) grants.store = { scope };
  const read = split($("grantRead")?.value);
  const write = split($("grantWrite")?.value);
  if (read.length || write.length)
    grants.file = { ...(read.length ? { read } : {}), ...(write.length ? { write } : {}) };
  if ($("grantModel")?.checked) grants.model = { allow: true };
  if ($("grantAgent")?.checked) grants.agent = { allow: true, maxTurns: 4 };
  return grants;
}

async function saveGrants() {
  const status = $("grantsStatus");
  const grants = buildGrants();
  $("grantsPreview").textContent = JSON.stringify(grants, null, 2);
  status.textContent = "保存中…";
  try {
    const payload = await api(`/api/casts/${state.current}/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grants }),
    });
    state.manifest = payload.manifest;
    $("manifestOut").textContent = JSON.stringify(payload.manifest, null, 2);
    status.textContent = "已保存，已生成 cast.json.bak";
  } catch (failure) {
    status.textContent = `保存失败：${failure.issues?.[0]?.message ?? "未知错误"}`;
  }
}

/* —— 审计 —— */

async function renderAudit() {
  const list = $("auditList");
  if (!list) return;
  try {
    const payload = await api("/api/audit?limit=60");
    const events = payload.events ?? [];
    if (events.length === 0) {
      list.replaceChildren(h("div", { class: "muted", text: "暂无能力调用记录。运行一次 cast 后再回来看看。" }));
      return;
    }
    list.replaceChildren(
      ...events.map((event) =>
        h("div", { class: "audit" }, [
          h("div", { class: "audit__head" }, [
            h("code", { text: String(event.at ?? "").slice(11, 19) }),
            h("span", { class: `pill ${event.ok ? "" : "pill--bad"}`, text: event.ok ? "成功" : "拦截" }),
            h("span", { class: "audit__cap", text: `${event.capability} / ${event.method}` }),
            h("code", { class: "audit__target", text: String(event.target ?? "") }),
            h("span", { class: "muted", text: `${event.ms} ms` }),
          ]),
          ...(event.diff ? [h("pre", { class: "audit__diff", text: String(event.diff) })] : []),
        ]),
      ),
    );
  } catch (error) {
    list.replaceChildren(h("div", { class: "muted", text: `读取审计失败：${error.message ?? "未知错误"}` }));
  }
}

/* —— 热重载 —— */

async function refreshFromDisk() {
  const payload = await api("/api/casts");
  state.casts = payload.casts;
  renderRail();
  if (!state.current) return;
  if (!state.casts.some((cast) => cast.id === state.current)) {
    $("empty").hidden = false;
    $("detail").hidden = true;
    return;
  }
  renderDetail(await api(`/api/casts/${state.current}`));
  const tab = document.querySelector(".tab.is-active")?.dataset.tab ?? "contract";
  if (tab === "grants") renderGrants();
  if (tab === "audit") void renderAudit();
}

// 截图与自动化环境可用 ?no-live=1 关闭长连接，避免页面永远不进入空闲状态。
if (!new URLSearchParams(location.search).has("no-live")) {
  const live = new EventSource("/api/events");
  live.addEventListener("refresh", () => {
    void refreshFromDisk().catch(() => undefined);
  });
}

$("grantsSave").addEventListener("click", () => void saveGrants());
$("auditRefresh").addEventListener("click", () => void renderAudit());

$("runVerb").addEventListener("change", syncRunNames);
$("runName").addEventListener("change", () => {
  const manifest = state.manifest;
  const name = $("runName").value;
  if ($("runVerb").value !== "invoke") return;
  const tool = manifest.tools.find((t) => t.name === name);
  if (tool?.examples?.[0]) $("runArgs").value = JSON.stringify(tool.examples[0].call, null, 2);
});
$("runBtn").addEventListener("click", run);

try {
  const payload = await api("/api/casts");
  state.casts = payload.casts;
  renderRail();
  if (state.casts.length === 0) {
    $("emptyText").textContent = "当前目录下没有找到 cast";
  } else {
    const wanted = readHash();
    const known = state.casts.some((c) => c.id === wanted.id);
    await select(known ? wanted.id : state.casts[0].id);
    activateTab(wanted.tab);
    writeHash();
  }
} catch (error) {
  $("emptyText").textContent = "无法连接宿主。用 `kiln studio <dir>` 启动。";
}
