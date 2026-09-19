# 上游亲和版本生产部署报告

## 结果

- 状态：部署成功；即时、90 秒延迟和独立只读门禁全部通过。
- Release：`20260919-172057-3ccb929-upstream-affinity`
- 源提交：`3ccb92984eca4b282e158027bf571b7ffab06bb0`
- 新 exact image：`sha256:5a26c0c0fd6f78b0c19fc72d840f00cfcb87e990e74d1e32646843ff56577935`
- 旧 exact image：`sha256:fb5d9de7dc6643201a333ed47e7064464df3615598cd0fb3c91ad3ffc2f91cf2`，仍可 inspect。
- 正式切换使用 `docker compose -f compose.yml up -d --no-build`；构建后未再次 build。
- 未修改 NewAPI/CPA，未发送真实模型或付费请求，未清理生产 release/image/log/cache/backup。

## Source 与不可变候选

- committed-source 独立导出通过 server/lib/UI syntax 和 165/165 tests。
- allowlisted archive SHA-256：`95969d2f49c303d646f981cfefd23a87d51c7e9097cc6bdfa87dde34249776b6`。
- release 共 14 个 allowlisted 成员；目录 0755、文件 0644。
- `server.js`、`public/index.html`、普通/详细日志三个安全模块与本地 HEAD hash 一致。
- candidate Compose 相对 live 只改变 image 与 build context；最终 candidate Compose 构建一次后锁定 exact image。
- 构建后以 UID/GID 1000:1000 验证镜像内应用文件可读，旧 live 容器保持 healthy。

## 复制数据迁移预演

最终 rehearsal 使用最新 live config/metadata/logs 副本、candidate exact image、生产 UID/GID、read-only root、cap drop、no-new-privileges、tmpfs 和 internal Docker network。

验证结果：

- 首次 readiness：约 473 ms；`/api/meta` 与日志 API 通过。
- Config：仅 16 条现有 route 新增 `providerCooldownMs: 0`；预测 hash `897bc79377b16c5ae4ca284bab311041a0d0bde83cf5e74260c4b2525315caa6`。
- Statistics：v2→v3，共升级 2169 个 aggregate，新增五个 routing counters 和 `routingTrackingStartedMinute`；既有全局/账号/模型/健康/cache facts 完整保留。
- 普通日志：3 个文件、5,842,489 bytes，预演前后字节不变。
- 第二次启动幂等：config、metadata、logs 不再变化。

预切换的三次非生产失败均发生在 live mutation boundary 之前并已留证：

1. 本地 macOS Bash 不支持 `readarray`，SSH 前退出。
2. Docker 空 host-port 语法无法通过 `docker port` 读取映射，isolated container/network 在 finally 中清除。
3. internal network 的 published port 无法从 host 访问；候选容器实际 running 且有启动标记。最终改为容器内 Node fetch 完成安全 API 验证。

三次均未修改或重启 live 服务；每次都复核旧容器 healthy、restart=0、OOM=false。

## 备份、切换和门禁

切换前私有备份并生成 manifest：

- `compose.yml`
- `deployment.json`
- `data/config.json`
- `data/metadata.json`
- `data/logs/`

原子 install/restore helper 在私有 scratch 通过。旧 exact image 和 no-build 回滚材料保留。

切换后：

- exact image 匹配；running/healthy；restart=0；OOM=false。
- 实际 config hash精确等于 rehearsal 预测值。
- 配置安全投影保持：10 个账号、8 个启用、sticky、wait 2000、cache pool 5、5 条状态规则、0 条内容规则、16 条 route，全部 `providerCooldownMs=0`。
- statistics v3 和 `routingCoverage` 已发布。
- 认证 accounts/models/statistics/request logs/error logs/detailed settings 均为 200；非法 quota-refresh 为 400。
- 控制台包含上游一键配置、亲和日志、provider cooldown 和内容错误规则标记。
- `new-api` 通过 `ai-internal` 网络的 `cline-pass-switcher` 别名访问 `/api/meta` 成功。
- 容器内关键源码 hash 匹配，bounded logs 未命中 fatal/config/metadata/persistence 指示。
- 90 秒延迟复核再次通过全部硬门禁。
- 独立只读 postcheck 全部 checks 为 true。

## 公开入口

生产主机预切换与发布后均无法解析 `clinepass.yeschoy.com`，继续记录为既有 DNS 外部依赖故障。因本地、认证和内部网络门禁全部通过，没有仅因该既有 DNS 状态回滚。

## 回滚

远端 verification 目录保留：

- old exact image；
- 原始 Compose/deployment/config/metadata/logs 备份；
- candidate Compose、release、build/rehearsal/gate 报告；
- `rollback-ready.json`。

必要时先验证无未知漂移，再恢复备份并用旧 exact image `up -d --no-build`；禁止 rebuild。

## 残余边界

- 本次只验证部署、schema 和安全管理面；没有发送真实 Chat 请求，因此不声称生产缓存命中率已经改善。
- NewAPI 仍可能在某些转换路径丢失显式会话键；Switcher 只能使用实际到达的字段并如实记录 fallback。
- 真实浏览器布局仍受本机缺少 `agent-browser` 阻塞；自动化和生产 HTML 标记门禁已通过。
