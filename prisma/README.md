# Prisma

## Purpose
Database schema and migrations for ArkCore.

## Key Files
- `prisma/schema.prisma`: data model and datasource configuration.
- `prisma/migrations/migration_lock.toml`: migration metadata.
- `prisma/migrations/20251222223713_init/migration.sql`: initial migration SQL.

## Conventions
- Use Prisma migrations for schema changes; avoid manual edits to generated SQL unless necessary.
- Keep schema and migrations in sync with app expectations.
- Update this README Change Log when schema or migrations change.

## Change Log
- 2026-01-03: add directory README and conventions (files: prisma/README.md) impact: doc
- 2026-01-03: add editorial enrichment/report fields (files: prisma/schema.prisma, prisma/migrations/20260103063007_editorial/migration.sql) impact: schema
- 2026-01-04: add deep dive fields (files: prisma/schema.prisma, prisma/migrations/20260104013000_deep_dive/migration.sql) impact: schema

## References
- `agent.md`
- `docs/templates/directory_readme_template.md`
