# live-assistant宿主集成状态

> **2026-10-27 接力提醒**：真实百应弹幕与货盘只读链路已有现场观察；达人身份角色含义、后台发言、原生 @、商品动作及平台回执仍未实场验收。旧助理待核查标记已迁移为持久停刷，原因与影响范围尚不明确；人工查看窗口曾打开失败。现网版本和场次状态必须现场只读核对，不能依据下方历史记录自动恢复或绕过限制。详见 [人工查看失败诊断](dev-log/2026-10-27-manual-inspection-diagnostics.md) 和 [停刷与身份代次](dev-log/2026-10-27-persistent-stop.md)。

## 当前入口（2026-10-26复审）

本机原维护分支 `harness/live-assistant-bridge`；用户fork `chanjim409-blip/oba-live-tool` 的干净发布分支 `codex/live-assistant-bridge`。不推原作者origin，不上传包含旧私有标识的本机历史。详见 [复审记录](dev-log/2026-10-26-audit-fork.md)。

当前已有真实只读采集桥接及专用后台浏览器单次回复入口；后者核对当前助理/房间/场次，点击后返回uncertain/click_only，停止后续发送。尚无可靠平台送达核对和原生@，不等于已完成正式自动回复。

正式回复须经完整业务链路，遵守根目录AGENTS的后台、不抢焦点、权限与风控要求。本轮未启动、部署或操作平台；运行状态需现场核对。

维护验证：`npm run test:bridge`、`npx tsc --noEmit`、`node scripts/check-bridge-vendor.mjs <业务仓目录>`。已提交当前依赖锁，安装用 `npm ci --legacy-peer-deps`；依赖告警待专项升级，不能把锁定视为安全修复。

## 以下为最初接入记录（历史，不代表当前实现/配置）

## 1. 基线与许可

| 项目 | 值 |
|---|---|
| 上游仓库 | <https://github.com/qiutongxue/oba-live-tool> |
| 固定提交 | `bd47368040d4a2b51ef96640c2d9e58c80f24e14`（v1.6.3，`chore: update providers models [automated]`） |
| 本机维护目录 | `D:\Codex\oba-live-tool`（**独立于业务仓**，不塞进业务仓、不复制整仓进业务分支） |
| 维护分支 | `harness/live-assistant-bridge`（从固定提交拉出，不改上游 `main`） |
| 许可 | MIT（`LICENSE`：Copyright (c) 2025 qiutongxue，并保留 electron-vite-react by 草鞋没号 的原版权声明）。本分支新增文件沿用 MIT；上游版权声明未改动 |
| 技术栈事实 | Electron ^36（实测安装 36.9.5）+ Playwright 驱动本机 Chrome；中控台操作全部是页面 DOM 自动化，不是平台私有接口 |

> 交接文档里另出现过 `bd47368040d4a2b51ef96640c2d9e58c80f24a14`，该对象在上游**不存在**；以本表这个提交为准。

## 2. 为什么是"独立目录 + 独立分支"

- 业务仓只保留协议、客户端和边界模块（`src/platform/hostIdentity.ts`、`hostIdentityHttp.ts`、
  `contracts/accountGovernance.ts`），不复制上游整仓、不引入 Electron 依赖。
- 宿主需要 Playwright/Electron 这些重依赖，且将来要跟着上游升级；放在业务仓里会让"发布 SHA"变得不可解释。
- 两端通过 HTTP + 私有 Bearer token 通信，业务侧配置 `OBA_BRIDGE_URL` / `OBA_BRIDGE_TOKEN` 即可指向宿主。

## 3. 本分支新增/修改的文件

| 文件 | 性质 | 说明 |
|---|---|---|
| `electron/main/bridge/vendor/contracts.ts` | vendor | 业务仓 `contracts/index.ts` 原样复制（纯类型，无运行时依赖） |
| `electron/main/bridge/vendor/accountGovernance.ts` | vendor | 业务仓 `contracts/accountGovernance.ts`（zod 严格结构：身份观察/绑定） |
| `electron/main/bridge/vendor/hostIdentity.ts` | vendor | 业务仓 `src/platform/hostIdentity.ts`（身份边界状态机：观察/执行/只读对账、幂等、期限、队列） |
| `electron/main/bridge/vendor/hostIdentityHttp.ts` | vendor | 业务仓 `src/platform/hostIdentityHttp.ts`（Bearer/Origin/体积/超时/取消） |
| `electron/main/bridge/sqliteDb.ts` | 新增 | 把业务仓 `Db` 的三处用法（`database.exec`、`prepare().all/get/run`）适配到 `node:sqlite`；库文件放 Electron `userData/host-identity.sqlite` |
| `electron/main/bridge/identitySource.ts` | 新增 | **真实宿主身份源**：把 surface 钉到具体账号的具体 Page，读登录态/显示名，围出 `read/execute/reconcile` 上下文 |
| `electron/main/bridge/index.ts` | 新增 | 只监听回环地址的 HTTP 服务 + 装配边界 + `executionEnabled=false` |
| `electron/main/app.ts` | 修改 | 启动时若配置了 `LIVE_ASSISTANT_BRIDGE_TOKEN` 才启动桥接；`will-quit` 时关闭 |
| `electron/main/services/AccountSession.ts` | 修改 | 新增只读 `getPlatform()`，让身份读取方能拿到**该账号钉住的那张页面** |
| `package.json` | 修改 | 新增依赖 `zod`（vendor 的边界模块用与业务侧相同的 4.6.7 校验器） |

vendor 文件只改了三处相对导入路径（业务仓用 `nodenext` + `.js` 后缀，宿主 `tsconfig` 是
`moduleResolution: "Node"`，所以去掉 `.js`）。**没有改任何逻辑**；业务仓修协议时重新复制即可，
不要在宿主里单独改。

新增依赖的取舍：`npm i zod@4.6.7` 会因 `openai@5.8.2` 的 `peerOptional zod@^3.23.8` 报 ERESOLVE，
因此用 `--legacy-peer-deps` 安装。该 peer 是可选的、本项目没有使用 openai 的 zod 辅助功能；
替代方案是把 vendor 的校验器改写成 zod 3 语法，那会让 vendor 文件偏离业务仓，反而更难维护。

## 4. 已经能做到什么（逐项，含证据等级）

| 能力 | 状态 | 证据 |
|---|---|---|
| 边界模块挂进宿主、编译通过 | **离线通过** | `npx tsc -p tsconfig.json --noEmit` 退出 0（真实上游 tsconfig + 全仓类型） |
| 只监听 `127.0.0.1`、私有 Bearer token（≥32 字符）、默认拒绝带 Origin 的请求、16 KiB 体积上限、5 s 超时、断连取消 | **离线通过** | 逻辑来自 vendor 的 `createHostIdentityHandler`（业务仓已有 27 项治理回归）；宿主侧不额外开监听、不打印 token |
| 把 surface 钉到具体账号的具体页面；`framenavigated`/`close` 立即让上下文失效；同一 surface 串行 | **代码完成，未在真实页面验证** | `identitySource.ts`：`withContext` + `snapshot` |
| 读登录态（以页面 URL 是否停在登录页 + 页面内账号/头像类节点为准） | **代码完成，未在真实页面验证** | 选择器是通用写法，需要在真实中控台上确认 |
| 读账号显示名 | **代码完成（弱身份）** | 按约定只作弱关联，不当稳定 ID |
| 稳定达人 ID / 房间 ID / 实际执行者 ID / 角色与权限 | **未实现 → 一律拒绝** | `stableIdentity` 默认为 `null`，`read()` 抛 `host_identity_unprovable`，边界因此拒绝所有观察与执行 |
| 真实发送 / 弹卡 / 拉黑 | **未实现，且恒关闭** | `executionEnabled: false`；`ctx.execute` 直接抛 `host_execution_disabled` |
| 只读对账 `reconcile` | **未实现** | 故意不提供：没有可信对账来源时，业务侧保持 `uncertain`，不会被"猜"成确认 |
| 事件流（`/events` SSE）、货盘（`/catalog`）、`/current-product`、`/reply`、`/product/show` | **未实现** | 其它路径统一 404 `host_route_not_implemented`，不假装成功 |

**结论：这一版把"身份边界"真正挂进了真实宿主，但身份证据不足，所以它现在会拒绝一切动作。**
这是交接文档要求的失败方向（"未知即拒绝，不回显请求参数，不从昵称或百应角色推造权限"），
不是缺陷掩盖。业务侧因此不可能因为"宿主接上了"就误以为平台能力已验证。

## 5. 启动方式（需要用户配合的部分）

宿主侧环境变量（**不要写进仓库**；token 与业务侧 `OBA_BRIDGE_TOKEN` 必须一致）：

```powershell
$env:LIVE_ASSISTANT_BRIDGE_TOKEN   = '<32 字符以上的随机串，与业务侧 OBA_BRIDGE_TOKEN 相同>'
$env:LIVE_ASSISTANT_BRIDGE_PORT    = '9310'          # 默认 9310
$env:LIVE_ASSISTANT_DOUYIN_ACCOUNT = '<宿主里抖音助理账号的 account id>'
$env:LIVE_ASSISTANT_BUYIN_ACCOUNT  = '<宿主里百应子账号的 account id>'
# 可选：$env:LIVE_ASSISTANT_BRIDGE_ORIGINS = 'http://127.0.0.1:8787'
```

业务侧对应配置：`PLATFORM_ADAPTER=oba`、`OBA_BRIDGE_URL=http://127.0.0.1:9310`、`OBA_BRIDGE_TOKEN=<同一个 token>`。
**本次部署没有打开它**（首场仍是 `PLATFORM_ADAPTER=mock`、执行关闭）。

启动宿主后，业务侧可先做只读验证：`GET /identity?...` 期望得到 `401`（不带 token 时）或
`host_identity_unprovable` 类拒绝码——拿到"能返回合法身份观察"之前，不能进行任何真实动作。

## 6. 下一步（按依赖顺序，都需要真实登录页面）

1. **在宿主里登录**抖音助理中控台与百应子账号（扫码由用户完成；本仓库不保存登录缓存）。
2. 用真实页面确认四项证据来源：稳定达人 ID、直播间 ID、实际执行者 ID、角色/权限。
   优先找页面自身发起的、带签名的接口响应里的稳定字段；**不要**用显示名或右上角达人昵称推导。
3. 实现 `identitySource.ts` 的 `stableIdentity`（第四个参数），使 `read()` 能返回 `platform` 证据；
   在此之前不要打开 `executionEnabled`。
4. 再实现 `/events`（SSE）、`/catalog`、`/current-product` 与事件时间映射；`/reply`、`/product/show`
   必须复用同一身份边界，旧动作路由不得绕过。
5. 逐项更新业务侧能力表：`离线通过 / 真宿主只读通过 / 真实动作通过 / 未验证`，不允许笼统写"已完成"。

## 7. 本文件对应的事实边界

- 本分支**未**在打包形态下启动过（`npm run build` 需要 electron-builder 打包，本轮没有做）；
  Electron 36.9.5 的二进制已随依赖落盘，Playwright 的浏览器未单独安装（宿主用的是本机 Chrome，
  见 `electron/main/utils/checkChrome.ts`）。
- 没有真实登录、没有打开中控台、没有任何平台动作；本文件里的"完成"只指代码与类型检查层级。
