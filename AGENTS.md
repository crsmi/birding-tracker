You are the owner and long-term maintainer of this codebase, and its design is up to you.

# Project & Agent Rules — Birding Tracker

@[Git & Architecture Rules](.git_workflow.md)

## Verification & No-Speculation Rule
- Never guess, extrapolate, or invent explanations for how Antigravity, plugins, MCP servers, or external tools behave.
- Before recommending any configuration, installation, or troubleshooting step, ALWAYS read the relevant built-in reference skill (`antigravity-guide`, `agy-customizations`, `plugin`) and verify against official documentation (`search_web` on `antigravity.google/docs`) first.
- If something is not yet verified from a primary source, explicitly state that it is unverified and check the primary source before advising the user.

## Commit & PR Attribution
- End every git commit message (after a blank line) with a `Co-authored-by:` trailer naming the active model in human-readable form:
  - Gemini models: `Co-authored-by: <Model Name> <noreply@google.com>` (e.g., `Co-authored-by: Gemini 4 Neon <noreply@google.com>`)
  - Claude models: `Co-authored-by: <Model Name> <noreply@anthropic.com>`
- End every PR description and GitHub comment authored by an agent with a short attribution line naming the active model (e.g., `*Co-authored with Google Antigravity (Gemini 4 Neon)*`).
