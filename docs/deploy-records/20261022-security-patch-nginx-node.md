# 安全补丁：nginx / Node.js 漏洞排查与升级（20261022-security-patch-nginx-node）

状态：已完成；Go 程序重编译待办。

- 背景：2026-10 中旬集中披露的漏洞——nginx 5 个 CVE（10/14，修复版 1.30.6 / 1.31.7；CVE-2026-15176、-93479、-95101、-97629、-97205），Go `crypto/x509` 吊销 eMudhra 中间 CA（CVE-2026-111943，10/20，修复版 1.26.10 / 1.27.3，需重编译生效），Node.js 10/21 安全发布（22.x 修复版 22.23.4，含 Brotli 越界写 CVE-2026-111497 及 TLS 主机名校验问题）。
- 范围：本机 + 两台小机（下称「dmit 节点」「反代节点」）。三台均无 PHP / WordPress；未发现 sharp、go-chi 依赖。
- 配置面：三台 nginx 均未使用 alias+rewrite、aio/SSI、HTTP/3，且 `ssl_session_tickets off`；唯 CVE-2026-93479（脚本求值溢出）无法靠配置排除，故全部升级。

## 变更

| 位置 | 升级前 | 升级后 | 验证 |
|---|---|---|---|
| 本机系统 nginx（官方 mainline 源） | 1.31.4 | 1.31.7 | `nginx -t` 通过，HTTP 200 |
| 容器 `tsw-34e5613fe6-https-1` | 1.30.5 | 1.30.6 | 仅 `--no-deps` 重建 https 服务，代理响应与直连上游一致 |
| 容器 `oc-argon-rewrite`（`docker run` 创建） | 1.30.5 | 1.30.6 | 原参数重建（`ai-internal` 网络、`default.conf` 只读挂载），同网容器按名访问可达 |
| dmit 节点 nginx / OpenSSL | 1.30.5 / 3.5.7-1~deb13u2 | 1.30.6 / 3.5.7-1~deb13u3 | `nginx -t` 通过，HTTP 301 |
| 反代节点 nginx / bind9-libs | 1.26.3-3+deb13u9 | 1.26.3-3+deb13u10（Debian 安全追踪标记已修复上述 5 个 CVE） | 包已由 unattended-upgrades 装好，手动重启 nginx 使新二进制生效；HTTP 301 |
| 本机 Node.js | Ubuntu 包 22.22.1（仓库无更新） | NodeSource `node_22.x` 22.23.4，npm 10.9.9 | 本仓库 `npm test` 652/652 |
| 本机 libcares2 / libnss3 | — | 1.34.6-1ubuntu0.2 / 3.120-1ubuntu2.2 | Ubuntu 安全更新 |

- Node 切换细节：新增 `/etc/apt/sources.list.d/nodesource.list`（签名密钥 `/etc/apt/keyrings/nodesource.gpg`）与 `/etc/apt/preferences.d/nodesource`（nodejs 固定优先 NodeSource）。Ubuntu 的 `npm` 及其连带的 128 个 `node-*` / webpack / eslint 等依赖包被卸载（仅 `npm` 为手动安装，无全局 npm 包）。生产容器 `cline-pass-console` 本就是 22.23.4，未改动。
- 回滚：nginx 各机可 `apt-get install nginx=<旧版本>`；容器旧镜像 ID 已被新 `nginx:stable-alpine` 覆盖，如需回滚需按旧摘要重新拉取；Node 删除 NodeSource 源与 pin 后 `apt-get install nodejs=22.22.1+dfsg+~cs22.19.15-1ubuntu1 npm`。

## 待办

- 孤儿测试进程（`NODE_ENV=test`，仅监听 127.0.0.1:42169，10/20 遗留）仍在运行旧 Node 二进制，需手动 kill。
- Go：本机运行中的 Go 程序全部低于 1.26.10 / 1.27.3，需重编译或等上游发版。优先：`opencode2api`（go1.24.4 / go1.24.13）、`cpa-manager-plus`（go1.24.13）已出维护期；自建镜像 `apophis-teamseatwatch`（go1.27.1）可直接用 1.27.3 重编。第三方（new-api、CLIProxyAPI、nginx-ui、x-ui/xray、sing-box、v2ray、cloudflared、bepusdt、docker/containerd、1panel）等上游。本机 Go 工具链 1.26.8，Ubuntu 仓库暂无新版。
