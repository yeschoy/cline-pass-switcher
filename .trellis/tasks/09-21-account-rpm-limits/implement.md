# 实施计划：账号级 RPM

## 1. 红灯

- [ ] config/API/UI maxRpm round-trip、旧客户端省略保留和非法输入不写文件。
- [ ] 并发满不消耗RPM；RPM满不增加activeCount。
- [ ] provider retries逐`req.end()`计数、request创建/发送前reservation释放并唤醒、已发错误/取消不退款。
- [ ] rolling 60秒边界和Retry-After可注入clock验证。
- [ ] RPM-only不触发dynamic growth。

## 2. 后端

- [ ] 增加account字段 normalization/validation/preservation。
- [ ] 在lease owner旁实现bounded window/permit和账号身份清理。
- [ ] 将所有selection path迁移到结构化blocked result。
- [ ] 将lease/permit broker贯穿runChatChain；逐项迁移`/api/test`、`/api/probe`、`/api/validate-upstreams`、持久account的`/api/accounts/test`和`/api/accounts/proxy-test`，明确临时credential test不计。
- [ ] initial selection复用wait wake/retryAt；provider retry无permit立即local 429，不伪造attempt并保留此前真实错误。
- [ ] 增加安全GET projection和ordinary diagnostic enums。

## 3. 前端/文档

- [ ] 账号抽屉、添加账号、collect/save、raw editor、批量/预设保留maxRpm。
- [ ] 显示limit/used/reserved/retryAt并保持窄屏可用。
- [ ] 更新README/config.example及`.trellis/spec/backend/{database-guidelines,quality-guidelines,error-handling}.md`、`.trellis/spec/frontend/{state-management,quality-guidelines}.md`。

## 4. 验证

```bash
node --check server.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/account-draft.test.js test/ui-contract.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [ ] 逐route断言chat caller计数，models/catalog/quota明确不计；审计stream/cancel/retry/validate并发batch。
- [ ] check、spec update、commit、archive后再执行dynamic pool依赖。
