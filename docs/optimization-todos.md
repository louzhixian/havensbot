# 优化待办事项

Last updated: 2026-01-14
Status: ✅ **Phase 2 Completed** - LLM Client and Retry Integration Complete

## 评估概览

- 代码规模：约 5500 行 TypeScript
- 核心功能：RSS 聚合 → 去重 → LLM 增强 → Discord 推送
- 技术栈：Discord.js + Prisma + Postgres + RSSHub
- 部署：Docker Compose 单容器架构

---

## 🔴 高优先级：稳定性和可靠性

### 1. 数据增长无限制 ✅ **已完成**

**现状**
- Item 表会无限增长，没有清理策略
- 没有分区或归档机制
- 可能导致查询变慢和存储成本增加

**解决方案（已实施）**
- [x] 添加 `archivedAt` 字段实现软归档
- [x] 实现自动归档任务（可配置保留天数，默认 180 天）
- [x] 添加索引优化查询性能
- [x] 实现指标数据定期清理（默认保留 90 天）

**已创建文件**
- `apps/arkcore/src/archival/archiver.ts` - 归档逻辑
- `apps/arkcore/src/archival/stats.ts` - 归档统计
- `apps/arkcore/src/utils/db-helpers.ts` - 数据库查询辅助函数

---

### 2. 可观测性缺失 ✅ **已完成**

**现状**
- 只有 console.log，没有结构化日志
- 没有监控指标（LLM 调用次数、成本、延迟）
- 难以诊断生产问题
- 没有告警机制

**解决方案（已实施）**
- [x] 引入 Pino 结构化日志
- [x] 实现指标收集系统（LLM、RSS、Digest、Editorial）
- [x] 添加系统告警机制
- [x] 实现 Discord 可观测性频道
- [x] 添加 `/stats` 和 `/alerts` 命令
- [x] 实现每日报告和实时告警推送

**已创建文件**
- `apps/arkcore/src/observability/logger.ts` - 结构化日志
- `apps/arkcore/src/observability/metrics.ts` - 指标收集
- `apps/arkcore/src/observability/alerts.ts` - 告警管理
- `apps/arkcore/src/observability/alert-rules.ts` - 告警规则
- `apps/arkcore/src/observability/stats.ts` - 统计查询
- `apps/arkcore/src/observability/discord-formatter.ts` - Discord 格式化
- `apps/arkcore/src/observability/discord-notifier.ts` - Discord 通知

---

### 3. LLM 依赖单点失败 ✅ **已完成**

**现状**
- 没有 fallback 或 circuit breaker
- LLM 失败会影响整个 pipeline（虽然有 try-catch，但没有降级策略）
- 没有 token 计数和成本追踪
- 没有请求超时控制

**解决方案（已实施）**
- [x] 实现统一的 LLM 客户端
- [x] 添加自动重试（指数退避）
- [x] 实现 fallback 降级策略
- [x] Token 计数和成本追踪
- [x] 失败率监控（简化版 circuit breaker）
- [x] 自动记录 LLM 指标

**已创建文件**
- `apps/arkcore/src/llm/client.ts` - 统一 LLM 客户端
- `apps/arkcore/src/llm/cost-estimator.ts` - 成本估算

**待集成**
- [x] 更新 digest.ts 使用新 LLM 客户端
- [x] 更新 editorial.ts 使用新 LLM 客户端
- [x] 更新 deeper.ts 使用新 LLM 客户端

---

### 4. 错误处理和重试机制 ✅ **已完成**

**现状**
- RSS 解析失败可能导致数据丢失
- Discord API 速率限制未明确处理
- 没有失败任务的重试机制
- 错误信息不够详细

**解决方案（已实施）**
- [x] 实现通用重试工具（指数退避）
- [x] 支持自定义可重试错误判断
- [x] 自动记录失败指标
- [x] 集成到指标收集系统

**已创建文件**
- `apps/arkcore/src/utils/retry-utils.ts` - 通用重试工具

**待集成**
- [x] 更新 rss.ts 集成重试机制
- [x] 更新 messaging.ts 集成重试机制

---

## 🟡 中优先级：架构和扩展性

### 5. 单容器架构限制

**现状**
- 无法水平扩展
- Cron 和 bot 在同一进程
- 重启会影响所有功能
- 单点故障

**影响**
- 扩展性受限
- 维护窗口影响所有功能
- 无法独立扩展不同功能

**建议方案**
- [ ] 评估是否需要拆分服务（Cron worker / Bot handler）
- [ ] 设计消息队列架构（如使用 Redis + Bull）
- [ ] 实现任务分布式锁（避免多实例重复执行）
- [ ] 保持当前架构，但为未来拆分预留接口

**相关文件**
- `apps/arkcore/src/index.ts`
- `apps/arkcore/src/scheduler.ts`
- `docker-compose.yml`

**优先级说明**
- 当前单实例足够使用
- 但在代码重构时应考虑解耦，便于未来拆分

---

### 6. 数据库查询优化

**现状**
- 没有针对常用查询的索引优化
- 复杂查询可能随数据增长变慢
- 没有查询性能监控

**影响**
- 数据增长后性能下降
- digest 生成可能变慢

**建议方案**
- [ ] 审计常用查询，添加必要索引
- [ ] 添加查询性能监控
- [ ] 考虑添加 `Item.channelId` 索引（方便按 channel 查询）
- [ ] 评估是否需要添加 createdAt/enrichedAt 复合索引

**相关文件**
- `prisma/schema.prisma`
- `apps/arkcore/src/digest.ts`
- `apps/arkcore/src/editorial.ts`

---

## 🟢 低优先级：质量和长期改进

### 7. 安全性（低优先级，仅个人使用）

**现状**
- 任何人都可以添加源（但 server 仅个人使用）
- URL 输入未验证（SSRF 风险）
- 用户提供的 name 未清理
- 依赖 latest 镜像（rsshub:latest）

**影响**
- 当前风险较低（仅个人使用）
- 如果未来开放给他人，需要加强

**建议方案**
- [ ] 添加 URL 白名单/黑名单机制
- [ ] 验证和清理用户输入
- [ ] 固定 Docker 镜像版本
- [ ] 添加 Discord 角色/权限检查（如果需要多人使用）
- [ ] 添加命令速率限制

**相关文件**
- `apps/arkcore/src/commands.ts`
- `apps/arkcore/src/source-handlers.ts`
- `docker-compose.yml`

---

### 8. 测试和 CI/CD

**现状**
- 没有自动化测试
- 没有 CI/CD pipeline
- 依赖手动验证

**影响**
- 重构风险较高
- 回归问题难以发现
- 部署依赖手动操作

**建议方案**
- [ ] 添加单元测试（关键业务逻辑）
- [ ] 添加集成测试（RSS 解析、LLM 调用）
- [ ] 设置 GitHub Actions CI
- [ ] 实现自动化部署流程

**相关文件**
- 所有 `.ts` 文件
- 需要添加 `tests/` 目录
- 需要添加 `.github/workflows/`

---

### 9. 性能和成本优化

**现状**
- 没有缓存层（Redis）
- 可以添加 RSS feed 缓存
- LLM 成本未追踪和优化

**影响**
- RSS 重复抓取浪费带宽
- LLM 成本不透明
- 可能存在性能优化空间

**建议方案**
- [ ] 添加 Redis 缓存层（可选）
- [ ] 实现 RSS feed HTTP 缓存
- [ ] 追踪和优化 LLM token 使用
- [ ] 评估是否可以复用 LLM 结果

**相关文件**
- `apps/arkcore/src/rss.ts`
- `apps/arkcore/src/digest.ts`
- `apps/arkcore/src/editorial.ts`

---

## 实施建议

### 阶段 1：稳定性和可靠性（当前优先）
1. 数据增长策略
2. 可观测性改进
3. LLM 依赖优化
4. 错误处理加强

### 阶段 2：架构优化
1. 代码重构和解耦
2. 为未来扩展预留接口
3. 数据库优化

### 阶段 3：长期改进
1. 测试覆盖
2. CI/CD
3. 性能优化

---

## 相关文档
- `DECISIONS.md` - 架构决策记录
- `docs/features.md` - 功能追踪
- `RUNBOOK.md` - 运维手册
