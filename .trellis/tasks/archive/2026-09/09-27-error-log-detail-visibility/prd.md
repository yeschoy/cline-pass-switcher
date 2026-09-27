# 错误日志与详细诊断关联

## Goal

让管理员在错误日志板块查看失败请求的整条可捕获链路：客户端入站请求 Header/Body、发往上游的请求 Header/Body、上游响应 Header/Body、最终客户端响应 Header/Body；Body 在独立原文 opt-in 下按既有上限未脱敏，并清楚标识未采集、容量省略与过期等缺失。

## Background

- 用户已选择 B：在错误日志列表直接查看未脱敏原文，而非仅用现有“查看错误详情”跳转；随后明确要求上述四段 Header/Body。普通错误行目前只存安全摘要（`server.js` 2912–2940）；现有“查看错误详情”已按 requestId + attemptIndex + callId 关联（`public/index.html` 1648–1663；`test/detailed-log-ui.test.js` 148–180）。
- 用户同意先复用 `raw-full`，不扩展 error-only 四段采集。当前 `raw-full` 采集四段，仅当 `detailedLogging` 与 `rawBodyLogging` 都可用/开启时生效，且会对成功请求也付出捕获成本；`raw-error` 只保留失败上游 attempt 的请求/响应 Header 和 Body，不保存客户端入站和最终响应（`lib/detailed-log-capture.js` 440–580；`test/integration.test.js` 4400–4440）。原文正文有 35 MiB/体上限；Header 只有安全名称/结构值投影，Authorization/Cookie/Set-Cookie 固定遮蔽（`lib/raw-detail-headers.js`）。
- `.trellis/spec/backend/logging-guidelines.md` 明确普通行不能存上游原文；详细捕获是独立、管理员认证、按配置开启且有容量与留存边界的机制。
- 生产 raw-body 是否开启属于现有 `09-26-production-raw-body-enablement` 任务，本任务不承担该生产切换或恢复过去未采集正文。

## Requirements

- 先核实哪些失败类别会形成普通行、哪些 native 调用被详情采集以及 UI 关联条件；区分摘要限长、未开启采集、当时无原文 opt-in、容量省略、已过期和真正的关联/展示故障；只改变经过论证的展示缺口。
- 管理员在错误日志板块可查看已有 `raw-full` 的客户端入站、选中失败上游调用及最终客户端响应四段 Header/Body；重试时标记每个 attempt 与最终响应，不把某次调用的上游响应误称为最终客户端响应。其他 profile 缺少四段时应如实标注可查看的范围，不能把脱敏详情称为原文。普通列表 API 不携带正文，原文来自独立认证、按需读取的详细存储边界。
- Header 只显示现有安全投影，不保留/展示凭据、Cookie、任意自定义 Header 值；原文 Body 仅在独立 raw opt-in 和运行资源门槛通过后采集，不承诺超过容量/大小/留存界限的“全部字节”。
- 无详细记录时明确说明可能的配置、采集、容量、保留和历史缺失边界，而不是伪造完整正文。
- 保留认证、脱敏、原文独立 opt-in、正文按需读取和普通日志限长/敏感信息排除；不改变默认采集开关。

## Acceptance criteria

- [ ] 本地 mock 覆盖四段 Header/Body、失败后成功重试、多个失败 attempt、最终流式/非流式响应、缺失/截断/超限与历史行；相同 requestId 的最终客户端响应必须可与选中 attempt 明确区分。
- [ ] 普通错误行不新增原文正文、凭据、敏感 Header 值；详细诊断只通过已有授权边界按需提供。
- [ ] 管理台变化有 VM/集成测试；如验收涉及点击、焦点或窄屏，补真实浏览器验证。

## Open product decision

- 按安全/性能原则暂定单行显式展开，仅在该行显示并按需读取 Body，行切换/离开板块/会话失效后清除原文；不在列表刷新时自动下载或渲染整页 Body。最终规划审核时明确告知用户这一交互默认值。
