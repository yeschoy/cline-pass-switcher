# 统计、日志与错误规则版本生产发布设计

## 1. 固定边界

- 源提交：`b2d676d11e0d4422aef83854670b6bceb89401a0`
- 生产：`ubuntu@167.114.158.4:49555`
- 根目录/Compose：`/opt/cline-pass-switcher`、`/opt/cline-pass-switcher/compose.yml`
- 服务/容器：`cline-pass-console`
- 运行身份与 hardening：保持现有 Compose 的 `1000:1000`、read-only root、cap drop、no-new-privileges、tmpfs 和网络设置。
- 发布名：执行时 UTC 时间 + `b2d676d-stats-logs-rules`；release、image tag、candidate Compose 和 verification 路径必须唯一且不存在。

生产 archive 只含 `Dockerfile`、package manifests、`server.js`、`lib/`、`public/`、`README.md`、`LICENSE`、`.dockerignore`、`config.example.json`。`test/` 只进入独立本地门禁，不上传生产。

## 2. Committed-source 门禁

从固定提交解包到独立临时目录：

1. `node --check server.js` 和所有 `lib/*.js`；
2. 编译 `public/index.html` 的内联脚本；
3. 清除生产环境变量后 `npm ci` + `npm test`；
4. `git diff --check <source>^ <source>` 及 archive 成员 allowlist；
5. 记录 archive、`server.js`、`public/index.html`、`lib/jsonl-log-store.js`、`lib/detailed-log-capture.js`、`lib/detailed-log-store.js` 的 SHA-256。

SSH identity 只检查固定路径、普通文件、0600 和 gitignored，不读取或输出内容。

## 3. 只读生产预检

2026-09-19 规划预检确认：当前 release 为 `20260918-070946-2e7dc37-empty-content-r3`，源 commit `2e7dc37355fe9385a44d7de7c2da5015fd391f82`，exact image 为 `sha256:a5ffbbc7a1185e69bf3d9e6767d80ff86bb20762dce456d90833d6179e0f1d7d`；容器 running/healthy、restart=0、OOM=false，回滚 image 可用，磁盘余量约 424 GB。当前配置是 10 个账号、sticky、`cachePoolSize=5`、wait 2000、5 条状态规则且无内容规则字段；statistics v1 有 776 个分钟桶；普通日志 2 个文件、5,285,403 bytes。内部别名可达，公开域名仍无 DNS。执行写入前必须再冻结一次并以最新值为准。

非交互 SSH 内只输出安全投影：

- 当前 compose/deployment release、tag、exact image ID；
- 容器 running/health/restart/OOM/start time；
- 主机磁盘、Docker 可用性与 Compose 版本；
- compose/deployment/config/metadata 哈希，普通日志文件数/总字节；
- local `/api/meta`、认证管理 API 的状态码/安全 schema 枚举；
- `ai-internal` 内部别名和公开 DNS/HTTP。

admin key 只在远端进程内从 config 读取并用于 loopback 请求，绝不进入命令行、stdout 或证据。

若当前生产 exact image、健康、空间、身份、helper runtime、配置解析或回滚 image 不满足要求，则在任何写入前停止。

## 4. 不可变候选与复制数据预演

1. 本地生成 allowlisted tar，上传唯一临时路径并双端核对 SHA-256。
2. 解包到新 release，强制目录 0755、普通文件 0644，验证成员和关键源码哈希。
3. 在生产根目录生成 candidate Compose，仅替换 image tag 与 `build.context`，以最终路径执行 `docker compose -f <candidate> build`。
4. 捕获 exact image ID；后续禁止再次 build。
5. 创建 0700 私有 rehearsal/backup 路径，复制 config、metadata 和普通 `data/logs`，文件保持 0600/不可公开读取。
6. 用 exact image、复制数据、生产 UID/GID 和 hardening 在隔离网络启动：
   - 要求进程快速进入监听；
   - 允许普通日志 API 在恢复期间返回明确 503；
   - 要求在有界时间内 readiness 完成并能查询历史；
   - 要求模型流量入口可接受本地无上游副作用的验证请求形态，但不发送真实模型请求。
7. 对副本做安全结构 diff：
   - config 只允许缺失时新增 `accountContentErrorRules: []`；当前 `cachePoolSize=5`、sticky、wait 2000、账号、5 条状态规则与所有其他字段保持相等；
   - statistics v1 只允许迁移到 v2，保留全局/账号事实并新增 model map/coverage 字段；已是 v2 时不得重置；
   - 普通日志保持 JSONL 可查询与 request/error 独立，不要求字节不变，但任何 retention 删除必须符合年龄/条数/字节边界并单独报告。
8. 记录预测 config 完整 SHA-256、metadata schema 投影和日志恢复证据。

任何额外语义变化、启动/恢复失败、敏感投影或容量 fence 触发都停止，不切换 live 服务。

## 5. 备份、切换和回滚

切换前再次冻结 live config/metadata/logs 哈希，检测预检以来的合法动态变化；以最新数据重新做必要的 config 预测。保存：

- 原始 `compose.yml`、`deployment.json`；
- live `config.json`、`metadata.json`；
- `data/logs` 目录副本或不可变归档及 manifest；
- 候选 compose、source/archive/image/rehearsal 报告；
- 旧 tag 和 exact image ID。

原子安装候选 Compose，执行一次 `docker compose -f compose.yml up -d --no-build`。有界等待后要求：

- exact image ID 等于 candidate；
- running/healthy、restart=0、OOM=false；
- config hash 等于副本预测值；
- bounded logs 无 fatal/config/metadata/persistence；
- `/api/meta` 在普通日志恢复期间也能响应，日志 API 最终 ready。

失败且 live 文件仍匹配本次写入预期时，原子恢复备份的 config/metadata/logs、compose/deployment，使用旧 exact image 的 `up -d --no-build` 回滚并重新跑健康/API 门禁。若发现未知外部漂移，不自动覆盖，停止并报告。

## 6. 发布后门禁

通过远端本机安全检查：

- `/api/meta`；
- 认证 `/api/accounts`、`/api/models`、`/api/statistics`；
- request/error logs 与 detailed settings；
- 非法 quota-refresh 在工作前返回 400；
- `accountContentErrorRules` 可投影且不改变已有 status/content 配置；
- statistics model projection、账号 stable-ID summary 和 UI 新功能标记存在；
- `new-api` 容器内 `ai-internal` 别名可达，不修改 NewAPI；
- 公开 endpoint 按切换前 DNS 状态判定；
- 90 秒后重复 exact image/health/restart/config/API/log readiness 门禁。

全部通过后原子更新 `deployment.json`，写入 release、commit、source hashes、previous release、safe gate facts 和 rollback references，不含秘密。

## 7. 与缓存池观察任务的关系

原部署任务记录的是 size=2/wait=5000，但规划预检已观察到后续生产状态为 size=5/wait=2000 和新的 release，说明原连续窗口早已被后续变更打断。本次不再调整 cache-pool 配置，但容器重启和日志/统计版本迁移会形成另一运行边界。向 `09-17-deploy-cache-pool-validation` 追加只读说明：

- 本次切换时间和 source release；
- 原始观察窗口已被后续版本/配置变更打断，不能据此宣称连续 24 小时结论；
- 若未来重新验证，应从稳定性门禁后定义新窗口；
- 不删除或改写旧基线/报告。

## 8. 证据和清理

本任务只保存脱敏 JSON/Markdown、哈希、状态和计数。生产 release、镜像、logs、backup、build cache、旧证据不清理。本地临时 tar/独立测试目录属于非业务中间产物，任务结束后须先征得用户同意才删除；Trellis/部署证据不清理。
