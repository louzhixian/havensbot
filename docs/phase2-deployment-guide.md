# Phase 2 部署和测试指南

**版本**: Phase 2 完成后
**更新日期**: 2026-01-14

---

## 部署前检查清单

### 1. 代码准备

```bash
# 确认所有更改已提交
git status

# 确认在 main 分支
git branch

# 查看最近的提交
git log --oneline -5
# 应该看到:
# cef1461 docs: add retrospective design and implementation plan
# f2a22dd docs: add phase 2 completion summary
# fafc336 feat: add Discord observability integration and commands
```

### 2. 依赖检查

在本地确认依赖安装正常：

```bash
npm install
npm run build  # 如果有 build 脚本
```

应该成功添加了 `pino@^9.5.0`。

---

## 服务器部署步骤

### 部署架构说明

ArkCore 使用 Docker Compose 部署，包含三个服务：
- `postgres` - PostgreSQL 16 数据库
- `rsshub` - RSSHub 服务
- `app` - ArkCore 主应用

### Step 1: 拉取代码

```bash
cd /path/to/ArkCore
git pull origin main
```

### Step 2: 配置环境变量

编辑 `.env` 文件，添加以下新配置：

```bash
# === Observability Configuration ===

# Required: Discord channel for observability
OBSERVABILITY_CHANNEL_ID=your_channel_id_here

# Optional: User ID to @mention for critical alerts
# ALERT_MENTION_USER_ID=your_user_id_here

# LLM monitoring
LLM_DAILY_BUDGET=10.0          # USD, adjust based on usage
STORAGE_WARNING_GB=10          # GB, adjust based on DB size

# Logging
LOG_LEVEL=info                 # debug, info, warn, error

# Daily report (optional)
DAILY_REPORT_ENABLED=true      # Set to false to disable
DAILY_REPORT_CRON=0 9 * * *   # 9 AM daily

# === Archival Configuration ===

ARCHIVE_ENABLED=true           # Set to false to disable archival
ARCHIVE_AFTER_DAYS=180         # Keep active items for 180 days
ARCHIVE_CHECK_CRON=0 2 * * *  # 2 AM daily
METRICS_RETENTION_DAYS=90      # Keep metrics for 90 days
```

**如何获取 OBSERVABILITY_CHANNEL_ID**:
1. 在 Discord 中，右键点击你想用作可观测性频道的频道
2. 选择 "复制频道 ID"
3. 如果看不到此选项，需要在 Discord 设置中启用 "开发者模式"

### Step 3: 重新构建和重启服务

```bash
# 重新构建 app 镜像（包含新的依赖 pino）
docker-compose build app

# 重启所有服务
docker-compose up -d
```

**说明**:
- `docker-compose build app` 会重新构建应用镜像，安装新依赖（pino）
- `docker-compose up -d` 以后台模式启动/重启所有服务
- entrypoint 脚本会自动运行 `prisma migrate deploy`，应用数据库迁移

### Step 4: 验证数据库迁移

**检查迁移是否成功应用**:

```bash
# 查看 app 服务启动日志
docker-compose logs app | head -20

# 应该看到类似：
# Running prisma migrate deploy
# ... migration logs ...
# Logged in as YourBot#1234
```

如果看到错误，可以手动检查迁移状态：

```bash
docker-compose exec app npx prisma migrate status
```

---

## 部署后验证

### 1. 检查启动日志

查看应用是否成功启动：

```bash
# 查看最近 50 行日志
docker-compose logs app --tail=50

# 或者实时跟踪日志
docker-compose logs -f app
```

**期望看到的日志**:

```json
{"level":"info","msg":"Logged in as YourBot#1234"}
{"level":"info","msg":"Archival task scheduled","cron":"0 2 * * *","retentionDays":180}
{"level":"info","msg":"Daily report task scheduled","cron":"0 9 * * *","channelId":"..."}
```

**不应该看到的错误**:
- ❌ "Environment variable not found: OBSERVABILITY_CHANNEL_ID"
- ❌ "PrismaClientKnownRequestError" (表示数据库问题)
- ❌ "Cannot find module 'pino'" (表示依赖未安装)

### 2. 验证 Discord 命令注册

在 Discord 中，输入 `/` 应该看到新命令：
- `/stats`
- `/alerts`
- `/maintenance`

如果没有看到，等待 1-2 分钟让 Discord 更新命令缓存。

---

## 功能测试清单

### Test 1: 基础健康检查

```
/ping
```

**期望结果**: "pong"

---

### Test 2: Stats 命令

#### 2.1 总览统计

```
/stats overview
```

**期望结果**:
```
📊 系统统计总览 (最近 24 小时)

🤖 LLM 使用
• 总调用: X 次
• 成功: X 次
• 失败: X 次
• 总成本: $X.XX
• 平均延迟: Xms

📡 RSS 抓取
• 总抓取: X 次
• 成功: X 次
• 失败: X 次
...
```

**注意**: 如果刚启动，某些数据可能为 0，这是正常的。

#### 2.2 LLM 详细统计

```
/stats llm
```

**期望结果**: 按操作类型分组的 LLM 使用统计

#### 2.3 最近错误

```
/stats errors
```

**期望结果**:
- 如果没有错误："✅ 过去 24 小时没有错误记录"
- 如果有错误：列出最近的错误

#### 2.4 存储统计

```
/stats storage
```

**期望结果**:
```
📦 存储统计

💾 数据库
• 大小: X.XX GB
• 警告阈值: 10.00 GB
• 状态: ✅ 正常

📊 Items 统计
• 总计: X
• 活跃: X
• 已归档: X
• 归档率: X%
```

#### 2.5 健康检查

```
/stats health
```

**期望结果**:
```
🏥 系统健康检查

💾 数据库
✅ 已连接

🤖 LLM
✅ 正常 (过去 1 小时失败率: 0%)

🚨 告警
✅ 无活跃告警
```

---

### Test 3: Alerts 命令

#### 3.1 列出告警

```
/alerts list
```

**期望结果** (刚启动时):
```
✅ 当前没有活跃告警
```

#### 3.2 解决告警 (暂时无法测试)

这个命令需要有活跃告警时才能测试。等待系统运行一段时间后，如果有告警触发，可以测试：

```
/alerts resolve <alert_id>
```

---

### Test 4: Maintenance 命令

#### 4.1 归档统计

```
/maintenance archive-stats
```

**期望结果**:
```
📦 归档统计

📊 概览
• 总 items: X
• 活跃: X
• 已归档: X
• 归档率: X%

📅 时间线
• 最旧的活跃 item: YYYY-MM-DD
• 最新的归档 item: N/A (或日期)

🔮 下次归档预估
• 时间: YYYY-MM-DD
• 预计归档: X items
```

#### 4.2 手动运行归档 (谨慎测试)

**⚠️ 警告**: 这会实际归档数据，建议等几天有足够数据后再测试。

```
/maintenance archive
```

**期望结果**:
```
✅ Archival completed:
- Items archived: X
- Metrics deleted: X
- Alerts deleted: X
- Duration: Xms
```

---

## 监控要点

### 第一天

**检查项目**:
1. ✅ 应用正常启动，没有崩溃
2. ✅ 所有命令响应正常
3. ✅ 日志格式正确（JSON 格式）
4. ✅ RSS 抓取仍在正常工作
5. ✅ Digest 生成仍在正常工作

**观察日志**:
```bash
# 查看结构化日志
docker-compose logs app | grep '"level"'

# 应该看到类似：
{"level":"info","time":"...","msg":"rss ingest complete: X new items"}
{"level":"info","time":"...","msg":"digest channel sent: ..."}
```

### 第一小时后

**检查**:
```
/stats overview
```

应该能看到：
- RSS 抓取有数据
- 如果有 digest 运行，应该有 digest 数据
- 如果使用了 LLM，应该有 LLM 调用记录

**告警检查任务**:

一小时后，系统会首次运行告警检查。查看日志：

```bash
docker-compose logs app | grep "alert check"

# 应该看到:
{"level":"info","msg":"Starting hourly alert check"}
{"level":"info","msg":"Alert check completed"}
```

### 第一天后

**检查可观测性频道**:

如果启用了每日报告（`DAILY_REPORT_ENABLED=true`），在配置的时间（默认 9 AM）应该会收到每日报告。

**运行**:
```
/stats overview
```

验证数据在累积。

### 第一周后

**归档测试**:

1. 运行归档统计：
   ```
   /maintenance archive-stats
   ```

2. 查看"下次归档预估"，确认逻辑正确。

3. 如果有足够旧的数据，归档应该在配置的时间自动运行。

4. 查看日志确认归档成功：
   ```bash
   docker-compose logs app | grep "archival"
   ```

---

## 常见问题排查

### 问题 1: 命令不显示

**症状**: 在 Discord 输入 `/` 看不到新命令

**排查**:
1. 等待 1-2 分钟（Discord 缓存）
2. 检查应用是否成功启动
3. 查看日志是否有命令注册错误
4. 重启 Discord 客户端

### 问题 2: 命令返回错误

**症状**: 命令执行后显示 "Command failed"

**排查**:
1. 查看应用日志获取详细错误
2. 检查 `OBSERVABILITY_CHANNEL_ID` 是否配置正确
3. 检查数据库连接是否正常
4. 运行 `/stats health` 查看系统状态

### 问题 3: 没有收到告警

**症状**: 明显有问题但没有告警

**排查**:
1. 检查 `OBSERVABILITY_CHANNEL_ID` 是否配置
2. 查看日志确认告警检查任务在运行
3. 运行 `/alerts list` 查看是否有告警但未发送
4. 检查 bot 是否有频道发送权限

### 问题 4: 日志格式不对

**症状**: 日志仍然是 `console.log` 格式，不是 JSON

**排查**:
1. 检查 `pino` 是否正确安装
2. 某些旧代码仍在使用 `console.log`（这是正常的，Phase 3 会替换）
3. 只要看到一些 JSON 格式日志就说明新系统在工作

### 问题 5: 归档没有运行

**症状**: 到了配置的时间但归档没有执行

**排查**:
1. 检查 `ARCHIVE_ENABLED=true` 是否设置
2. 检查 `ARCHIVE_CHECK_CRON` 格式是否正确
3. 查看日志确认任务调度成功
4. 注意时区设置（使用 `config.tz`）

---

## 性能基准

### 预期性能指标

**响应时间**:
- `/stats overview`: < 1 秒
- `/stats llm`: < 1 秒
- `/stats errors`: < 500ms
- `/stats storage`: < 500ms
- `/stats health`: < 500ms

**资源使用**:
- 内存增长: 应该在 ±50MB 范围内（Pino 非常轻量）
- CPU: 告警检查任务应该 < 100ms
- 数据库查询: 所有 stats 查询应该有索引支持

**如果性能不符合预期**:
1. 检查数据库索引是否正确创建
2. 查看慢查询日志
3. 考虑数据量是否异常大

---

## 回滚计划

如果遇到严重问题需要回滚：

### 快速回滚（保留数据）

```bash
# 1. 回到部署前的版本
git checkout <previous_commit_hash>

# 2. 重新构建并重启
docker-compose build app
docker-compose up -d
```

**注意**: 数据库新表和字段会保留，但不会被使用。

### 完全回滚（包括数据库）

**⚠️ 警告**: 这会删除所有观测数据和告警。

```bash
# 1. 代码回滚
git checkout <previous_commit_hash>

# 2. 数据库回滚（在容器内执行）
docker-compose exec app npx prisma migrate resolve --rolled-back 20260114011258_add_observability_tables

# 3. 重新构建并重启
docker-compose build app
docker-compose up -d
```

---

## 成功标准

部署被认为成功，如果：

✅ **Day 1**:
- 应用稳定运行，没有崩溃
- 所有 `/stats` 命令返回数据
- RSS 抓取和 digest 功能正常
- 日志显示结构化格式

✅ **Week 1**:
- 告警检查每小时运行
- 如果有问题，收到了告警
- 每日报告正常发送（如果启用）
- 数据持续累积

✅ **Month 1**:
- 归档流程自动运行
- 旧数据被正确归档
- 存储增长得到控制
- 系统性能保持稳定

---

## 下一步

测试完成后，你可以：

1. **继续观察** - 让系统运行 1-2 周，收集真实数据
2. **调整参数** - 根据实际情况调整预算、归档天数等
3. **开始 Phase 3** - 集成 LLM 客户端和重试机制到现有代码

---

## 反馈收集

在测试期间，请记录：

- ✅ 哪些功能工作良好
- ❌ 遇到的任何问题
- 💡 发现的改进点
- 📊 实际的使用数据（成本、告警频率等）

这些反馈将帮助我们优化 Phase 3 的集成工作。

---

---

## Docker 常用命令参考

### 日常运维

```bash
# 查看服务状态
docker-compose ps

# 查看日志
docker-compose logs app --tail=100
docker-compose logs -f app  # 实时跟踪

# 重启服务
docker-compose restart app

# 停止所有服务
docker-compose down

# 启动所有服务
docker-compose up -d

# 重新构建并启动
docker-compose build app
docker-compose up -d
```

### 数据库操作

```bash
# 在容器内执行命令
docker-compose exec app npx prisma migrate status
docker-compose exec app npx prisma migrate deploy

# 进入 postgres 容器
docker-compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB

# 查看数据库大小
docker-compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT pg_size_pretty(pg_database_size('arkcore'));"
```

### 调试

```bash
# 进入 app 容器 shell
docker-compose exec app bash

# 查看容器资源使用
docker stats $(docker-compose ps -q app)

# 查看构建日志
docker-compose build --no-cache app

# 查看所有服务日志
docker-compose logs --tail=50
```

### 清理

```bash
# 清理未使用的镜像（慎用）
docker image prune -a

# 查看磁盘使用
docker system df
```

---

**祝部署顺利！** 🚀

如有任何问题，请随时提供日志和错误信息。
