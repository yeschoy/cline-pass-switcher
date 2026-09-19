# 缓存活跃池生产部署尝试 — 2026-09-17

## 结果

- **状态：已在账号配置前自动回滚，策略未激活。**
- 固定源：`cbdee55f1b78fdc41a69bfa9773ff73798b63057`
- 尝试 release：`20260917-084457-cbdee55-cache-pool`
- archive SHA-256：`cf11f46027c8ef87d44f166bf5d526b220e9c25508781b26a436ae5457b2ac65`
- 远端证据：`/opt/cline-pass-switcher/verification/deploy-20260917-084457-cbdee55-cache-pool`
- 未修改 NewAPI/CPA 配置，未执行账号配置 POST，未更新 `deployment.json`，未创建 T+26h 复核。

## 部署前门禁

- 固定提交 allowlist、关键源码哈希、SSH identity 和语法检查通过。
- 首次完整测试为 144/146；两个时序/边界用例各自连续复跑 3 次通过，随后完整套件 **146/146** 通过。该重试已记录，未在首次失败后进入生产写入。
- 最终 T0：`2026-09-17T08:44:00.707000Z`。
- T0 最近 24h：2,275 请求、2,245 个明确 cache 样本、1,376 个命中，请求命中率 61.2918%，缓存 Token 占比 85.9926%，14 个最终错误，P95 26,706.25 ms；overflow/capacityFallback/switched 均为 0。
- 公开入口在本机、生产主机和独立解析器均无 DNS 答案，继续按切换前既有依赖故障处理。
- 写入前选中候选：
  - `account#eb683cec24`：fresh/hot、额度 16%、health 99.9041、416 样本、命中 66.3462%、score 50.3462。
  - `account#ad131bd944`：fresh/hot、额度 14%、health 99.8281、348 样本、命中 63.5057%、score 49.5057。

## 候选安装与迁移预演

- release 与验证目录唯一，上传 archive 哈希、成员和关键源码哈希一致。
- 禁网复制数据预演唯一配置差异为新增 `accountPipeline.cachePoolSize=0`。
- 原配置哈希：`698b889a12b2ef6463a57d78b20ac2dc266799c75f47035dd4f2040bb51d6354`。
- 预测迁移哈希：`c8f4f8c347538dd699da229d6a91da4717bab8254d7fe912e89912fddd504615`。
- 预演后原子重命名使副本变为 root:0600，主机验证器首次无法读取；只修正私有副本所有权后验证通过，live 状态未变化。

## 失败门禁与回滚

Compose 候选已证明只改变：

- `services.cline-pass-console.image`
- `services.cline-pass-console.build.context`

但 `docker compose up -d --build` 通过 Compose 构建路径生成的镜像 ID 为 `sha256:e53c…d39d`，与复制数据预演使用的直接构建镜像 `sha256:f20f…fc4ca` 不同。镜像一致性硬门禁因此失败，发生在：

- 账号选择重算之前；
- 唯一账号配置 POST 之前（POST 次数 0）；
- 正式策略激活时间 T 之前；
- API/内部/公开和 90 秒延迟新版本门禁之前。

自动回滚于 `2026-09-17T08:57:46.878787Z` 完成。独立只读复核确认：

- compose/config/deployment 哈希精确恢复为切换前值；
- live 调度仍为 sticky、wait 2000、无 `cachePoolSize`、所有 priority 仍为 100；
- 旧 release tag 正在运行，healthy、restart=0、OOM=false；
- meta/models/accounts/statistics/request-log/detailed-settings 与内部别名均通过；
- 旧 release 关键源码哈希通过；
- 公开 DNS 仍为切换前既有故障。

## 保留材料与残余风险

- 未 prune release、image、build cache、生产日志、备份或上传包；失败 release、候选镜像、四项备份与全部验证证据均保留。
- 回滚按旧 tag 执行 `compose up --build`。当前旧 tag 的 image ID 为 `sha256:af7d…fcd`，而切换前容器 ID 为 `sha256:5de6…ef1`；后者已不可 inspect。虽然旧 tag、旧 release 源码、原配置/compose/deployment 和全部运行门禁均通过，**不能声称精确恢复了相同 image ID**。
- 因策略从未激活，`T`、正式 24 小时窗口和 `T+26h` 复核时间均不存在；没有创建计划任务。
- 如需重试，必须使用新的 immutable release，并先通过与最终切换完全相同的 Compose build 路径构建候选，再用该精确镜像做复制数据迁移预演；本次硬门禁失败后未自动发起第二次 release。
