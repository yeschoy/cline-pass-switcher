# Implement — drain 档

## 顺序

1. **LRU 轮询**：`rankWorkflowCandidates` 的 `roundrobin` 改为按 `lastSelected` 升序；更新 `test/account-workflow.test.js`。
2. **配置契约**：`server.js` `normalizeAccountPipeline` 新增四字段（allowed、默认、strict 校验、warm<drain 跨字段约束）；补校验测试，并用 HEAD 版本的非 strict 启动路径验证旧镜像可接受新 config。
3. **额度投影与有效并发**：`server.js` 新增 `drainActive()`、`effectiveMaxConcurrent()`；改 `quotaProjection`、`accountHasCapacity`、`poolWaitBudget`、`growCachePoolOne`、`selectionResult` 的 quotaRole 映射。
4. **缓存池**：`cachePoolMembership` drain 置前 + `actual.drain`；`buildPipelineGroups`/`PIPELINE_QUOTA_POOLS` 加 `drain`。
5. **Workflow 选号**：quota 过滤放行 drain；`tryWorkflowSelection` 与 `previewAccountWorkflow` 按 drain tier 优先；capacity 节点 `drainAfter`；`projectWorkflowDiagnostics` 透传。
6. **投影/前端**：账号列表 `effectiveMaxConcurrent` 与 drain 徽章；工作流面板三项配置；前端 normalize/defaults 同步。
7. **测试**：新增 `test/drain-tier.test.js`（集成）覆盖 PRD 验收项；更新受影响的 UI 契约测试。

## 验证命令

```bash
node --test test/account-workflow.test.js
node --test test/drain-tier.test.js
npm test
```

## Review gates

- 第 3 步后：`drainEnabled=false` 下跑 `npm test` 全绿（证明默认零行为变化）。
- 第 7 步后：trellis-check 全量检查。

## 回滚

- 运行期：控制台关闭 `drainEnabled`，立即恢复 ≥95% 剔除。
- 镜像回退：直接回退即可。旧版本启动时丢弃 accountPipeline 中的四个新字段（drain 关闭、warm 回到 80%），不会启动失败。
