# 缓存活跃池生产部署报告 — 2026-09-17

## 结果

- 状态：部署成功；即时、90 秒延迟和独立只读门禁全部通过。
- Release：`20260917-092017-cbdee55-cache-pool`
- 固定源：`cbdee55f1b78fdc41a69bfa9773ff73798b63057`
- 新 exact image ID：`sha256:b0833b3491f4c7dbfa2c7e83ed5ebdebc84d7f97280960e53cbd475a65e852d2`
- 切换前 exact image ID：`sha256:af7dc2e2ac40edf5b4939e0449e84a4ef077ce8d8a133024252c2333145a1fcd`
- 切换和预备回滚均使用 `docker compose -f compose.yml up -d --no-build`；未在切换或回滚路径重新构建镜像。
- 首次失败 release `20260917-084457-cbdee55-cache-pool`、镜像、证据、日志和备份均保留。

## 固定源与候选镜像

- committed-source 独立导出测试：146/146 通过。
- allowlisted archive SHA-256：`cf11f46027c8ef87d44f166bf5d526b220e9c25508781b26a436ae5457b2ac65`。
- 候选 Compose 位于最终根目录下，语义仅改变 image 与 build context。
- 仅通过 `docker compose -f <candidate> build` 构建候选。
- Compose 构建、禁网复制数据迁移预演和正式运行使用同一 exact image ID。
- 迁移预演唯一配置差异为新增 `accountPipeline.cachePoolSize=0`；预测哈希 `c8f4f8c347538dd699da229d6a91da4717bab8254d7fe912e89912fddd504615`，正式首次启动精确匹配。
- 两次安全的非生产重试已记录：首次 T0 投影取错统计 JSON 层级，只读修正后重新冻结；首次远程安装包装命令因本机旧 Bash 不支持 `readarray` 而在远程脚本执行前退出，随后改用兼容解析。两次均未触发 release 创建、备份、Compose/config/deployment 变更或容器切换。

## T0 与账号选择

- T0：`2026-09-17T09:23:34.781000Z`
- 最近 24 小时：2,405 请求；2,379 个明确 cache 样本；1,509 命中。
- 缓存请求命中率：63.4300%。
- 缓存 Token 占比：85.9063%。
- 最终错误：12；失败率 0.4990%。
- 普通请求日志 P95：26,318.7 ms。
- overflow / capacityFallback / switched：0 / 0 / 0。
- 写入前最新选择：`account#eb683cec24` 与 `account#ad131bd944`，均为 fresh/hot、available、样本数超过 100；按 `cacheHitRequestRate*100-maxPercentUsed` 排名前二。

## 配置事务

仅执行一次 `POST /api/accounts`。相对切换前配置的完整语义差异只有：

- 新增 `accountPipeline.cachePoolSize: 2`；
- `concurrencyWaitMs: 2000 -> 5000`；
- `account#eb683cec24` priority `100 -> 1`；
- `account#ad131bd944` priority `100 -> 2`。

账号数、稳定 ID、启用状态、名称、Key、代理、Header、账号/全局模型路由及其余字段均未发生语义变化。最终配置 SHA-256 为 `808ac0a541d99efdb79b23dd38ca72f1d49b7706072c8850cd3b82a66ddba1fe`。

安全投影确认：

- active：`account#eb683cec24`、`account#ad131bd944`；
- 其余 5 个启用账号为 standby；
- 2 个禁用账号角色为 null。

## 门禁

- 容器 running / healthy，restart=0，OOM=false，exact image ID 匹配。
- 源码关键哈希、Compose、配置与 deployment 记录匹配。
- `/api/meta`、认证 models/accounts/statistics/request-log/detailed-settings 均为 200。
- 非法 quota-refresh 在工作前返回 400。
- `new-api` 内部 `ai-internal` 别名解析及 `/api/meta` 通过；未修改 NewAPI。
- 控制台 cache-pool 标记通过；启动后有界日志无 fatal/config/metadata/persistence 指示。
- 公开域名在切换前由本机、生产主机和独立解析器共同复现无 DNS A 记录，继续标记为 `dns_unavailable_preexisting`。
- 安全证据投影中已知 secret 精确命中数为 0。

## 观察窗口

- 策略激活 T：`2026-09-17T09:36:42.243000Z`
- 自然预热：`[2026-09-17T09:36:42.243000Z, 2026-09-17T11:36:42.243000Z)`
- 正式 24 小时窗口：`[2026-09-17T11:36:42.243000Z, 2026-09-18T11:36:42.243000Z)`
- T+26h 只读复核目标：`2026-09-18T11:36:42.243000Z`

当前尚不能声明缓存请求命中率达到 70%；必须等正式窗口结束且至少获得 1,000 个明确 cache 样本。

主会话已创建项目级一次性只读复核：

- schedule ID：`2e971ea9`
- 名称：`cline-pass-cache-pool-26h-verification`
- 触发时间：`2026-09-18T11:36:42.243Z`
- agent：`trellis-research`
- 生产权限：严格只读；不得 POST/DELETE、改配置/容器或自动回滚
- 输出：本任务 `research/validation-20260918.{json,md}` 及调度 agent 报告

首次 schedule.create 因不支持并发覆盖参数在静态参数校验阶段被拒绝，未创建计划或子运行；移除该参数后按同一调度协议成功创建上述 schedule，生产不受影响。

## 回滚与证据

- 旧 exact image ID 与旧 tag 仍存在并精确对应。
- 原始 compose、deployment、config、metadata 已在远端 0700/0600 私有备份中保留。
- 回滚路径为恢复原始 config/compose/deployment 后执行 `up -d --no-build`，并要求 exact old image ID 和健康门禁；禁止重新 build。
- 远端证据：`/opt/cline-pass-switcher/verification/deploy-20260917-092017-cbdee55-cache-pool/`
- 本地脱敏证据：`.trellis/tasks/09-17-deploy-cache-pool-validation/research/deployment-20260917-092017-cbdee55-cache-pool/`

## 残余风险

- NewAPI 仍未提供显式稳定会话键，当前流量继续依赖 `message_hmac` 回退。
- 公开 DNS 仍不可用，属于切换前既有外部依赖故障。
- 70% 主指标与全部 24 小时护栏尚待 T+26h 只读复核；失败时只报告并等待用户决定，不自动修改生产配置。
