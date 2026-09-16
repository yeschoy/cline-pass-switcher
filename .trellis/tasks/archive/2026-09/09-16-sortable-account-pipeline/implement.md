# 可排序账号流水线 — 实施计划

## 前置门禁

- [x] 用户复核 PRD、设计与本计划，并明确批准开始；批准规划不等于批准实现。
- [x] 启动前确认 `server.js`、`public/index.html`、相关测试没有其他并发写者或未归属改动。
- [x] 校验 implement/check context manifests 均含真实规范与研究条目。

## 实施步骤

1. [x] 在现有 `accountPipeline` 规范化器中加入默认顺序和精确排列校验；启动迁移缺失顺序，API 旧客户端省略顺序时保留当前值，非法显式顺序在任何 mutation 前返回 400。
2. [x] 先增加后端红测：默认迁移、完整 24 排列往返、重复/缺失/未知/非数组拒绝、旧客户端保留和四项全关 legacy 等价。
3. [x] 将固定 `buildPipelineGroups()` 改为按顺序稳定细分候选组；保持硬资格过滤、unknown no-op、全部 unhealthy 的前置优先级回退和有界诊断。
4. [x] 把 sticky 作为可定位的组细分步骤；保留 mode=sticky 隐式末尾兼容、single/sticky 等待差异、其余模式即时容量回退和每次容量唤醒后重算。
5. [x] 增加调度红/绿用例：quota↔health 冲突、filter 前后、sticky 首/中/尾、有/无 identity、全部 unhealthy、容量满、六模式、最多一次换号及租约归零。
6. [x] 将控制台固定复选框改为可拖动有序列表；复用静态节点和单一重排函数，增加位置编号、上下移动按钮与 `aria-live`，不引入依赖。
7. [x] 扩展 `loadAll()`、`collectAccounts()`、原始调度草稿投影/验证/应用/stale 检查，使启停和顺序通过同一 ACCS 草稿及普通保存路径往返。
8. [x] 增加生产脚本 VM/UI 契约测试：拖放和键盘等价重排、首尾边界、禁用项位置、原始编辑器双向同步、保存失败/成功/重载和账号/批量/错误规则草稿保存。
9. [x] 更新 `config.example.json`、README 及经验证的 backend/frontend 规范，明确早步骤高优先级、隐式 sticky 和旧配置迁移。
10. [x] 执行完整质量检查并检查整个 diff；真实浏览器验证桌面拖放、纯键盘排序、焦点/播报、500px 窄屏和保存/刷新恢复。

## 验证命令

```bash
node --check server.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/account-draft.test.js test/ui-contract.test.js
# 使用本地 mock 和临时 DATA_DIR 运行新增的流水线集成用例
node --test --test-name-pattern='pipeline|account.*round.trip' test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

## 停止点与回滚

- 若任意排列无法在不改变租约/模式边界的前提下定义，返回规划修正，不用特殊调用点补丁绕过。
- 若旧客户端负载会重排服务端顺序，停止并修复候选配置先验证后写入语义。
- 若拖拽需要第二份长期状态，退回 DOM 顺序作为唯一草稿投影，不引入新 store。
- 若完整回归暴露与当前未归属改动冲突，保留任务 diff 并报告，不覆盖或重置他人文件。
