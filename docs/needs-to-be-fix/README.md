# needs-to-be-fix index

Total count: 183

(`find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' ! -name 'README.md' ! -name 'high.md' ! -name 'medium.md' ! -name 'low.md' ! -name 'baseline-unreachable.md' ! -name 'orphan.md' | wc -l` returns 183)

Split into per-severity files for easier back-annotation:

- [High](high.md) — 11 rows
- [Medium](medium.md) — 19 rows
- [Low](low.md) — 30 rows
- [Baseline unreachable addenda](baseline-unreachable.md) — 99 rows
- [Orphan addenda](orphan.md) — 24 rows

11 + 19 + 30 + 99 + 24 = 183