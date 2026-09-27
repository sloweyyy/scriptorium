# Project page

A static page introducing scriptorium: `index.html` renders `data.js`. There is no build.

To update it, edit `data.js`: the stats (from `pnpm eval` and `pnpm mutate`), one timeline
entry per merged pull request, and new capabilities or review findings. Change `updated` too.
The Vercel project `scriptorium` deploys this folder, and merging to `main` publishes it.
