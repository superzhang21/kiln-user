import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { KilnError, validateManifest } from "#grain";

/** 版本化、可复现、可签名的应用交付单元。 */
export interface Artifact {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly createdAt?: string;
  readonly manifest: Record<string, unknown>;
  readonly files: Record<string, string>;
  readonly hashes: Record<string, string>;
  readonly compatibility: { readonly minHost: string; readonly schema: string };
  readonly signature?: { readonly keyId: string; readonly value: string };
}

export interface BuildOptions {
  readonly sign?: { readonly privateKey: string; readonly keyId: string };
  readonly includeTimestamp?: boolean;
}

const MAX_FILE_BYTES = 512_000;
const MAX_TOTAL_BYTES = 2_000_000;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function collect(dir: string, base = "", out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const relative = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, relative, out);
    else if (entry.isFile()) {
      const body = await readFile(full);
      if (body.length > MAX_FILE_BYTES) {
        throw new KilnError({
          code: "KILN_FUSION_ARTIFACT",
          message: `单文件超过 ${MAX_FILE_BYTES} 字节：${relative}`,
          hint: "精简应用资源，或把大文件改为运行时按需读取。",
        });
      }
      out[relative] = body.toString("utf8");
    }
  }
  return out;
}

/** 不写磁盘，纯函数式输出：同一目录内容必须得到同一哈希。 */
export async function buildArtifact(
  dir: string,
  options: BuildOptions = {},
): Promise<{ artifact: Artifact; bytes: number; digest: string }> {
  const castDir = path.resolve(dir);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(path.join(castDir, "cast.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new KilnError({
      code: "KILN_FUSION_ARTIFACT",
      message: `读不到 cast.json：${castDir}`,
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  const checked = validateManifest(manifest, { file: path.join(castDir, "cast.json") });
  if (!checked.manifest) {
    throw new KilnError({
      code: "KILN_FUSION_ARTIFACT",
      message: "清单未通过校验，不能构建 artifact",
      hint: "先运行 kiln check <dir> 修复全部问题。",
      detail: { issues: checked.issues },
    });
  }
  const files = await collect(castDir);
  const total = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new KilnError({
      code: "KILN_FUSION_ARTIFACT",
      message: `应用总大小超过 ${MAX_TOTAL_BYTES} 字节`,
      hint: "精简源码与资源后再构建。",
    });
  }
  const hashes: Record<string, string> = {};
  for (const [relative, body] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    hashes[relative] = sha256(body);
  }
  const artifact: Artifact = {
    schemaVersion: 1,
    id: checked.manifest.id,
    version: checked.manifest.version,
    ...(options.includeTimestamp ? { createdAt: new Date().toISOString() } : {}),
    manifest,
    files,
    hashes,
    compatibility: { minHost: "0.2.0", schema: "cast-1" },
  };
  const digest = sha256(canonical(artifact));
  const signed: Artifact = options.sign
    ? {
        ...artifact,
        signature: {
          keyId: options.sign.keyId,
          value: edSign(null, Buffer.from(digest, "utf8"), options.sign.privateKey).toString("base64"),
        },
      }
    : artifact;
  return { artifact: signed, bytes: Buffer.byteLength(canonical(signed), "utf8"), digest };
}

export async function writeArtifact(file: string, artifact: Artifact): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function readArtifact(file: string): Promise<Artifact> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Artifact;
  } catch (error) {
    throw new KilnError({
      code: "KILN_FUSION_ARTIFACT",
      message: `artifact 不可读：${file}`,
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly issues: { readonly code: string; readonly message: string }[];
  readonly artifact?: Artifact;
  readonly digest?: string;
}

/** 一次报出全部问题：结构、逐文件哈希、版本与可选签名。 */
export async function verifyArtifact(
  input: string | Artifact,
  options: { publicKeys?: Record<string, string>; requireSignature?: boolean } = {},
): Promise<VerifyResult> {
  const artifact = typeof input === "string" ? await readArtifact(input) : input;
  const issues: { code: string; message: string }[] = [];
  if (artifact.schemaVersion !== 1)
    issues.push({ code: "KILN_FUSION_ARTIFACT", message: "artifact schemaVersion 必须为 1" });
  if (artifact.compatibility?.schema !== "cast-1") {
    issues.push({ code: "KILN_FUSION_ARTIFACT", message: "不兼容的清单模式版本" });
  }
  const checked = validateManifest(artifact.manifest);
  if (!checked.manifest) {
    for (const item of checked.issues) issues.push({ code: item.code, message: item.message });
  }
  for (const [relative, expected] of Object.entries(artifact.hashes ?? {})) {
    const body = artifact.files?.[relative];
    if (body === undefined) {
      issues.push({ code: "KILN_FUSION_ARTIFACT", message: `artifact 缺少文件：${relative}` });
    } else if (sha256(body) !== expected) {
      issues.push({ code: "KILN_FUSION_ARTIFACT", message: `文件哈希不符：${relative}` });
    }
  }
  for (const relative of Object.keys(artifact.files ?? {})) {
    if (!(relative in (artifact.hashes ?? {}))) {
      issues.push({ code: "KILN_FUSION_ARTIFACT", message: `未登记的文件：${relative}` });
    }
  }
  const { signature, ...unsigned } = artifact;
  const digest = sha256(canonical(unsigned));
  if (options.requireSignature && !signature) {
    issues.push({ code: "KILN_FUSION_SIGNATURE", message: "该来源要求签名，但 artifact 未签名" });
  }
  if (signature) {
    const publicKey = options.publicKeys?.[signature.keyId];
    // 未提供公钥库时只校验完整性，签名由安装策略单独验；要求验签时必须能找到公钥。
    if (!publicKey && (options.publicKeys !== undefined || options.requireSignature === true)) {
      issues.push({ code: "KILN_FUSION_SIGNATURE", message: `找不到签名公钥 ${signature.keyId}` });
    } else if (
      publicKey &&
      !edVerify(null, Buffer.from(digest, "utf8"), publicKey, Buffer.from(signature.value, "base64"))
    ) {
      issues.push({ code: "KILN_FUSION_SIGNATURE", message: "签名校验失败，artifact 可能被篡改" });
    }
  }
  return { ok: issues.length === 0, issues, artifact, digest };
}

/** 路径穿越一律拒绝。 */
export async function importArtifact(file: string, outDir: string): Promise<string> {
  const artifact = await readArtifact(file);
  const result = await verifyArtifact(artifact);
  if (!result.ok) {
    throw new KilnError({
      code: "KILN_FUSION_ARTIFACT",
      message: "artifact 校验失败，拒绝导入",
      hint: "确认来源可信后重新构建；不要导入被篡改的包。",
      detail: { issues: result.issues },
    });
  }
  const target = path.resolve(outDir);
  for (const [relative, body] of Object.entries(artifact.files)) {
    const full = path.resolve(target, ...relative.split("/"));
    const inside = path.relative(target, full);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new KilnError({ code: "KILN_FUSION_ARTIFACT", message: `路径越界：${relative}` });
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  }
  return target;
}

export interface Keypair {
  readonly keyId: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly files: { readonly privateKey: string; readonly publicKey: string };
}

/** 生成本地 Ed25519 密钥对，用于可信发布。 */
export async function generateKeypair(dir: string): Promise<Keypair> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = sha256(publicPem).slice(0, 16);
  const keysDir = path.resolve(dir);
  await mkdir(keysDir, { recursive: true });
  const privateFile = path.join(keysDir, `${keyId}.private.pem`);
  const publicFile = path.join(keysDir, `${keyId}.public.pem`);
  await writeFile(privateFile, privatePem, "utf8");
  await writeFile(publicFile, publicPem, "utf8");
  return {
    keyId,
    publicKey: publicPem,
    privateKey: privatePem,
    files: { privateKey: privateFile, publicKey: publicFile },
  };
}

export function resignArtifact(artifact: Artifact, sign: { privateKey: string; keyId: string }): Artifact {
  // 签名不覆盖自身，否则验签时得先验签才能算出摘要。
  const { signature: previous, ...unsigned } = artifact;
  void previous;
  const digest = sha256(canonical(unsigned));
  return {
    ...unsigned,
    signature: {
      keyId: sign.keyId,
      value: edSign(null, Buffer.from(digest, "utf8"), sign.privateKey).toString("base64"),
    },
  };
}

export async function loadPublicKeys(dir: string): Promise<Record<string, string>> {
  const keysDir = path.resolve(dir);
  const out: Record<string, string> = {};
  let entries: string[];
  try {
    entries = await readdir(keysDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".public.pem")) continue;
    out[name.replace(".public.pem", "")] = await readFile(path.join(keysDir, name), "utf8");
  }
  return out;
}
