# Feature Prioritizer Skill

When prioritizing features, use ICE scoring:

- **Impact** (1-10): How much will this move the needle?
- **Confidence** (1-10): How sure are we about the impact?
- **Ease** (1-10): How easy is this to implement?

ICE Score = (Impact + Confidence + Ease) / 3

Output a ranked table:
| Feature | Impact | Confidence | Ease | ICE Score | Priority |
Sort by ICE score descending. Top 3 = build now, middle = next quarter, bottom = backlog.
