// VENDORED — 由业务仓 live-assistant-lite 的 contracts/accountGovernance.ts 原样复制，仅改写相对导入。
// 业务仓提交：见 docs/BRIDGE_INTEGRATION.md。上游/本仓许可：MIT（保留原版权声明）。
// 不要在这里单独改逻辑：改动请回到业务仓，再重新 vendor。
import { z } from "zod";

const id = z.string().trim().min(1).max(200);
export const accountSurfaceSchema = z.enum(["douyin_room", "buyin"]);
export type AccountSurface = z.infer<typeof accountSurfaceSchema>;
export const accountBindingSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  assistantId: id,
  buyinOperatorId: id,
  roomAdminEvidence: z.enum(["unverified", "user_confirmed"]),
  /**
   * 本场实际使用的核验面（缺省 = 两面都要，保持旧行为）。
   *
   * 为什么需要这个字段：达人个人号在百应后台没有「子账号授权」，唯一可登录的中控台就是百应一个面，
   * 硬要求 `douyin_room` 面会永远核验失败、场次根本跑不起来。允许显式声明只用哪些面，
   * 但**只影响每 30 秒的保活探针**：每个真实动作仍在派发前按它自己的面单独核验
   * （`authorizeAccount` 不变），所以没声明的面既不会让动作通过，也不会被当成已验证。
   */
  surfaces: z.array(accountSurfaceSchema).min(1).max(2).optional(),
});
export type AccountBindingInput = z.infer<typeof accountBindingSchema>;
export const identityObservationSchema = z.strictObject({
  platform: id, accountId: id, roomId: id, sessionId: id,
  surface: accountSurfaceSchema,
  executorId: id,
  loginState: z.enum(["authenticated", "expired", "logged_out", "unknown"]),
  role: z.enum(["room_admin", "buyin_subaccount", "unknown"]),
  roleVerified: z.boolean(),
  permissions: z.array(z.enum(["reply", "popup", "block", "unblock"])).max(4),
  observedAt: z.iso.datetime(),
  identityRevision: id,
  executionGuard: z.literal("identity_revision_v2"),
  evidenceMode: z.enum(["platform", "offline"]),
});
export type IdentityObservation = z.infer<typeof identityObservationSchema>;

export interface AccountBinding {
  sessionId: string; platform: string; accountId: string; roomId: string;
  assistantId: string; buyinOperatorId: string;
  roomAdminEvidence: "unverified" | "user_confirmed";
  /** 本场声明的核验面；缺省（旧绑定）等价于两面都要。 */
  surfaces?: AccountSurface[];
  revision: number;
}

/** 绑定里声明的核验面；没声明就是两面都要（保持旧行为）。 */
export function bindingSurfaces(binding: AccountBinding | null | undefined): AccountSurface[] {
  const declared = (binding?.surfaces ?? []).filter((surface): surface is AccountSurface => surface === "douyin_room" || surface === "buyin");
  return declared.length > 0 ? declared : ["douyin_room", "buyin"];
}
