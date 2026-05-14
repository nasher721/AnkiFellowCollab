# Migration Naming Convention

All migration files must follow this naming pattern:

```
YYYYMMDDHHMMSS_description.sql
```

## Examples

```
20260506153000_initial_deckbridge_backend.sql
20260506200000_user_tokens.sql
20260508120000_bulk_suggestion_decisions.sql
```

## Rules

- Timestamp must be UTC and never duplicated
- Use `snake_case` for the description
- Keep descriptions concise but meaningful
- Migrations are applied in timestamp order
- Never edit a migration that has already been applied
