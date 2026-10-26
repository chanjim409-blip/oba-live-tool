# 2026-10-26 共用私有资料目录

- 按用户要求，Windows 默认系统私有根目录为 `D:/live-assistant/private`，可用 `LIVE_ASSISTANT_PRIVATE_DIR` 覆盖。
- 登录脚本默认输出到其 login 子目录；观察脚本默认输出到 observe；独立桥接与 Electron 桥接的数据库默认使用 bridge-data。显式 `--out` / `--profile` / `LIVE_ASSISTANT_BRIDGE_DATA` 保持优先，登录态仍须按账号显式指定。
- 两套已有登录环境保持隔离，不把目录名称当身份证据。旧目录为兼容 Junction，原件备份也在系统目录。
- TypeScript 检查及两个 MJS 语法检查通过；未启动浏览器或宿主、未采集或发言。共享路径不代表真实账号/权限已验证。
- 原有 dev-observer.mjs 的采集增量及两个未跟踪探查脚本保留；本次仅提交观察脚本的目录默认值改动，不纳入其他任务的工作。
- 业务侧说明：live-assistant-lite 的 docs/SHARED_LOCAL_DATA.md；两边统一读取系统根的 shared-paths.json。不要向上游原项目推送本机集成分支。
