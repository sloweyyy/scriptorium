---
feature: Webhook retry policy
---
# Webhook retry policy

Webhook deliveries that fail are retried with exponential backoff: after 1 minute, 5 minutes, 30 minutes and 2 hours. After the fourth failure the endpoint is marked unhealthy and the workspace owner is emailed.
