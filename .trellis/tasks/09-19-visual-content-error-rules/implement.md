# 内容错误规则与编辑器实施计划

## 1. 红灯与兼容基线

- [ ] 读取 backend quality/error/persistence 和 frontend state/quality/cross-layer specs。
- [ ] 冻结工作树；确认不触碰日志/统计子任务代码。
- [ ] integration 加入新字段严格 validation、旧客户端 preserve、startup round-trip 和失败不写红灯。
- [ ] 增加内容规则顺序/范围/ignore/fallback、嵌套错误、非流式/首包前/首包后/取消红灯。
- [ ] account-draft/UI 加入 visual/advanced/stale/preset/raw-editor 单一草稿红灯。

## 2. Backend schema 和 matcher

- [ ] 实现 `normalizeAccountContentErrorRules` 与严格 validator，限制数量/文本/总 bytes/range/action/cooldown/exact fields。
- [ ] GET/POST `/api/accounts` 增加字段；POST 省略时保留，显式值严格替换。
- [ ] 建立 bounded normalized failure text helper，使用既有 secret redaction 并追加当前 message redaction。
- [ ] 预编译只读 lowercase matcher；首条 content 命中，否则回退 status map。
- [ ] 接入 non-stream、pre-stream SSE、post-start SSE 和 transport paths；client cancel 跳过。
- [ ] 确认 ignore 不触发 status fallback且不改变 provider failover，cooldown/ban 仍最多换号一次。

回滚点：backend 黑盒矩阵未绿时不进入 UI。

## 3. 前端统一草稿

- [ ] `loadAll()` hydration `ERROR_RULE_DRAFT`；所有 redraw/navigation 保留。
- [ ] 替换三行 raw textarea为可视化状态/内容规则表格，提供 add/delete/reorder/校验和 aria-live。
- [ ] 实现可折叠高级 JSON snapshot、generation、invalid/stale 拒绝和原子 apply。
- [ ] 改造 presets 只修改 statusRules 并保留 contentRules。
- [ ] 改造 raw scheduling editor 和 `collectAccounts()` 使用同一个规则 draft，完整保存发送两个字段。
- [ ] 所有 server/operator text 使用 escapeHtml/textContent；长关键词在桌面/窄屏可访问。

## 4. 文档和验证

- [ ] 同步 `config.example.json`、README（若现有规则为 operator-facing）和 backend/frontend specs。
- [ ] 运行：

```bash
node --check server.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/ui-contract.test.js test/account-draft.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [ ] 真实浏览器验证键盘新增/编辑/排序/删除、高级 JSON focus/stale/invalid、桌面和 390px 滚动。
- [ ] 搜索、抽屉、批量、统计/日志导航后草稿不丢；保存失败不伪装成功。
- [ ] 只提交本子任务拥有的代码、测试、文档、spec 和 Trellis 文件。
