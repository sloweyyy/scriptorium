---
feature: Rate-limit dashboard
---
# Rate-limit dashboard

The API dashboard shows requests per minute against the plan limit. The free plan allows 60 requests per minute; Team allows 600. When a key exceeds its limit the API answers 429 with a Retry-After header.
