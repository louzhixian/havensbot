# RUNBOOK

## References
- `agent.md`
- `docs/README.md`
- `DECISIONS.md`

## Start

```bash
sg docker -c "docker compose up -d --build"
```

## Stop

```bash
sg docker -c "docker compose down"
```

## Logs

```bash
sg docker -c "docker compose logs -f --tail 100"
```

## Verify

```bash
sg docker -c "bash scripts/verify.sh"
```

## Update
1. Pull latest changes or edit locally.
2. Rebuild and restart:

```bash
sg docker -c "docker compose up -d --build"
```

## Post-change checklist
1. Update `DECISIONS.md` if any decision changed.
2. Update `docs/features.md` for feature status/summary changes.
3. Update affected directory README Change Logs (see `agent.md`).
4. If infra/setup steps changed, update `docs/setup_log.md`.
5. Rebuild and restart:

```bash
sg docker -c "docker compose up -d --build"
```

6. Verify:

```bash
sg docker -c "bash scripts/verify.sh"
```

7. Commit changes:

```bash
git add -A
git commit -m "<summary>"
```

## Backup

```bash
sg docker -c "docker compose exec -T postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB" > backup.sql
```

## Restore

```bash
cat backup.sql | sg docker -c "docker compose exec -T postgres psql -U $POSTGRES_USER $POSTGRES_DB"
```

## Common issues
- Prisma auth errors: ensure `.env` has correct DB credentials and `DATABASE_URL` matches.
- Docker permission denied: run `exec su -l $USER` after adding yourself to docker group.
- No digests: confirm sources exist and cron times are in `TZ`.
- Editorial report not sent: confirm `EDITORIAL_CHANNEL_ID`, LLM config, and `DIGEST_CRON`; check app logs; run `/editorial status`.
- Editorial output empty: check `EDITORIAL_WINDOW_HOURS`, `EDITORIAL_MAX_ITEMS`, and whether items have `writing_suggestions`.
- Need to inspect raw suggestions: run `/editorial list` to review stored writing suggestions in a thread.
- To disable editorial suggestions, set `EDITORIAL_ENRICH_ENABLED=false`.
- Favorites not forwarding: confirm `FAV_CHANNEL_ID`, bot has access to the target channel, and Message Content + Reaction intents are enabled.
- Deep dive not generating: confirm `DEEPER_CHANNEL_ID`, LLM settings, and that the message contains an item URL.
- Editorial discussion not responding: confirm `EDITORIAL_CHANNEL_ID`, LLM config, and that the message was forwarded into the editorial channel.
- Editorial translation not responding: confirm `EDITORIAL_CHANNEL_ID`, LLM config, and that the message is a direct URL/text (not a forwarded message).
