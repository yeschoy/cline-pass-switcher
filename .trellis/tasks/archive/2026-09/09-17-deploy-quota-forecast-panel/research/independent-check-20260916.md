# 独立发布核验报告 — 2026-09-16

## 结论

- **生产硬门禁：全部通过。**
- **核验方式：** 仅执行本地读取、测试及远程只读 SSH/API/Docker 查询；未构建、重启、修改 compose/config/deployment、清理或写入生产。
- **当前 release/image：** `20260916-174357-529d642f4b8e-quota-forecast`
- **源提交：** `529d642f4b8ececd0a5b2975addbd8ed74488090`
- **独立延迟复查：** `2026-09-16T18:00:11Z` 通过。
- **外部入口：** 本地与生产主机当前均无法解析 `clinepass.yeschoy.com`，与切换前记录的 `dns_unavailable_preexisting` 一致；本地及内部硬门禁不受影响。

## 1. 发布源与不可变 release

- 当前本地 `HEAD` 精确为记录的源提交，且包含功能提交 `8b727b1`。
- 重新从 committed `HEAD` 按部署白名单生成归档：
  - 大小：378,880 bytes
  - SHA-256：`21062c7b2dc96cb04b67f0cb55f5f1c283c55458fae34e88ccacded97444145b`
  - 顶层成员仅有 `Dockerfile`、package manifests、`server.js`、`lib/`、`public/`、`README.md`、`LICENSE`、`.dockerignore`、`config.example.json`。
- 本地 committed 归档与远程 release 均有 12 个文件；按“相对路径 + 文件 SHA-256”生成的清单摘要均为 `21d9ed6f02558686b5a583a347aa600d76a7d3a82a1d1de2f0157d4a600bf666`。
- 以下本地 committed 与远程安装文件哈希逐项一致：
  - `server.js`: `9151e9185c35461a21fe13257469bf05e1fc74d98c098bb7c138662711f5bfcd`
  - `public/index.html`: `98eb0305989eeb6d236ceaf776609b50c00df3b446dc8c22e282e3fe520bb442`
  - `lib/detailed-log-capture.js`: `cec4581fc4cadf198f68f55a7766b1bac9bfb5e758d8d4cae06546abd7ba13ad`
  - `lib/detailed-log-store.js`: `18c123b35f2d465c4d977d96f726b35fc23092be029bffa38bf90a34e9f56254`
  - `lib/jsonl-log-store.js`: `6471348de5fa4b43c56eb950e5903e749a939d930299fef6c3e1ae6e896861f8`
- 当前 compose 同时指向预期 image 和 `./releases/20260916-174357-529d642f4b8e-quota-forecast` context。
- `deployment.json` 包含预期 release 与完整 source commit，其当前 SHA-256 为 `d5673978fa3ae261899bf6d1a53991aaefc2c161595ec1a10c6d15602b26202e`。

## 2. 当前容器与数据不变性

| 检查 | 独立结果 |
|---|---|
| 容器状态 / 健康 | running / healthy |
| RestartCount / OOMKilled | 0 / false |
| 当前 image | `cline-pass-switcher:20260916-174357-529d642f4b8e-quota-forecast` |
| image ID | 存在且为已解析镜像 ID |
| `config.json` SHA-256 | `da99749a146bbfc266b8f9e0d024cc2db870d4da6d3221320be2f14c736dd46e` |
| 账号数 / 模式 | 9 / `sticky` |

当前配置哈希、账号数和模式均与发布前证据一致。独立延迟复查再次得到相同 image、running/healthy、0 restart、非 OOM、相同配置哈希及 9 / `sticky`。

## 3. API、内部网络与控制台门禁

| 门禁 | 独立结果 |
|---|---|
| 本地 `/api/meta` | 200，configured=true，authRequired=true |
| 认证 `/api/models` | 200 |
| 认证 `/api/statistics` | 200，9 个账号投影 |
| 认证 request-log projection | 200，JSON 结构有效 |
| 认证 detailed-log settings | 200，JSON 结构有效 |
| 认证 `/api/accounts` 安全投影 | 200，9 / `sticky` |
| 非法 quota-refresh | 400，在工作前因非法查询参数被拒绝 |
| `ai-internal` / `new-api` | `cline-pass-switcher` 可解析且 `/api/meta` 可达 |
| 控制台 HTML | 200，包含 `statisticsQuotaForecastTitle` |
| 最近 30 分钟、最多 500 行日志扫描 | 未发现 fatal/config/metadata/persistence 指示 |

第二次延迟复查重复验证了 meta、statistics、内部别名、控制台标记及有界日志扫描，结果仍全部通过。

## 4. 备份、回滚材料与记录完整性

以下远程证据继续保留于 `/opt/cline-pass-switcher/verification/deploy-20260916-174357-529d642f4b8e-quota-forecast/`：

- `install.json`
- `api-gates.json`
- `internal-network.json`
- `report.json`
- `delayed-stability.json`
- `archive.sha256`
- `source-hashes.txt`
- `build.log`
- `startup.log`
- compose 前后规范化记录及候选差异
- `backups/compose.yml`
- `backups/deployment.json`
- `backups/config.json`
- `backups/metadata.json`

证据 JSON 均可解析，并记录了：白名单及源哈希验证、仅变更 image/build.context、切换前状态与哈希、直接全量切换、无 canary、容器/API/内部网络/控制台/config 门禁、回滚就绪和延迟稳定性。

上一 release 目录 `20260916-050450-b1f2170ef4a8` 与对应镜像均仍保留。

## 5. 敏感信息检查

- 在 `deployment.json`、`install.json`、`api-gates.json`、`internal-network.json`、`report.json`、`delayed-stability.json` 中，使用生产配置内已知敏感值进行远端内存内精确匹配：0 个命中文件。
- 上述记录的 Bearer 凭据、带认证信息 URL 及私钥头通用模式扫描：0 个命中文件。
- 本地发布报告的私钥、Bearer 凭据、Authorization 值及带认证信息 URL 模式扫描：均为 0。
- SSH 身份文件仅验证了固定路径、普通文件、`0600`、gitignore 与非交互认证；未读取或输出其内容。

## 6. 本地验证与观察项

- `git diff --check`：通过。
- 完整 `npm test` 首次运行出现 1 个时序相关失败：`shared quota admission coalesces page owners, enforces two live transports and uses an absolute deadline`，结果为 138/139。
- 随后该聚焦用例独立连续运行 3 次均通过。
- 再次运行完整测试：**139/139 通过**，0 failed / skipped / cancelled。

该瞬时失败未对应任何生产硬门禁失败，最终完整套件及聚焦复跑均通过；建议将其作为非阻断的测试时序稳定性观察项保留，不在本次只读部署核验中修改代码。

## Acceptance Criteria 对照

- **AC1：通过。** committed HEAD 白名单归档、归档哈希、完整文件清单摘要及关键文件哈希一致。
- **AC2：通过。** 证据记录了完整预检、版本化备份、仅两个 compose 字段变化及一次直接全量切换，无灰度。
- **AC3：通过。** 容器、镜像、重启/OOM、local/auth/internal、非法输入和控制台标记均通过。
- **AC4：通过。** 配置哈希、账号数/模式不变，记录及报告未发现敏感信息泄漏。
- **AC5：通过。** deployment/verification 记录完整，旧 release/image 与四项备份均保留，回滚材料就绪。
