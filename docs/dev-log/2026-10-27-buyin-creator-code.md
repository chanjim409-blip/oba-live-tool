# 百应达人公屏发送适配

- 新增 BuyinReplyDriver，使用采集器拥有的 headless 百应中控页面，不附着用户 Chrome、不抢焦点，不提供新的绕过授权或风控路线。
- 当前身份来自已观察的 getUser 响应；房间由已观察的 playinfo URL 重新核对。配置 creatorRoleEvidence 必须依据真实响应已核实的角色字段映射，无默认映射；缺失或类型/值不符拒绝。页面昵称、“达人”展示标签、人工确认均不能冒充该字段。
- 发送前读取最新身份/房间，检查页面、角色、可编辑控件；填字后再次复核，最终 DOM 检查文本/控件/验证码并只点击一次。回执始终 uncertain/click_only，随后停发，不把点击当送达。
- 复用 BackgroundReplySource 与持久化 HostIdentityBoundary；两个发送路径各有独立开关，不能因启用百应而顺带打开旧公屏路径。原生 @ 未实现仍拒绝，不降为普通文字。
- 启动新增私有 LIVE_ASSISTANT_BUYIN_REPLY_CONFIG，明确启用还需 LIVE_ASSISTANT_BUYIN_REPLY_ENABLED=1。配置包含 expectedOwnerId、expectedExecutorId、inputSelector、submitSelector，及待真实核实的 creatorRoleEvidence（path/value）。不得把合成测试字段复制到真实配置。
- 已认证 GET /buyin-reply/preflight 只读核对角色/账号匹配、房间和控件；仍有平台只读请求，不是缓存接口。健康页单列百应配置和开关状态。所有能力仍未实场验收。
- 验证：28/28 宿主测试，含独立无头浏览器内全部请求本地截获的合成页面点击测试；不是抖音平台测试。类型检查及 vendor 4/4 一致检查通过。
- 未启动新生产宿主、未接触实际页面发送、未修改登录缓存或 NAS。后续先核实角色字段、输入框和按钮选择器及宿主本人登录，再由用户确认单次测试文本。
