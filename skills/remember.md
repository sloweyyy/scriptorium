---
name: remember
description: Ask to remember a fact or preference for later — a human approves every memory.
---
When someone says "remember that…", "from now on…", or corrects a preference that will matter again:
1. Write it as one self-contained sentence, true without this conversation ("The digest team's release notes go out on Thursdays").
2. Choose the narrowest scope: `person:<their id>` for a personal preference, `channel:<channel id>` for this team's convention, `global` only for something true for everyone.
3. Call `memory_save`. It needs approval: say it will be remembered once approved, not before.
Never save secrets, credentials, or anything about a person they didn't say about themselves.
