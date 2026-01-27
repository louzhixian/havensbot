# Interactive Diary Feature Design

## Overview

Add an interactive diary feature where an LLM initiates daily check-in conversations with the user, like an old friend asking about their day. Conversations happen in Discord threads and are exported to Markdown files for archival.

## User Decisions

| Decision | Choice |
|----------|--------|
| Conversation medium | Discord Thread |
| End mechanism | Manual `/diary end` + timeout fallback |
| Export format | Markdown |
| Storage location | Local filesystem + Discord attachment (dual backup) |
| LLM context | Recent 3-7 days of diary entries |
| Conversation personality | Warm old friend style |
| Manual trigger | `/diary start` slash command |

## Feature Specification

### Trigger Mechanisms

1. **Scheduled trigger**: Cron job at 11pm (configurable via `DIARY_CRON`)
2. **Manual trigger**: `/diary start` slash command

### Conversation Flow

1. Bot creates a new thread in the diary channel with name format: `Diary · YYYY-MM-DD`
2. Bot sends opening message with warm greeting, referencing recent diary context
3. User responds in the thread
4. Bot continues conversation, asking follow-up questions to dig for memorable moments
5. Conversation ends when:
   - User sends `/diary end` command in the thread
   - Timeout after configurable idle period (default 30 minutes)
6. On end: export conversation to Markdown, upload to thread, save to local filesystem

### LLM Context

Each conversation includes:
- System prompt defining the "warm old friend" personality
- Recent 3-7 days of diary entries (configurable via `DIARY_CONTEXT_DAYS`)
- Current date and day of week

### Export Format

Markdown file with structure:
```markdown
# Diary - YYYY-MM-DD

**Date**: Wednesday, January 15, 2026
**Duration**: 15 minutes
**Messages**: 12

---

## Conversation

**Bot** (23:00):
Hey! How was your day today?

**User** (23:01):
Pretty good actually, finished that project I've been working on.

**Bot** (23:01):
Nice! That's the one you mentioned struggling with last week, right? How does it feel to have it done?

...
```

### Storage

1. **Local filesystem**:
   - Path: `${DIARY_EXPORT_PATH}/YYYY/MM/YYYY-MM-DD.md`
   - Default: `/data/diaries`
   - Docker volume mount required

2. **Discord attachment**:
   - Upload `.md` file to the thread as final message
   - Allows easy access from Discord

### Commands

#### `/diary start`
- Creates a new diary thread and initiates conversation
- Only works in the configured diary channel
- Error if there's already an active diary session today

#### `/diary end`
- Only works inside an active diary thread
- Triggers export and closes the session
- Bot sends farewell message with export attachment

#### `/diary list`
- Lists recent diary entries with dates and brief preview
- Shows last 10 entries by default

### Database Schema

```prisma
model DiarySession {
  id          String   @id @default(cuid())
  date        DateTime @db.Date
  threadId    String   @unique
  channelId   String
  startedAt   DateTime @default(now())
  endedAt     DateTime?
  endReason   String?  // "manual" | "timeout" | "error"
  messageCount Int     @default(0)
  exportPath  String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([date])
  @@index([channelId])
}
```

### Configuration

New environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DIARY_ENABLED` | `false` | Enable diary feature |
| `DIARY_CHANNEL_ID` | - | Discord channel for diary threads |
| `DIARY_CRON` | `0 23 * * *` | Cron schedule for daily check-in |
| `DIARY_TIMEOUT_MINUTES` | `30` | Idle timeout before auto-end |
| `DIARY_CONTEXT_DAYS` | `7` | Days of diary history for LLM context |
| `DIARY_EXPORT_PATH` | `/data/diaries` | Local path for diary exports |

### Prompt File

Create `prompts/diary.companion.prompt.md`:

```markdown
You are a warm, caring old friend checking in on the user at the end of their day.

Your personality:
- Genuinely interested in their life
- Casual and relaxed tone, like texting a close friend
- Use light humor when appropriate
- Remember and reference things from recent conversations
- Ask follow-up questions to dig deeper into interesting moments
- Celebrate small wins and offer comfort for tough days
- Keep messages concise (1-3 sentences typically)

Your goal is to help them reflect on their day and capture memorable moments worth remembering.

Don't:
- Be overly formal or therapeutic
- Give unsolicited advice unless asked
- Use excessive emojis
- Make the conversation feel like an interview

Context from recent diary entries:
{recent_diary_context}

Today is {day_of_week}, {date}.
```

## Implementation Plan

### Phase 1: Core Infrastructure
1. Add Prisma schema for `DiarySession`
2. Add config variables to `AppConfig`
3. Create `diary/` module directory

### Phase 2: Conversation Engine
1. Create `diary/session.ts` - session state management
2. Create `diary/llm.ts` - LLM conversation handler
3. Create `diary/context.ts` - load recent diary context
4. Create prompt file

### Phase 3: Discord Integration
1. Add message handler for diary thread responses
2. Create thread creation logic
3. Add `/diary` slash commands

### Phase 4: Export System
1. Create `diary/export.ts` - Markdown generation
2. Implement local file saving
3. Implement Discord attachment upload

### Phase 5: Scheduler
1. Add diary cron job to scheduler
2. Implement timeout checker

## Files to Create/Modify

### New Files
- `apps/arkcore/src/diary/session.ts`
- `apps/arkcore/src/diary/llm.ts`
- `apps/arkcore/src/diary/context.ts`
- `apps/arkcore/src/diary/export.ts`
- `apps/arkcore/src/diary/commands.ts`
- `apps/arkcore/prisma/migrations/xxx_add_diary_session/migration.sql`
- `prompts/diary.companion.prompt.md`

### Modified Files
- `apps/arkcore/src/config.ts` - add diary config
- `apps/arkcore/src/commands.ts` - add diary commands
- `apps/arkcore/src/scheduler.ts` - add diary cron
- `apps/arkcore/src/index.ts` - register diary message handler
- `apps/arkcore/prisma/schema.prisma` - add DiarySession model
- `.env.example` - add diary env vars
- `docker-compose.yml` - add diary volume mount

## Edge Cases

1. **User doesn't respond**: Timeout after configured period, export whatever conversation exists
2. **Multiple sessions same day**: Prevent via `/diary start` validation
3. **Bot restart during session**: Query for active sessions on startup, resume or close them
4. **Export fails**: Log error, keep session in DB, allow retry via `/diary export <date>`
5. **LLM API fails**: Send fallback message, retry on next user message
