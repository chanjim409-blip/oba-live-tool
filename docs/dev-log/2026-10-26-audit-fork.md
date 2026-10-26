# 宿主复审与用户分叉保存

- 基线 `34fea24`，原维护分支 `harness/live-assistant-bridge`。保留上游许可及本机历史，不推原作者origin。
- 修复 `BackgroundReplySource` 在最后一次异步身份读取期间释放/切换场次仍可能提交的问题。读取前后复核完整场次、停止和取消状态。新增回归在基线失败，修复后通过。
- 同步业务仓账号核验面字段和直播状态类型；新增 `scripts/check-bridge-vendor.mjs`，4个协议副本主体一致。允许差异仅为宿主导入/SQLite适配与说明注释。
- 新增 `npm run test:bridge`；将现用package-lock纳入维护分支，重复安装用 `npm ci --legacy-peer-deps`。没有升级依赖；锁定不等于解决安全告警。
- 验证：桥接17/17（包括合成DOM）、全仓类型检查通过。未执行上游全量Electron端到端/安装包验收、真实登录或发送。
- `npm audit` 全树14个受影响包（13 high、1 critical），生产口径2 high（更新器及builder-util-runtime）。已确认版本命中，未验证当前场景可利用性；应安排依赖升级与兼容回归，不直接更换运行中宿主。
- 原维护历史曾有真实房间标识，HEAD中已移除。用户授权自己的fork，采用固定上游 `bd47368040d4a2b51ef96640c2d9e58c80f24e14` 为父提交、当前审查后树为内容，创建 `codex/live-assistant-bridge` 干净快照分支。原始分支不改写、不删除、不上传；未来公开维护以干净分支为基础。
- 剩余：后台浏览器提交固定返回uncertain/click_only并停止通道；尚无真实对账及原生@。不把接口成功或合成DOM测试称为平台验收。
- 本次未部署、重启或执行直播动作。
