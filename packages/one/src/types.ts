export interface PermissionDecl {
  readonly capability: string;
  readonly scope: string;
  readonly human: string;
  readonly reason: string;
}

export interface UpConfig {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly appsDir: string;
  readonly dataDir: string;
  readonly policy: "strict" | "local" | "relaxed";
  readonly clients: "auto" | "none" | readonly string[];
  readonly autostart: boolean;
  readonly handshake: {
    readonly timeoutMs: number;
    readonly probeTool: string;
    readonly describeTool: string;
    readonly protocolVersion: string;
  };
  readonly permissions: readonly PermissionDecl[];
}

export interface PermissionState {
  readonly status: "pending" | "granted" | "revoked";
  readonly grantedAt?: string;
  readonly revokedAt?: string;
  readonly source?: string;
  readonly policy?: string;
}

export interface ConnectionRecord {
  readonly client: string;
  readonly configPath: string;
  readonly serverName: string;
  readonly addedAt: string;
  readonly backupPath?: string;
  readonly removedAt?: string;
}

export interface HandshakeResult {
  readonly ok: boolean;
  readonly at: string;
  readonly ms: number;
  readonly protocolVersion?: string;
  readonly tools?: number;
  readonly describeOk?: boolean;
  readonly probeOk?: boolean;
  readonly error?: string;
}

export interface AutostartState {
  readonly platform: string;
  readonly path: string;
  readonly enabledAt: string;
}

export interface OneState {
  readonly schemaVersion: 1;
  readonly bundle: string;
  readonly permissions: PermissionState;
  readonly connections: readonly ConnectionRecord[];
  readonly lastCheck: HandshakeResult | null;
  readonly autostart: AutostartState | null;
  readonly connectedAt?: string;
}

export interface ReadyReport {
  readonly ok: true;
  readonly command: "up";
  readonly schemaVersion: 1;
  readonly human: string;
  readonly bundle: string;
  readonly version: string;
  readonly policy: string;
  readonly node: string;
  readonly apps: readonly string[];
  readonly permissions: readonly PermissionDecl[];
  readonly permissionStatus: string;
  readonly connections: readonly ConnectionRecord[];
  readonly manualConfig: string;
  readonly handshake: HandshakeResult;
  readonly dataDir: string;
  readonly autostart: AutostartState | null;
  readonly integrity: { readonly verified: boolean; readonly files: number };
  readonly nextSteps: readonly string[];
}

export interface UpOptions {
  readonly bundle?: string;
  readonly runtimeRoot?: string;
  readonly dev?: boolean;
  readonly requireApproval?: boolean;
  readonly autostart?: boolean;
  readonly clients?: readonly string[];
  readonly skipHandshake?: boolean;
  readonly skipRegister?: boolean;
}

export interface StatusReport {
  readonly ok: true;
  readonly command: "status";
  readonly schemaVersion: 1;
  readonly bundle: string;
  readonly installed: boolean;
  readonly connected: boolean;
  readonly permissions: PermissionState;
  readonly permissionLines: readonly string[];
  readonly connections: readonly ConnectionRecord[];
  readonly lastCheck: HandshakeResult | null;
  readonly autostart: AutostartState | null;
  readonly manualConfig: string;
  readonly human: string;
}
