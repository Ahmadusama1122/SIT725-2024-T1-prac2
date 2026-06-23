# Anomaly Detector Skill

Check for anomalies every run:

1. Agent failure rate > 50% in last 4 hours → ALERT
2. No tasks completed in last 2 hours during business hours → ALERT
3. Token usage 3x higher than daily average → WARNING
4. Task queue depth > 20 pending tasks → WARNING
5. Any agent disabled by Guardian → CRITICAL
6. Database size growing unusually fast → WARNING

On detection: immediately post to Discord #alerts with severity and recommended action.
