# 实施计划：详细日志丢弃分原因计数

## 1. 冻结现状和红灯

- [ ] 冻结 `health` API 两处当前形状、旧 UI 文案、全量测试基线（当前 242/242）和所有 `health.dropped++` 入口，按 `research/current-drop-contract.md` 补齐遗漏。
- [ ] 用可注入小限额写红灯：capture budget、秘密集合、扫描工作、输出文本、活动 root/attempt 限额、store queue/admission/stale/open-root；断言 `sum(dropReasons)===dropped` 且触发一次只增对应一个桶。
- [ ] 截断（非 resource-limited）与 `omitted-for-safety` 不得误记为 dropped；failures/corrupt 单独计数。

## 2. 唯一 store owner 与资源归因

- [ ] `DetailedLogStore` 增加固定、归零的 `health.dropReasons` 与唯一 `recordDrop(reason)`；每个现有 `health.dropped++` 原地改为固定原因调用，达到安全整数上限时总数/分项保持一致。
- [ ] `DetailRedactor` 首次超过秘密数/字节、depth/visited/token/matches/assignment、文本/输出预算时只设有界内部原因；不改变任何脱敏返回结果或安全挡板。
- [ ] `BodyCapture` 区分共享内存预算（原始保留/安全输出扩容）与普通 5 MiB 截断；内部原因只流向 `DetailRoot` 根级投影，不写正文描述符。
- [ ] `DetailRoot` 的 full/error 两模式各只在原有资源受限点递增一次；同组多 body 原因按 `design.md` 优先级选择，不重复计数。server.js 两处直写也迁移到 store owner。

Checkpoint：旧 `dropped` 数值不减/不增（同一测试场景），分项严格求和，没有第二次扫描、明细身份或存储 schema。

## 3. API 与控制台

- [ ] 在既有 `GET /api/logs/settings` 和 `GET /api/logs/details` 的 health 上增加相同固定分项；不得扩展普通 JSONL/metadata 或未认证面。
- [ ] 详细日志页只用固定 label + `textContent`/`aria-live` 展示非零桶和“本进程启动以来”口径；旧 API 不含分项时安全兼容，保持 `DETAIL_*` 访次/游标/设置开关/账号草稿所有权。
- [ ] README 解释 dropped 不是失败请求或缺失根数。

## 4. 验证及知识沉淀

- [ ] 聚焦：`node --test test/detailed-log-capture.test.js test/detailed-log-store.test.js`，UI 生产脚本 VM 与 `test/detailed-log-ui.test.js test/ui-contract.test.js`，本地临时 DATA_DIR 的认证 API 集成；负载/写失败仍 fail-open。
- [ ] `node --check server.js`、所有 `lib/*.js`、生产内联 `<script>` 的 `vm.Script` 编译、`env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test`（不得少于 242/242）、`git diff --check`。
- [ ] 真实浏览器检查新只读说明在窄屏下可阅读，键盘/焦点/aria-live 不退化；工具不可用时明确报告，不得用 VM 冒充。
- [ ] Phase 2.2 独立 check：静态搜索全部 `health.dropped++`，变异一个原因入口应使 focused tests 失败；检验 fixed enum 无敏感明细，单原因/复合原因不漂移。
- [ ] Phase 3.3 英文 backend logging 与 frontend state/quality spec（API/additive/安全/测试矩阵）及必要的 operator README 同步；分别提交业务、spec、task 产物后归档和 journal。

本任务不修改生产详细日志开关/限制，不推送、不部署。若 operator 之后要上线新计数，需另行按部署指南获得授权和验证。
