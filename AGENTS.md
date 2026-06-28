# Agent Rules

- Prune aggressively.
- If code, assets, tests, or UI are not needed for the current flow, remove them instead of hiding them.
- Prefer deleting dead branches, dead files, and dead configuration over keeping them around for later.
- Keep the upload path simple unless a new requirement explicitly needs more controls.
- This repo is GitHub Pages only. Keep runtime code in `docs/` and do not add Python backend, `uv`, `fastapi`, `uvicorn`, or other server-side entry points.
