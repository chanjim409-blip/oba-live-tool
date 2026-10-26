// VENDORED — 由业务仓 live-assistant-lite 的 contracts/index.ts 原样复制，仅改写相对导入。
// 业务仓提交：见 docs/BRIDGE_INTEGRATION.md。上游/本仓许可：MIT（保留原版权声明）。
// 不要在这里单独改逻辑：改动请回到业务仓，再重新 vendor。
/**
 * Shared runtime contracts · v0.3
 *
 * v0.2 was a design draft. v0.3 is the contract actually implemented by the
 * service in `src/` and the console in `web/`. Runtime validation lives in
 * `contracts/schemas.ts`; TypeScript types alone never gate external input.
 * Every field that reaches an execution gate is versioned or timestamped.
 */

/** Stable identifiers only. A nickname is never a primary key. */
export type Scope = {
  platform: string;
  accountId: string;
  roomId: string;
  sessionId: string;
};

/** All six versions must be re-read immediately before any platform action. */
export type Versions = {
  context: number;
  knowledge: string;
  persona: string;
  catalog: number;
  offer: number;
  runEpoch: number;
};

export type IdentityQuality = "stable" | "weak";
export type ViewerRole = "viewer" | "host" | "moderator" | "bot";
/** asr text is a candidate: it may never mark something answered. */
export type EventSource = "platform" | "asr" | "system";

export type LiveEvent = Scope & {
  schemaVersion: 1;
  eventId: string;
  traceId: string;
  occurredAt: string;
  receivedAt: string;
  viewerId: string;
  viewerNickname: string | null;
  identityQuality: IdentityQuality;
  role: ViewerRole;
  text: string;
  replyToEventId: string | null;
  source: EventSource;
  /** Per-viewer thread version at ingest; a stale draft is detectable later. */
  contextVersion: number;
};

export type Evidence = {
  sourceId: string;
  sourceRef: string;
  observedAt: string;
  reviewStatus: "candidate" | "approved" | "rejected";
};

export type KnowledgeHit = {
  cardId: string;
  version: string;
  productId: string | null;
  skuId: string | null;
  intent: string;
  template: string;
  evidence: Evidence[];
  validUntil: string | null;
  score: number | null;
  conflict: boolean;
  /** Human-readable scoring trace shown in the console, never used for gating. */
  scoreReasons?: string[];
};

export type LiveOffer = Scope & {
  productId: string;
  skuId: string;
  version: number;
  amountMinor: number | null;
  currency: string;
  priceKind: string | null;
  conditions: string[];
  giftStatus: "unknown" | "none" | "present";
  giftDescription: string | null;
  giftConditions: string[];
  observedAt: string;
  validUntil: string;
  evidence: Evidence[];
  /**
   * 权益审核状态（R2）：candidate/rejected 的权益**不能**进模板。
   * 以前这个字段只写在库里、没人读，于是候选权益照样能生成可执行价格。
   */
  reviewStatus: "candidate" | "approved" | "rejected";
};

export type ProductProfile = {
  productId: string;
  title: string;
  spec: string | null;
  aliases: string[];
  evidence: Evidence[];
};

export type CatalogItem = {
  productId: string;
  promotionId: string | null;
  ordinal: number;
  available: boolean;
  title: string | null;
};

export type Catalog = Scope & {
  version: number;
  observedAt: string;
  items: CatalogItem[];
};

export type Persona = {
  personaVersion: string;
  addressStyle: string;
  maxChars: number;
  bannedPhrases: string[];
  approvedExamples: string[];
  reviewStatus: "candidate" | "approved" | "rejected";
};

export type ChoiceResult = {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

/** route: whether the message deserves handling at all. */
export type Route = "answer" | "clarify" | "human" | "ignore";

export type Judgment = {
  route: ChoiceResult;
  intent: ChoiceResult;
  product: ChoiceResult;
  actualModel: string;
  elapsedMs: number;
  contextVersion: number;
};

export type ActionKind = "reply" | "popup" | "block" | "unblock" | "dm";
export type ActionState =
  "draft" | "queued" | "sending" | "confirmed" | "uncertain" | "failed" | "cancelled" | "expired";

export type Receipt = {
  actionId: string;
  status: "confirmed" | "uncertain" | "failed";
  observedAt: string;
  evidenceKind: "platform_ack" | "ui_observation" | "click_only" | "none";
  evidenceRef: string | null;
  errorCode: string | null;
};

/**
 * 来源绑定（R4/N02）：动作依赖哪些事实、卡、权益、NAS 快照、库存快照。
 *
 * 为什么要单独存：`evidence.sourceRef` 只是给人看的字符串，派发前没法据此复核
 * "这条回复依据的卡是不是被撤了、权益是不是过期了"。绑定关系必须结构化、可重新查询，
 * 并且参与 contentHash——来源变了，旧批准自动失效。
 */
export type ActionSourceKind = "session-fact" | "card" | "offer" | "nas" | "stock" | "catalog";

export type ActionSource = {
  kind: ActionSourceKind;
  /** 本场知识 knowledgeId / 知识卡 cardId / 权益 productId:skuId / NAS cardId / 库存 productId:skuId */
  id: string;
  /** 版本号或内容指纹；来源变了就能比对出来 */
  version: string | null;
  /** 来源自身声明的有效期（null 表示长期有效，仍要在派发前复核） */
  validUntil: string | null;
  /** 库存公告所宣称的状态；仅 stock 来源使用，必须与本地最新快照一致。 */
  stockState?: "in_stock" | "out_of_stock";
};

/** 提及目标（U01）：只认稳定用户 id，昵称不参与判定。 */
export type MentionTarget = {
  userId: string;
  /** native=平台原生@；text=正文「@昵称」降级；none=不@ */
  mode: "native" | "text" | "none";
  /** 平台能力不足时的说明：界面要如实展示，不许假装已原生@ */
  fallbackReason: string | null;
};

export type Action = Scope & {
  /** Ephemeral host precondition, never restored from an old queued action. */
  identityGuard?: { surface: "douyin_room" | "buyin"; executorId: string; identityRevision: string; bindingRevision: number };
  actionId: string;
  requestId: string;
  triggerEventIds: string[];
  /** Stable or weak identity key; never a nickname alone across sessions. */
  viewerKey: string;
  versions: Versions;
  expiresAt: string;
  state: ActionState;
  kind: ActionKind;
  productId: string | null;
  skuId: string | null;
  text: string | null;
  /** sha256 of kind+text+targets: approval for content A never sends content B. */
  contentHash: string;
  mode: LiveMode;
  autoApproved: boolean;
  /** true only when the "worth replying" call also judged the popup suitable. */
  popupEligible: boolean;
  intent: string | null;
  route: Route | null;
  reason: string | null;
  evidence: Evidence[];
  missingFacts: string[];
  receipt: Receipt | null;
  /** 草稿来源：session-fact 的草稿依赖本场事实，派发前必须复核来源仍有效（T06）。 */
  draftFrom: "template" | "session-fact" | "variant" | "blocked" | null;
  /** 独立答疑要 @ 对应发言人（U01）；公共同题回复/库存公告/广告为 null。 */
  mention: MentionTarget | null;
  /** 来源绑定：派发前逐条复核（R4）。 */
  sources: ActionSource[];
  /** 私信动作所属会话 id（N07）；其余动作为 null。 */
  conversationId: string | null;
  /** 生成这条动作时的直播策略版本（N02）：策略变了旧动作要重新校验。 */
  policyVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type LiveMode = "shadow" | "draft" | "auto";
export type SessionState = "idle" | "running" | "paused" | "stopped";

export type Session = Scope & {
  /** 主播标识：知识包、本场知识、待审条目按它隔离。 */
  anchor: string;
  state: SessionState;
  mode: LiveMode;
  runEpoch: number;
  contextVersion: number;
  knowledgeVersion: string;
  personaVersion: string;
  catalogVersion: number;
  autoAllowlist: string[];
  pausedReason: string | null;
  revision: number;
  startedAt: string | null;
  updatedAt: string;
};

export type ManualLock = Scope & {
  lockId: string;
  productId: string | null;
  skuId: string | null;
  owner: string;
  note: string | null;
  version: number;
  acquiredAt: string;
};

export type CurrentProduct = {
  productId: string;
  promotionId: string | null;
  ordinal: number | null;
  source: "manual" | "auto" | "platform_loop" | "unknown";
  observedAt: string;
};

export type DegradeFlag = {
  component: "jev" | "llm" | "nas" | "asr" | "platform";
  active: boolean;
  reason: string;
  since: string;
};

export type CounterSet = {
  events: number;
  drafts: number;
  shadowed: number;
  confirmed: number;
  uncertain: number;
  failed: number;
  cancelled: number;
  expired: number;
};

export type StateView = {
  stateRevision: number;
  serverTime: string;
  session: Session | null;
  mode: LiveMode;
  platform: {
    adapter: string;
    connected: boolean;
    mocked: boolean;
    detail: string | null;
  };
  lock: ManualLock | null;
  currentProduct: CurrentProduct | null;
  asr: { enabled: boolean; status: string; lastFinalAt: string | null; detail: string | null };
  knowledge: {
    version: string;
    cards: number;
    offers: number;
    publishedAt: string | null;
    source: string;
  };
  persona: { version: string; publishedAt: string | null } | null;
  counters: CounterSet;
  degraded: DegradeFlag[];
  flags: { autoEnabled: boolean; approvalsRequired: boolean; shadow: boolean };
  /**
   * 多账号并行：本次返回的是"聚焦场次"的视图，`sessions` 列出所有场次供前端切换。
   * 切换聚焦只影响前端视角，不会暂停或影响其他场次继续回复。
   */
  sessions: SessionSummary[];
  accounts: AccountSummary[];
  /** 资源上限（同时开播账号数），前端据此提示"还能开几个"。 */
  limits: { maxParallelAccounts: number };
};

/** 前端账号切换用的场次摘要。 */
export type SessionSummary = {
  sessionId: string;
  /** 平台：douyin / wxchannel / jd / taobao / pdd …（跨平台账号靠它区分） */
  platform: string;
  accountId: string;
  roomId: string;
  anchor: string;
  /** 配置里的展示名（可空） */
  label: string | null;
  /** 账号标签（地区/店型/账号类型…）：同主播多账号靠它区分，前端标签页上直接显示 */
  tags: string[];
  state: string;
  mode: LiveMode;
  revision: number;
  runEpoch: number;
  focused: boolean;
  /** 与当前视图场次同一套运行时吗？用于提示"这一场是不是在跑" */
  running: boolean;
  /** 这一路适配器是否连上（跨平台时每路各自判断） */
  connected: boolean;
};

/**
 * 账号台账里的一行（前端账号管理页与标签页用）。
 *
 * 平台客户端区隔状态必须可见：`profileDir`（独立浏览器 profile）与
 * `hasOwnPalletCookie`（百应后台独立登录态）决定了这个账号会不会把别的账号踢下线。
 */
export type AccountSummary = {
  /** platform|accountId|roomId，前端用它做标签页 key */
  accountKey: string;
  platform: string;
  accountId: string;
  roomId: string;
  label: string | null;
  /** 账号标签：同主播多账号共用知识，靠标签区分"这个号是哪个店/哪个地区" */
  tags: string[];
  anchor: string;
  sessionId: string;
  /** mock | oba */
  adapter: string;
  enabled: boolean;
  /** 该账号的平台桥接地址（缺省=全局） */
  bridgeUrl: string | null;
  /** 该账号独立浏览器 profile 目录（空=还没配，多账号时必须配） */
  profileDir: string | null;
  /** 百应货盘来源：none | file | http */
  palletSource: string;
  /** 是否有该账号自己的货盘 cookie（http 来源时必须有，且不能与别的账号共用） */
  hasOwnPalletCookie: boolean;
  sessionState: string | null;
  running: boolean;
  connected: boolean;
};

export type ViewerThread = {
  viewerKey: string;
  viewerId: string;
  nickname: string | null;
  identityQuality: IdentityQuality;
  contextVersion: number;
  events: LiveEvent[];
  openIssues: string[];
  lastActivityAt: string;
};

export type StageTiming = {
  stage: string;
  path: string;
  status: "ok" | "timeout" | "error" | "skipped";
  elapsedMs: number;
  at: string;
  sessionId: string | null;
};

/** Display-only stream payloads. Actions are never replayed from the stream. */
export type StreamEvent =
  | { type: "state"; seq: number; at: string; payload: StateView }
  | { type: "event"; seq: number; at: string; payload: LiveEvent }
  | { type: "thread"; seq: number; at: string; payload: ViewerThread }
  | { type: "action"; seq: number; at: string; payload: Action }
  | { type: "timing"; seq: number; at: string; payload: StageTiming }
  | { type: "log"; seq: number; at: string; payload: { level: string; message: string; detail?: unknown } }
  | { type: "heartbeat"; seq: number; at: string };

export type PlatformCapabilityKey =
  | "login"
  | "monitor_comments"
  | "send_reply"
  | "ensure_product_visible"
  | "receipt"
  | "stable_product_id"
  | "ordinal_mapping"
  | "background_lifetime"
  /** 原生 @（U01）：按稳定用户 id 提及 */
  | "mention_user"
  /** 拉黑/解封（U09）：含结果核对 */
  | "block_user"
  | "unblock_user"
  /** 双向私信（U10）：建会话、发、收、回执 */
  | "open_private_conversation"
  | "send_private_message"
  | "subscribe_private_messages"
  /** SKU 级库存快照（U11）：商品级可售不算数 */
  | "sku_stock_snapshot"
  /** 主播事件身份（U13）：文字或语音的可靠来源 */
  | "host_event_identity"
  /** 商品卡停留/收起（U12 相关） */
  | "product_dwell_control";

export type PlatformCapability = {
  key: PlatformCapabilityKey;
  label: string;
  status: "verified" | "unverified" | "mocked" | "missing";
  evidenceRef: string | null;
  note: string | null;
};

export type PlatformCapabilities = {
  adapter: string;
  mocked: boolean;
  checkedAt: string;
  items: PlatformCapability[];
};

export type RawPlatformEvent = {
  viewerId: string;
  viewerNickname: string | null;
  role?: ViewerRole;
  text: string;
  occurredAt: string;
  identityQuality?: IdentityQuality;
  eventId?: string;
};

export type Unsubscribe = () => void;

export interface PlatformAdapter {
  readonly name: string;
  /** Fresh, read-only host observation. Never infer executor identity from the creator nickname. */
  observeIdentity?(scope: Scope, surface: import("./accountGovernance.js").AccountSurface, signal?: AbortSignal): Promise<unknown>;
  capabilities(scope?: Scope): Promise<PlatformCapabilities>;
  connect(scope: Scope): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * 订阅平台事件。`onState` 用于上报事件流健康（open/closed）：
   * 断流时**不能假装还在正常直播**——冷场、互动补位都要据此停下（第 6.2 节第 3 条）。
   */
  subscribe(
    scope: Scope,
    listener: (event: RawPlatformEvent) => void,
    onState?: (state: "open" | "closed", detail: string | null) => void,
  ): Promise<Unsubscribe>;
  getCatalog(scope: Scope): Promise<Catalog>;
  getCurrentProduct(scope: Scope): Promise<CurrentProduct | null>;
  sendReply(action: Action, signal?: AbortSignal): Promise<Receipt>;
  ensureProductVisible(action: Action, signal?: AbortSignal): Promise<Receipt>;
  reconcileAction(action: Action, signal?: AbortSignal): Promise<Receipt>;
  /**
   * 以下能力（U01/U09/U10/U11/U13）**允许不存在**：
   * 只有 `capabilities()` 里对应 key 是 verified 时才可能被调用。
   * 缺失时必须由派发层明确报「平台能力缺失」，不能假成功——
   * 所以这里用可选方法 + 统一的能力检查，而不是给每个适配器补一个空实现。
   */
  blockUser?(action: Action, signal?: AbortSignal): Promise<Receipt>;
  unblockUser?(action: Action, signal?: AbortSignal): Promise<Receipt>;
  /** 私信：建会话（返回 conversationId 由派发层写入动作）+ 发消息 + 收消息订阅。 */
  openPrivateConversation?(input: { scope: Scope; userId: string }, signal?: AbortSignal): Promise<{ conversationId: string }>;
  sendPrivateMessage?(action: Action, signal?: AbortSignal): Promise<Receipt>;
  subscribePrivateMessages?(scope: Scope, listener: (message: PrivateMessageEvent) => void): Promise<Unsubscribe>;
  /** SKU 级库存快照；平台只给商品级可售时不要实现它（宁可标 missing）。 */
  getSkuStockSnapshot?(scope: Scope): Promise<SkuStockSnapshot[]>;
  /**
   * 平台自报的直播状态，只用于"直播已经结束 ⇒ 暂停场次"。
   * 平台不给或拿不到时**必须返回 null**（＝不知道），绝不能把"没数据"冒充成"没在播"。
   */
  liveState?(signal?: AbortSignal): Promise<PlatformLiveState | null>;
}

export interface PlatformLiveState {
  live: boolean;
  /** 平台侧房间标识（内部号）；与本场对不上只记日志，不在这里拒绝。 */
  roomId: string | null;
  observedAt: string;
  source: "bridge_health";
}

/** 平台侧私信事件（N07）：只保留路由与内容所需字段。 */
export type PrivateMessageEvent = {
  conversationId: string;
  userId: string;
  direction: "inbound" | "outbound";
  text: string;
  occurredAt: string;
  messageId: string;
};

/** SKU 级库存快照一条（N08）：缺货 ≠ 下架，未知保持未知。 */
export type SkuStockSnapshot = {
  productId: string;
  skuId: string | null;
  /** 有货/缺货/未知；没有明确来源时必须是 unknown */
  stockState: "in_stock" | "out_of_stock" | "unknown";
  /** 上架状态另存：不可购买不等于库存为 0 */
  listingState: "on_shelf" | "off_shelf" | "pending" | "unknown";
  observedAt: string;
  /** 数据来源版本/批次，用于去重与新鲜度判断 */
  sourceVersion: string | null;
  title: string | null;
  spec: string | null;
};

export interface KnowledgeProvider {
  retrieve(input: Scope & {
    query: string;
    productId: string | null;
    skuId: string | null;
    intent: string;
    deadlineAt: string;
  }): Promise<KnowledgeHit[]>;
}

export interface JudgmentProvider {
  readonly name: string;
  judge(
    input: {
      scope: Scope;
      contextVersion: number;
      recentEvents: LiveEvent[];
      confirmedReplies: Action[];
      candidates: CatalogItem[];
    },
    signal: AbortSignal,
  ): Promise<Judgment>;
}

export interface WordingProvider {
  readonly name: string;
  /** Only rewrites already-verified facts. Must never add price, gift or stock claims. */
  reword(input: {
    draft: string;
    facts: Record<string, string>;
    persona: Persona | null;
    deadlineAt: string;
    /**
     * 最近已经用过的说法：让模型别再说一模一样的话。
     * 需求要求"用词要有变化且口语化"，而光提示"要多样"没用——必须把上一次的输出给它看。
     */
    avoid?: string[];
  }): Promise<{ text: string; actualModel: string }>;
}

export interface AsrProvider {
  readonly name: string;
  status(): { enabled: boolean; status: string; detail: string | null; lastFinalAt?: string | null };
  subscribe(listener: (event: RawPlatformEvent & { source: "asr"; final: boolean }) => void): Unsubscribe;
}

export type ReconcileResult = Receipt;
