# Voice-to-Text Feature Design

## Overview

Add voice message transcription and text polishing to the Editorial Channel. When users send voice messages, the bot automatically transcribes them using Whisper, polishes the text with LLM, and posts a clean draft in a thread.

## Requirements

- **Trigger**: Voice messages in `EDITORIAL_CHANNEL_ID` only
- **Transcription**: Whisper service running on Mac, accessible via Tailscale
- **Text Polishing**: Use existing LLM to remove filler words, repetition, and verbal tics while preserving personal tone
- **Output**: Create thread with polished draft only (hide raw transcript)
- **Status Feedback**: Add ⏳ reaction during processing, update to ✅ on success or ❌ on failure
- **Retry**: Auto-retry on Whisper failures, plus manual retry via 🔄 reaction

## Architecture

### Components

**1. Mac Whisper Service:**
- Docker container: `onerahmet/openai-whisper-asr-webservice`
- Listen on port 9000
- Accessible from VPS via Tailscale MagicDNS: `http://mac-hostname:9000`
- Model: `medium` (recommended for quality/speed balance)

**2. ArkCore Modules:**
```
src/voice/
  types.ts              // Type definitions
  whisperClient.ts      // Whisper API client
  textPolisher.ts       // LLM text polishing logic
  voiceHandler.ts       // Main processing flow
  retryCache.ts         // Retry record cache
```

**3. Configuration (.env):**
```bash
VOICE_TO_TEXT_ENABLED=true
WHISPER_API_URL=http://mac-hostname.tail-scale.ts.net:9000
WHISPER_TIMEOUT_MS=60000
WHISPER_MAX_RETRIES=2
```

## Data Flow

### Normal Flow
1. User sends voice message in Editorial Channel
2. Bot detects audio attachment
3. Add ⏳ reaction immediately
4. Download audio file to temp directory
5. Call Whisper API to transcribe (with auto-retry)
6. Call LLM to polish transcript
7. Create thread with polished draft
8. Update reaction to ✅
9. Clean up temp file

### Whisper API Call
```
POST /asr?encode=true&task=transcribe&language=zh&word_timestamps=false
Content-Type: multipart/form-data
Body: audio_file

Response: { "text": "转录结果..." }
```

### LLM Polishing Prompt
```
你是一个文本整理助手。请将以下语音转录文本整理成清晰的书面文字：
- 去掉口语化表达、语气词、重复内容
- 保持说话者的个人语气和表达习惯
- 不要添加原文没有的内容
- 输出整理后的草稿即可，无需其他说明

转录原文：
{transcribed_text}
```

## Error Handling

### Whisper API Failures
- **Auto-retry**: 2 retries with exponential backoff (3s, 6s)
- **Final failure**: Update reaction to ❌, create thread with error message
- **Manual retry**: Add 🔄 reaction in error thread, listen for user click

### LLM Failures
- **Graceful degradation**: Post raw transcript with note "整理失败，以下是转录原文"
- Use existing `callWithFallback` retry mechanism

### Discord API Failures
- Use existing retry logic (`callWithFallback`) for thread creation and reactions

### File Download Failures
- Timeout: 10 seconds
- Failure: ❌ reaction + error message

### Timeout Settings
- Whisper API: 60s
- LLM polishing: 30s
- File download: 10s

## Retry Mechanism

### Auto-Retry
```typescript
async function transcribeWithRetry(audioFile: Buffer): Promise<string> {
  const maxRetries = 2;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await callWhisperAPI(audioFile);
    } catch (error) {
      if (i === maxRetries) throw error;
      await sleep(3000 * (i + 1)); // 3s, 6s
    }
  }
}
```

### Manual Retry
- **Trigger**: User clicks 🔄 on error message posted by bot
- **Cache**: Store failed message metadata in memory (1 hour TTL)
- **Limit**: Max 3 manual retries per voice message
- **Implementation**:
  - Monitor `messageReactionAdd` event
  - Verify: reaction is 🔄, message author is bot, user is original sender
  - Retrieve audio URL from cache, reprocess

### Retry Cache
```typescript
interface RetryRecord {
  messageId: string;
  audioUrl: string;
  attempts: number;
  timestamp: number;
}

class RetryCache {
  private cache = new Map<string, RetryRecord>();

  set(messageId: string, record: RetryRecord): void;
  get(messageId: string): RetryRecord | undefined;
  canRetry(messageId: string): boolean; // Check < 3 attempts
  cleanup(): void; // Remove records older than 1 hour
}
```

## Resource Management

### Temporary Files
- **Storage**: `/tmp/arkcore-voice/` or `os.tmpdir()`
- **Naming**: `${messageId}-${timestamp}.${ext}`
- **Cleanup**: Delete in `finally` block, ensure cleanup on all paths

### Concurrency
- No explicit limits on ArkCore side
- Whisper container handles its own concurrency
- Can add queue/semaphore later if needed

### Security
- **Whisper API**: Only accessible via Tailscale, no public exposure
- **File size**: Check `attachment.size` before download (optional 50MB threshold)
- **LLM prompt injection**: System/user role separation, safe for text polishing task

### Logging
- Log each processing step: download, transcribe, polish, publish
- Log Whisper API response time
- Use existing Winston logger

## Deployment

### Mac Setup
```bash
docker run -d \
  --name whisper-service \
  -p 9000:9000 \
  -e ASR_MODEL=medium \
  -e ASR_ENGINE=openai_whisper \
  onerahmet/openai-whisper-asr-webservice:latest

# Health check
curl http://localhost:9000/health
```

### VPS Setup
1. Verify Tailscale connectivity: `curl http://mac-hostname:9000/health`
2. Update `.env` with `WHISPER_API_URL`
3. Rebuild and restart: `docker compose up -d --build`
4. Test in Editorial Channel

### Dependencies
- `form-data` (or use existing HTTP client for multipart uploads)
- Existing: `axios` or similar HTTP client

## Code Structure

### Core Interfaces
```typescript
// types.ts
interface VoiceProcessingResult {
  success: boolean;
  polishedText?: string;
  error?: string;
}

interface RetryRecord {
  messageId: string;
  audioUrl: string;
  attempts: number;
  timestamp: number;
}
```

### Main Functions
```typescript
// voiceHandler.ts
async function handleVoiceMessage(
  message: Message,
  attachment: Attachment
): Promise<void>

// whisperClient.ts
async function transcribe(audioBuffer: Buffer): Promise<string>

// textPolisher.ts
async function polishTranscript(text: string): Promise<string>

// retryCache.ts
class RetryCache {
  set(messageId: string, record: RetryRecord): void
  get(messageId: string): RetryRecord | undefined
  canRetry(messageId: string): boolean
}
```

### Integration Point
```typescript
// src/handlers/messageHandler.ts
if (message.channelId === EDITORIAL_CHANNEL_ID) {
  const voiceAttachment = message.attachments.find(
    att => att.contentType?.startsWith('audio/')
  );
  if (voiceAttachment) {
    await handleVoiceMessage(message, voiceAttachment);
    return; // Don't process further
  }
}
```

## Testing

### Unit Tests
- `whisperClient.ts` - mock API responses (success, failure, timeout)
- `textPolisher.ts` - mock LLM calls
- `retryCache.ts` - cache operations, TTL expiration

### Integration Tests
- End-to-end: send test audio → verify thread creation and content
- Use 5-second test audio sample
- Mock Discord API responses

### Manual Testing Checklist
- [ ] Normal flow: voice → ⏳ → thread → ✅
- [ ] Auto-retry: simulate Whisper unavailable → retries → ❌
- [ ] Manual retry: click 🔄 → reprocess
- [ ] Edge cases: very short/long audio, non-Chinese audio
- [ ] LLM failure: verify graceful degradation to raw transcript
- [ ] Concurrent messages: send multiple voices quickly

## Future Enhancements

Not included in initial implementation:
1. Multi-language auto-detection
2. Optional raw transcript output (config toggle)
3. Custom polishing styles (user-configurable prompts)
4. Voice message statistics/analytics
5. Support for additional channels (multi-channel config)

## Monitoring

- Success/failure rate per day
- Whisper API latency percentiles
- Processing time breakdown (download, transcribe, polish, publish)
- Retry attempt distribution
