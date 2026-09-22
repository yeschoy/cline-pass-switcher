# 真实浏览器验收证据（父任务 §5 交互式 UI 补证）

## 方法

- 环境：macOS + Google Chrome（`/Applications/Google Chrome.app`，`--headless=new`，独立 `--user-data-dir`），CDP 直连（Node 26 内置 WebSocket），一次性脚本置于 `/tmp`，**不进入仓库、不新增依赖、不改项目**。
- 输入可信度：点击用 `Input.dispatchMouseEvent`（mouseMoved → mousePressed → mouseReleased），键盘用 `Input.dispatchKeyEvent`（keyDown/keyUp、Enter），拖拽用真实鼠标事件序列；断言读的是渲染后的实时 DOM。
- 被测实例：`DATA_DIR=/tmp/cps-ui-verify`、`PORT=3411`、`proxyKey` 为空、2 个账号、`cline-pass/model-x` 路由 `p1,p2`，metadata 预置 `p1.hardQuarantined=true` 用于恢复入口。
- 坑（已排除的假报警，供后续复用）：
  1. 裸 CDP 不会自动滚动元素进视口 → 未滚动时点击落在视口外，会误判"按钮点不动"。必须先 `scrollIntoView`（并禁用 `scroll-behavior: smooth`）或用 `window.scrollTo` 精确定位，再用 `document.elementFromPoint` 复核命中。
  2. `Provider 恢复`按钮位于**折叠的 `<details class="ups-wrap">`** 内；未展开 summary 时 `focus()` 静默失败、`elementFromPoint` 返回外层 TD。必须先用真实点击展开面板。
  3. 断言"恢复按钮会弹确认框"是错的：`recoverProvider()` 直接调用 API，没有 `confirm()`。

## 结果：13/13 通过

| # | 检查 | 证据 |
|---|---|---|
| 1 | 420px 窄屏无整页横向溢出 | `documentElement.scrollWidth === clientWidth` |
| 2 | 窄屏下 5 个新数值输入可见 | `#cachePoolSize/#cachePoolMaxSize/#sessionBinding*` 均 `offsetParent != null` |
| 3 | 窄屏下 `#cachePoolRuntime`/`#cachePoolHelp` 不撑破容器 | 两者 `scrollWidth <= clientWidth` |
| 4 | 真实键盘输入更新草稿 | 真实按键后 `#cachePoolMaxSize.value === '4'` 且 `activeElement` 为该输入 |
| 5 | 重排按钮激活后焦点留在列表内 | 真实点击「下移 Cline 额度热池」后 `activeElement` 仍为该按钮（列表重排会移除/重插节点，此处验证的是焦点已被正确恢复） |
| 6 | 原生按钮 + Enter 重排并公告 | 顺序由 `quotaPool,healthSort,sticky` 变为 `healthSort,quotaPool,sticky`；`#pipelineOrderStatus` = "Cline 额度热池已移动到第 2 位；尚未保存" |
| 7 | 边界按钮禁用 | 首项 `.pipeline-move-up`、末项 `.pipeline-move-down` 均 `disabled` |
| 8 | 真实鼠标拖拽与键盘路径等价 | 拖动拖拽柄到首行后顺序变化；捕获到真实 `dragstart → dragenter → dragover → drop → dragend` |
| 9 | 重试编辑器不进行 HTML 注入 | 插入含 `<img src=x onerror=…>` 的 needle 后 `#retryRuleBody img` 数量 0、`window.__xss` 未定义 |
| 10 | 非法高级 JSON：保持打开 + 公告 + 草稿不变 | `#advancedRetryRulesFeedback` 输出解析错误文本，编辑器仍可见，`ACCS.retryRules` 与提交前逐字节相同 |
| 11 | 配对预设：预览显示 diff，取消无变化 | `#retryPresetModal` 可见且 diff 非空；取消后 modal 隐藏且 retry/error 草稿均未变 |
| 12 | 配对预设：确认后原子写入服务端 | `GET /api/accounts` 同时出现 `stop-empty-system-message` 与 `ignore-empty-system-message` |
| 13 | Provider 恢复：真实键盘激活并刷新 | 恢复前 `p1.hardQuarantined=true`；激活「恢复」后 `false`，`#accLive` = "已恢复 cline-pass/model-x / p1" |

## 截图（临时，位于 /tmp/cps-ui-evidence，未入库）

- `1-narrow-420.png`：420px 窄屏布局与新控件
- `2-pipeline-order-and-controls.png`：流水线重排控件与新数值输入
- `3-retry-preset-preview.png`：配对预设预览对话框
- `4-provider-recovery-and-status.png`：Provider 面板与恢复后的状态与公告

## 观察（非缺陷）

- Provider 徽章面板在 1280px 宽时内部需要水平滚动才能看到最右侧操作按钮；面板本身 `overflow:auto`，用户可正常滚动，未发现不可达控件。
- 本环境未安装 `agent-browser`；如需把类浏览器验收纳入常规流程，建议先安装该工具或保留本文件的 CDP 方式作为临时手段。
