# 2026-09-29 合并后生产发布只读预检：未切换

## 已完成

- 用户明确要求跳过缺失的真实浏览器验收，直接合并并部署；该验收仍是**未验证**，不写成通过。
- 功能分支快进合并到 `main`，推送 `origin/main`，两者提交均为 `5fdb65205ce0796e975849d17b27d198fcc4434a`。提交后重跑 `node --check`、内联脚本 VM、完整 `npm test`：369/369 通过，工作树干净。
- 固定 SSH 身份的路径、忽略规则和 0600 权限已确认；只读生产检查显示现有容器 running/healthy、重启 0、OOM false、内存上限 512 MiB，镜像 `sha256:57c0acbe791c963a68768222694993ba0a44e9485af814a6ee161894a2679d8e`。现有发布记录仍是 `awaiting-admin-acceptance`。
- 远端私有配置与元数据**只在远端进程读取**，输出限于安全投影：`rawBodyLogging=false`、`errorDetailLogging=true`、旧配置尚无 `errorDetailMigrationVersion`、统计版本 5、尚无本任务 v3 参考价格快照，独立管理员状态文件存在。记录仅含配置 SHA-256 摘要，不复制或展示密钥、原始 JSON、详细日志及任何请求体。

## 硬性阻断

1. 新镜像启动将对旧配置写入一次性迁移标记；产生首个可计价成功请求后可持久化 v3 价格快照。旧镜像可能无法读取新元数据，**不能普通 Compose 立即回滚**。必须使用 `.trellis/spec/backend/schema-changing-deployment-guidelines.md` 的完整 stop-first v1/v2 树备份、独立恢复验证与拒绝 old-on-v2 的回滚事务。
2. 现有归档的 `09-26-production-raw-body-enablement/research/stop-first-code-cutover-checklist-20260927.md` 明确标为**非可执行方案**：缺少连续模型入口/在途请求和外部/宿主写入栅栏、独立 stop/restore 恢复负责人以及失败注入后的候选启动/回滚验证。旧备份是服务恢复写入前的过期快照，不能当本次完整 v1 回滚依据。
3. 本次只读预检未建立维护窗口、入口与所有写入者的持续栅栏，也未为当前提交构建候选镜像、完成 512 MiB 负载测试和新旧镜像的完整私有复制/恢复演练。不能以“用户要求部署”代替这些技术证据。

**决策：尚未上传/构建候选，也未停止容器、修改 Compose、操作生产 DATA_DIR 或部署。**等待运维确认可执行的维护窗口及外部写入/备份控制机制，再准备当前快照专属的安全切换和回滚演练；若无法证明栅栏及回滚，继续维持现有健康镜像。生产环境上一次最小上游调用的 HTTP 500 观察见 `one-call-upstream-observation.md`，不得误称供应商已证实变更。
