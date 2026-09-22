# 实施计划：低额度热池与刷新冷却

## 1. 前置检查

- [ ] 确认RPM子任务与`09-20-dynamic-cache-pool-growth`已提交。
- [ ] 修订冲突测试：membership从纯priority/id扩展为quota role，但target/grow owner不重复。
- [ ] 冻结80/95/100、partial-100、unknown/zero、多resetsAt和low=0 baseline边界红灯。

## 2. 配置与状态

- [ ] normalizer/API/UI增加low字段；分别测试启动missing、旧客户端省略、显式0、size0新安装、正数preset和save/restart。
- [ ] 扩展metadata account state为正交rule/quota维度，修复clear/prune/recover不误删。
- [ ] 增加quota disposition严格验证、身份替换清理和API安全投影。

## 3. 成员与选择

- [ ] low=0旁路role-aware逻辑；low>0实现high/low/unknown/reserve分类和deterministic membership，known filler优先、unknown最后。
- [ ] role内复用health/sticky；low-first、high立即fallback。
- [ ] 贯穿lease role snapshot、RPM blocked facts和concurrency-only grow。
- [ ] 更新min/max/target/actual composition普通诊断。

## 4. 刷新驱动恢复

- [ ] low account/degrade设置waiting-refresh并产生独立quotaRemovalAction，首包前最多换号；显式rule disposition不叠加hold。
- [ ] quota scheduler让waiting-refresh下周期真实fetch，绕过success cache但遵守dedupe/cap/backoff。
- [ ] 任一最新成功known window 100%（含partial、无chat failure）设置quota-exhausted，按最早有效reset刷新，全部known恢复才清除。
- [ ] 验证manual recover不绕过耗尽，force refresh可重新判断。

## 5. 验证

```bash
node --check server.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/account-draft.test.js test/ui-contract.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [ ] focused覆盖组成不足、known/unknown filler、并发/RPM、race、stream/cancel、manual recover、refresh/restart和多reset。
- [ ] 更新README/config.example及`.trellis/spec/backend/{database-guidelines,quality-guidelines,logging-guidelines}.md`、`.trellis/spec/frontend/{state-management,quality-guidelines}.md`。
- [ ] check、commit、archive。
