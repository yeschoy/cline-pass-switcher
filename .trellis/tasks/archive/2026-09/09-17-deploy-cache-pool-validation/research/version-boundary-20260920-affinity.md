# 2026-09-20 上游亲和版本边界

生产已切换到 release `20260919-172057-3ccb929-upstream-affinity` / commit `3ccb92984eca4b282e158027bf571b7ffab06bb0`。

本次没有修改缓存池业务配置：账号数、启用数、sticky、`cachePoolSize=5`、wait 2000、priority 和错误规则保持。启动迁移仅为现有 route 补 `providerCooldownMs:0`，并将 statistics v2 升级为 v3 以开始记录 routing/affinity counters。

该容器重启和 routing coverage 新起点构成新的生产观察边界。此前任何跨 release、配置或统计版本的样本都不能解释为同一连续 24 小时窗口，也不能据此宣称达到 70% 缓存请求命中率。未来若重启正式验证，必须从本次 delayed gate 之后重新定义稳定窗口和样本下限。
