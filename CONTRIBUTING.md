# 贡献指南

感谢参与。这份文档只讲**怎么改**，不讲理念——理念在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 环境

- Node.js ≥ 22.18（直接运行 `.ts`，无需构建）
- 运行与测试无需 `npm install`：本项目运行时零依赖
- 执行 `npm run typecheck` 前需运行 `npm install` 安装开发依赖

```bash
cd kiln           # 进入已下载或克隆的仓库目录
npm test          # 使用 Node 内置测试运行器
npm run check     # 校验两个示例 cast
npm install       # 仅类型检查与格式化需要开发依赖
npm run typecheck
npm run format    # 统一格式化源码、配置与文档
npm run format:check
npm run studio    # 打开 Studio，默认 127.0.0.1:4310
```

克隆地址见 `README.md` 的安装章节；仓库尚未上架前，直接下载源码压缩包即可。

## 语言与命名约定

- **面向用户的一切文字都用简体中文**：文档说明、界面文案、CLI 帮助与错误输出、注释、提交信息中的描述性文字、问题与合并请求模板。
- **保留英文的例外**：命令名、JSON 字段名、协议名与错误码（`invoke`、`mcpServers`、`KILN_*`）、品牌名、平台专名、许可全文与法定版权声明、代码标识符。
- **注释规范**：只解释「为什么」，不解释「做什么」；统一用 `/* —— 说明 —— */` 作分隔，不用英文分隔线；中文标点用全角。
- **术语对照**：cast（微应用）指一个应用；一键包指交付目录 `one/`；产品层指源码目录 `packages/one/`；工作台指 Studio；状态面板指 `kiln panel` 打开的页面。同一文档内不要混用「cast / 微应用 / 应用」。
- **路径与代码块**：文档与示例统一使用正斜杠；代码块按内容标注语言（`bash` / `cmd` / `text` / `ts` / `json`）。
- **错误码**：新增错误码必须同时登记 `packages/grain/src/codes.ts` 与 `docs/ERRORS.md`，并保证 `issue.docs` 锚点可达。
- **外部链接**：只允许可验证的标准链接与已验证项目主页；其余一律使用仓库内相对地址，不写占位域名或虚构仓库地址。
- **文档语气**：开头直接给命令、数字或适用范围，不写「本文说明……」「本文记录……」。状态不用 ✅❌⚠️ 之类符号，用句子写。
- **不要机械并列**：同一篇里不要连续超过四条同构句式（「**小标题**：解释。」），第四条起改成散文或并进前一条。
- **一个机制只在一处讲透**：最完整的那篇负责解释，其余地方给链接。例如「拒绝不可被吞」以 `docs/ARCHITECTURE.md` 为准，「安全边界」以 `SECURITY.md` 为准。
- **抽象结论要带数字或场景**：不写「项目仍处于早期阶段」，写清缺的是哪一块。
- **代码注释里不出现内部代号**：路线图编号（如 P2、P6）只属于 `docs/INTEGRATION-PLAN.md`，源码注释里不写。

## 结构约定

仓库是**单包**：只有根目录一份 `package.json`，没有 workspaces，没有构建产物。

包之间靠 `imports` 映射互相引用：

```json
"#grain": "./packages/grain/src/index.ts"
```

**不要在 `packages/*` 下新增 `package.json`。** Node 解析 `#grain` 时找最近的 `package.json`，多一份就会打断映射。同理，不要引入构建步骤——现在 `node file.ts` 就能跑，这是特性，不是偷懒。

依赖方向严格向下，不允许反向：

```text
surface → host → pact → forge → grain
```

`studio` 与 `one` 位于这条链之上：前者只调用 `pact` / `host` 的读取能力，后者通过 CLI 与 `#*` 映射使用内核，不改变下层依赖方向。`grain` 不认识 `pact`，`pact` 不认识 `host`。破坏这条规则会立刻在 import 上暴露。

## 常见改动

### 新增一个 cast（微应用）

```
examples/<name>/
├── cast.json
├── src/pact.ts
└── README.md
```

要点：

1. 每个工具**必须有**一条真实示例（`call` + `result`），校验器会拦。
2. 只能通过 `ctx.cap` 触碰外部世界，不要 `import fs`。
3. 能预期的失败返回结构化结果（`{ ok: false, reason }`），不要抛异常；越权除外——越权由网关记账，抛不抛都一样会被拦。
4. 需要的权限写进 `grants`，按最小必要申请。

### 新增一个 agent 适配器

实现 `AgentAdapter` 三个字段加一个方法，注册进插件：

```ts
export const acpAdapter: AgentAdapter = {
  id: "acp",
  label: "ACP session",
  produces: "endpoint",
  weight: 0.2,
  async expose(catalog) {
    return { adapter: "acp", kind: "endpoint", payload: {}, notes: [] };
  },
};
```

写完后在 `docs/PLUGINS.md` 的适配器表里加一行，并补一个 `test/plugins.spec.ts` 用例。

### 新增一种能力

实现 `CapabilityDriver`，在 `packages/host/src/gateway.ts` 里给出句柄。**新增能力必须同时补授权检查**，否则等于开了后门。

### 修改校验规则

1. 在 `packages/grain/src/codes.ts` 加错误码与 hint。
2. 在 `packages/grain/src/manifest.ts` 加检查。
3. 在 `test/fixtures/broken/cast.json` 制造对应反例。
4. 在 `test/manifest.spec.ts` 断言该码出现。

**没有反例的校验规则不要合并。** 只验正例的校验器等于没有校验器。

## 测试

```bash
npm test                                  # 全部
node --test test/policy.spec.ts           # 单个文件
```

用 Node 内置 `node:test` + `node:assert/strict`，不引入测试框架。

写测试的优先级：**先写能证明缺陷的反例**，再写正例。这个仓库最重要的一条测试是「cast 无法把授权拒绝吞成业务结果」——它当初就是先失败，才发现设计漏洞的。

## 提交

- 提交信息用 `<type>: <subject>`，类型取 `feat` / `fix` / `docs` / `test` / `refactor` / `chore`。
- 一个提交只做一件事。重命名与逻辑改动分开提交，方便 review。
- 改行为必须同步 `CHANGELOG.md` 的 `Unreleased` 段。

## 合并请求检查单

- [ ] `npm test` 全过
- [ ] `npm run check` 全过
- [ ] 新增校验规则带反例
- [ ] 新增能力带授权检查
- [ ] 改行为已更新 CHANGELOG
- [ ] 没有新增运行时依赖（要加请先开 issue 说明理由）
- [ ] 注释只解释「为什么」，不解释「做什么」

## 关于依赖

运行时零依赖是硬约束。要加依赖，先说清楚：这段代码能否用 Node 内置 API 在 200 行内写完？能，就不要加。

开发期依赖（如 `typescript` 用于 `npm run typecheck`）不受此限。

## 许可

提交即表示同意以 [Apache-2.0](LICENSE) 授权你的贡献。新增的文件不要贴入其他项目的代码；如确有必要，必须在 `NOTICE` 里登记来源与许可。
