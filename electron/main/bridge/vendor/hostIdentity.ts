// VENDORED — 由业务仓 live-assistant-lite 的 src/platform/hostIdentity.ts 原样复制，仅改写相对导入。
// 业务仓提交：见 docs/BRIDGE_INTEGRATION.md。上游/本仓许可：MIT（保留原版权声明）。
// 不要在这里单独改逻辑：改动请回到业务仓，再重新 vendor。
/** Embeddable Electron host boundary. Does not launch a browser or listen on a port. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { identityObservationSchema, type AccountSurface, type IdentityObservation } from "./accountGovernance";
import type { Receipt, Scope } from "./contracts";
import type { HostBridgeDb as Db } from "../sqliteDb"

const id = z.string().trim().min(1).max(200);
const scopeSchema = z.strictObject({ platform: id, accountId: id, roomId: id, sessionId: id });
export const hostActionSchema = scopeSchema.extend({
  actionId: id, kind: z.enum(["reply", "popup", "block", "unblock"]),
  deadlineAt: z.iso.datetime(),
  text: z.string().max(4000).nullable(), productId: id.nullable(), userId: id.nullable(),
  identityGuard: z.strictObject({ surface: z.enum(["douyin_room", "buyin"]), executorId: id, identityRevision: id, bindingRevision: z.number().int().positive() }),
});
export type HostAction = z.infer<typeof hostActionSchema>;
export interface HostIdentityContext {
  /** Reads actual selected creator/room and actual executor. Never echo request scope. */
  read(signal?: AbortSignal): Promise<unknown>;
  /** Check signal and pinned context again immediately before the irreversible page action. */
  execute(action: HostAction, signal?: AbortSignal): Promise<Receipt>;
  /** Observe the original action's result only. Must never click/send or infer absence from a missing row. */
  reconcile?(action: HostAction, signal?: AbortSignal): Promise<unknown>;
}
export interface HostIdentitySource {
  /** Must pin the webContents/account context through read AND execution, including manual navigation invalidation. */
  withContext<T>(surface: AccountSurface, run: (context: HostIdentityContext) => Promise<T>): Promise<T>;
}
export class HostIdentityError extends Error {
  constructor(readonly code: string) { super(code); }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeOf = (s: Scope): Scope => ({ platform: s.platform, accountId: s.accountId, roomId: s.roomId, sessionId: s.sessionId });
const receiptSchema = z.strictObject({ actionId: id, status: z.enum(["confirmed", "uncertain", "failed"]),
  evidenceKind: z.enum(["platform_ack", "ui_observation", "click_only", "none"]), evidenceRef: z.string().min(1).max(1000).nullable(),
  observedAt: z.iso.datetime(), errorCode: z.string().max(200).nullable() });
interface StoredAction { fingerprint: string; receipt: string; action_json: string | null; evidence_mode: string | null }

export class HostIdentityBoundary {
  private readonly boot = randomUUID();
  private lane: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private readonly deps: { db: Db; source: HostIdentitySource; now: () => number; mode: "offline" | "platform"; executionEnabled?: boolean }) {
    deps.db.database.exec(`CREATE TABLE IF NOT EXISTS host_identity_actions (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_identity_audit (at TEXT NOT NULL, action_id TEXT, result TEXT NOT NULL, code TEXT NOT NULL, scope_json TEXT);`);
    const columns = deps.db.prepare("PRAGMA table_info(host_identity_actions)").all<{ name: string }>();
    for (const column of ["action_json", "evidence_mode"]) {
      if (!columns.some(item => item.name === column)) deps.db.database.exec(`ALTER TABLE host_identity_actions ADD COLUMN ${column} TEXT`);
    }
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.pending >= 64) return Promise.reject(new HostIdentityError("host_queue_full"));
    this.pending++;
    const result = this.lane.then(run).finally(() => { this.pending--; });
    this.lane = result.catch(() => undefined);
    return result;
  }
  private audit(actionId: string | null, result: string, code: string, scope?: Scope) {
    this.deps.db.prepare("INSERT INTO host_identity_audit VALUES(?,?,?,?,?)").run(new Date(this.deps.now()).toISOString(), actionId, result, code, scope ? JSON.stringify(scopeOf(scope)) : null);
  }
  private async read(context: HostIdentityContext, scope: Scope, surface: AccountSurface, signal?: AbortSignal): Promise<IdentityObservation> {
    if (signal?.aborted) throw new HostIdentityError("host_request_cancelled");
    const parsed = identityObservationSchema.safeParse(await context.read(signal));
    if (signal?.aborted) throw new HostIdentityError("host_request_cancelled");
    if (!parsed.success) throw new HostIdentityError("host_identity_invalid");
    const seen = parsed.data;
    if (seen.surface !== surface || hash(scopeOf(seen)) !== hash(scopeOf(scope))) throw new HostIdentityError("host_scope_mismatch");
    const age = this.deps.now() - Date.parse(seen.observedAt);
    if (age < 0 || age > 30_000) throw new HostIdentityError("host_identity_stale");
    if (seen.evidenceMode !== this.deps.mode) throw new HostIdentityError("host_evidence_mismatch");
    // Stable within a login generation; changes on restart, identity/role/permission changes.
    return { ...seen, identityRevision: hash([this.boot, scopeOf(seen), seen.surface, seen.executorId, seen.identityRevision, seen.loginState, seen.role, seen.roleVerified, [...seen.permissions].sort()]) };
  }
  observe(scope: Scope, surface: AccountSurface, signal?: AbortSignal): Promise<IdentityObservation> {
    return this.serial(async () => {
      try {
        const seen = await this.deps.source.withContext(surface, ctx => this.read(ctx, scopeSchema.parse(scope), surface, signal));
        this.audit(null, "observed", this.deps.mode, scope);
        return seen;
      } catch (error) {
        const code = error instanceof HostIdentityError ? error.code : "host_probe_failed";
        this.audit(null, "denied", code, scope);
        throw new HostIdentityError(code);
      }
    });
  }
  private normalise(raw: unknown, fallback: Receipt, mode: string | null): Receipt {
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.actionId !== fallback.actionId || mode !== "platform" || this.deps.mode !== "platform") return fallback;
    const r = parsed.data;
    const age = this.deps.now() - Date.parse(r.observedAt);
    if (age < 0 || age > 30_000) return fallback;
    if (r.status !== "uncertain" && (!["platform_ack", "ui_observation"].includes(r.evidenceKind) || !r.evidenceRef?.trim())) return fallback;
    // Do not persist arbitrary platform error strings (may contain page content or credentials).
    return { ...r, errorCode: r.status === "confirmed" ? null : r.status === "failed" ? "host_platform_rejected" : "host_delivery_unknown" };
  }
  reconcile(scope: Scope, actionId: string, signal?: AbortSignal): Promise<Receipt | null> {
    return this.serial(async () => {
      const key = hash([scopeOf(scopeSchema.parse(scope)), id.parse(actionId)]);
      const row = this.deps.db.prepare("SELECT * FROM host_identity_actions WHERE key=?").get<StoredAction>(key);
      if (!row) return null;
      const stored = receiptSchema.parse(JSON.parse(row.receipt));
      if (row.evidence_mode !== "platform" || this.deps.mode !== "platform") return { ...stored, status: "uncertain", evidenceKind: "none", evidenceRef: null, errorCode: "host_evidence_mismatch" };
      if (stored.status !== "uncertain" || !row.action_json) return stored;
      const action = hostActionSchema.parse(JSON.parse(row.action_json));
      try {
        return await this.deps.source.withContext(action.identityGuard.surface, async ctx => {
          const seen = await this.read(ctx, scope, action.identityGuard.surface, signal);
          if (seen.executorId !== action.identityGuard.executorId || seen.loginState !== "authenticated" || !seen.roleVerified
            || seen.role !== (action.kind === "popup" ? "buyin_subaccount" : "room_admin") || !seen.permissions.includes(action.kind) || !ctx.reconcile) return stored;
          // The login may have been rebuilt. Reconciliation is read-only and scoped to the saved original action.
          const receipt = this.normalise(await ctx.reconcile(action, signal), stored, row.evidence_mode);
          if (signal?.aborted) return stored;
          this.deps.db.prepare("UPDATE host_identity_actions SET receipt=? WHERE key=?").run(JSON.stringify(receipt), key);
          this.audit(actionId, receipt.status, "read_only_reconcile", scope);
          return receipt;
        });
      } catch {
        this.audit(actionId, "uncertain", "host_reconcile_unavailable", scope);
        return stored;
      }
    });
  }
  execute(raw: unknown, signal?: AbortSignal): Promise<Receipt> {
    const receivedAt = this.deps.now();
    return this.serial(async () => {
      const parsed = hostActionSchema.safeParse(raw);
      if (!parsed.success) { this.audit(null, "denied", "host_action_invalid"); throw new HostIdentityError("host_action_invalid"); }
      const action = parsed.data;
      const assertCurrentRequest = () => {
        if (signal?.aborted) throw new HostIdentityError("host_request_cancelled");
        if (this.deps.now() >= Math.min(Date.parse(action.deadlineAt), receivedAt + 5_000)) throw new HostIdentityError("host_request_expired");
      };
      let claimed = false;
      const unknown: Receipt = { actionId: action.actionId, status: "uncertain", evidenceKind: "none", evidenceRef: null, observedAt: new Date(this.deps.now()).toISOString(), errorCode: "host_delivery_unknown" };
      const key = hash([scopeOf(action), action.actionId]);
      try {
        assertCurrentRequest();
        return await this.deps.source.withContext(action.kind === "popup" ? "buyin" : "douyin_room", async ctx => {
          const surface = action.kind === "popup" ? "buyin" : "douyin_room";
          const seen = await this.read(ctx, scopeOf(action), surface, signal);
          assertCurrentRequest();
          const g = action.identityGuard;
          if (g.surface !== surface || seen.executorId !== g.executorId || seen.identityRevision !== g.identityRevision) throw new HostIdentityError("host_identity_changed");
          if (seen.loginState !== "authenticated" || !seen.roleVerified || seen.role !== (surface === "buyin" ? "buyin_subaccount" : "room_admin") || !seen.permissions.includes(action.kind)) throw new HostIdentityError("host_permission_denied");
          if (!this.deps.executionEnabled) throw new HostIdentityError("host_execution_disabled");
          if ((action.kind === "popup" && !action.productId) || (action.kind === "reply" && !action.text?.trim()) || (["block", "unblock"].includes(action.kind) && !action.userId)) throw new HostIdentityError("host_target_missing");
          const fingerprint = hash([scopeOf(action), action.kind, action.text, action.productId, action.userId]);
          const existing = this.deps.db.prepare("SELECT * FROM host_identity_actions WHERE key=?").get<StoredAction>(key);
          if (existing) {
            if (existing.fingerprint !== fingerprint) throw new HostIdentityError("host_idempotency_conflict");
            this.audit(action.actionId, "replayed", "no_resend", action);
            if (existing.evidence_mode !== "platform" || this.deps.mode !== "platform") return { ...unknown, errorCode: "host_evidence_mismatch" };
            return JSON.parse(existing.receipt) as Receipt;
          }
          // Durable uncertain BEFORE touching the platform: crash/restart never blindly resends.
          this.deps.db.prepare("INSERT INTO host_identity_actions(key,fingerprint,receipt,action_json,evidence_mode) VALUES(?,?,?,?,?)")
            .run(key, fingerprint, JSON.stringify(unknown), JSON.stringify(action), this.deps.mode);
          claimed = true;
          assertCurrentRequest();
          const received = await ctx.execute(action, signal);
          const receipt = this.deps.mode === "offline" ? { ...unknown, errorCode: "offline_simulation" }
            : this.normalise(received, unknown, this.deps.mode);
          this.deps.db.prepare("UPDATE host_identity_actions SET receipt=? WHERE key=?").run(JSON.stringify(receipt), key);
          this.audit(action.actionId, receipt.status, this.deps.mode, action);
          return receipt;
        });
      } catch (error) {
        const code = error instanceof HostIdentityError ? error.code : "host_execution_error";
        this.audit(action.actionId, claimed ? "uncertain" : "denied", code, action);
        if (claimed) return unknown;
        throw new HostIdentityError(code);
      }
    });
  }
}

/** Mount AFTER the host's authentication/body-size middleware. No standalone listener is created. */
export async function handleHostIdentityRequest(host: HostIdentityBoundary, method: string, url: URL, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown } | null> {
  const kinds = { "/reply": "reply", "/product/show": "popup", "/users/block": "block", "/users/unblock": "unblock" } as const;
  const queryScope = () => scopeSchema.parse({ platform: url.searchParams.get("platform"), accountId: url.searchParams.get("account_id"), roomId: url.searchParams.get("room_id"), sessionId: url.searchParams.get("session_id") });
  const wire = (r: Receipt) => ({ status: r.status, evidence_kind: r.evidenceKind, evidence_ref: r.evidenceRef, observed_at: r.observedAt, error_code: r.errorCode });
  try {
    if (url.pathname.startsWith("/private/")) return { status: 403, body: { error_code: "creator_private_messages_disabled" } };
    if (url.pathname === "/identity" && method === "GET") {
      const surface = z.enum(["douyin_room", "buyin"]).parse(url.searchParams.get("surface"));
      return { status: 200, body: await host.observe(queryScope(), surface, signal) };
    }
    if (url.pathname.startsWith("/actions/") && method === "GET") {
      const receipt = await host.reconcile(queryScope(), decodeURIComponent(url.pathname.slice("/actions/".length)), signal);
      return { status: receipt ? 200 : 404, body: receipt ? wire(receipt) : { error_code: "unknown_action" } };
    }
    if (Object.hasOwn(kinds, url.pathname) && method === "POST") {
      const raw = z.strictObject({ action_id: id, idempotency_key: id, platform: id, account_id: id, room_id: id, session_id: id,
        deadline_at: z.iso.datetime(),
        text: z.string().max(4000).nullish(), product_id: id.nullish(), user_id: id.nullish(),
        mention: z.object({ user_id: id, mode: z.literal("native") }).nullish(), identity_guard: hostActionSchema.shape.identityGuard,
      }).parse(body);
      if (raw.action_id !== raw.idempotency_key) throw new HostIdentityError("host_idempotency_conflict");
      const kind = kinds[url.pathname as keyof typeof kinds];
      if ((kind === "reply" && (raw.user_id || raw.product_id)) || (kind !== "reply" && raw.mention)
        || (kind === "popup" && (raw.text || raw.user_id)) || (["block", "unblock"].includes(kind) && (raw.text || raw.product_id))) throw new HostIdentityError("host_target_conflict");
      const receipt = await host.execute({ platform: raw.platform, accountId: raw.account_id, roomId: raw.room_id, sessionId: raw.session_id,
        actionId: raw.action_id, kind, deadlineAt: raw.deadline_at, text: raw.text ?? null, productId: raw.product_id ?? null,
        userId: raw.user_id ?? raw.mention?.user_id ?? null, identityGuard: raw.identity_guard }, signal);
      return { status: 200, body: wire(receipt) };
    }
    if (Object.hasOwn(kinds, url.pathname) || url.pathname === "/identity" || url.pathname.startsWith("/actions/")) return { status: 405, body: { error_code: "host_method_not_allowed" } };
    return null;
  } catch (error) {
    return { status: error instanceof HostIdentityError ? 409 : 400, body: { error_code: error instanceof HostIdentityError ? error.code : "host_request_invalid" } };
  }
}
