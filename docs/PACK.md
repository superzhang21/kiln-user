# 离线分发包（.kiln）

> 目标：把「拷一个源码文件夹」变成「安装一个可校验、可签名、可卸载的应用包」。

## 1. 格式

`.kiln` 是单文件容器：

```text
magic "KILN1\0" + gzip(JSON.stringify(artifact))
```

`artifact` 结构与 [FUSION.md](./FUSION.md) 一致：清单原文、全部源码文本、逐文件 sha256、`compatibility`、可选 Ed25519 `signature`。选择 gzip 而非 tar 是为了零依赖、可流式校验、且解包逻辑只依赖 `node:zlib`。

| 特性   | 说明                                               |
| ------ | -------------------------------------------------- |
| 可复现 | 同一目录内容生成同一摘要（JSON 键排序）            |
| 可校验 | 逐文件哈希 + 结构校验，一次报全部问题              |
| 可签名 | Ed25519；安装时可用 `--require-signature` 强制验签 |
| 有上限 | 单文件 512 KB、总大小 2 MB、安装包 32 MB           |
| 防穿越 | 解包时拒绝 `..` 与绝对路径                         |

旧版 `.kiln.json` 仍可直接安装与校验，读取时自动识别 magic。

## 2. 构建与签名

```bash
kiln keygen --key-dir .kiln/keys --json
kiln artifact build examples/ledger --out dist/ledger.kiln --key <keyId> --json
kiln artifact verify dist/ledger.kiln --key-dir .kiln/keys --require-signature --json
```

未加 `--key` 时产出未签名包；签名写入 `signature: { keyId, value }`，摘要覆盖「去掉签名后的规范化 JSON」。

## 3. 安装、列表与卸载

```bash
kiln install dist/ledger.kiln --key-dir .kiln/keys --require-signature --json
kiln list --json
kiln uninstall ledger --json
```

- 应用库默认在 `~/.kiln`，可用 `--home <dir>` 或环境变量 `KILN_APPS_HOME` 覆盖。
- 解压落点：`<home>/apps/<id>@<version>/`，包含 `cast.json`、源码与 README。
- 登记文件：`<home>/apps.json`，记录版本、目录、安装时间、包摘要、是否签名。
- 安装流程：读取本地文件或下载 URL → 解码 → 验签与哈希 → 解压 → 原子写 `apps.json`。
- 同名应用再次安装会替换旧版本目录，但不会删除其他应用。

## 4. 与宿主安装的区别

| 命令                | 作用域                        | 用途                                        |
| ------------------- | ----------------------------- | ------------------------------------------- |
| `kiln install`      | 全局应用库 `~/.kiln`          | 分发闭环：下载/拷贝后一键装                 |
| `kiln host install` | 工作区 `.kiln/hosts/<tenant>` | 宿主生命周期：安装后还需 `approve` 才能运行 |

两者共用同一份 artifact 与验签逻辑；前者面向「装到本机」，后者面向「装进某个工作区并按人类审批运行」。

## 5. 失败处理

| 错误码                  | 场景                             | 处理                              |
| ----------------------- | -------------------------------- | --------------------------------- |
| `KILN_PACK_INVALID`     | 非 `.kiln`、结构/哈希/签名不匹配 | 重新构建或换回原始包              |
| `KILN_PACK_INSTALL`     | 下载失败、文件不可读、超过 32 MB | 检查 URL/路径与包大小             |
| `KILN_FUSION_SIGNATURE` | 要求验签但找不到公钥或签名不符   | 确认 `--key-dir` 与发布者公钥一致 |

## 6. 验证

`test/pack.spec.ts` 覆盖：编码/解码一致性、压缩收益、安装与列表、卸载清理、签名验签、篡改拒绝、旧 `.json` 兼容。
