# Claude Code Instructions — Cult Command Center

## Git / Pushing to Railway

Before pushing any changes, always run `git pull origin main` first to pick up changes from any other active sessions. This prevents race conditions since Railway auto-deploys on every push.

```bash
git pull origin main
# then stage, commit, and push as normal
```
