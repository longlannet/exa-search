# Hermes native web backend with Exa (Hermes only)

Use this reference **only** when the user explicitly requests configuring Hermes Agent's built-in `web_search` / `web_extract`. It is a separate API-key integration, not an authentication mode for the anonymous MCP wrapper. Do not apply it to OpenClaw or place any key/header in this skill's `config/mcporter.json`.

## Safe configuration

- Load the `hermes-agent` skill and check the current official configuration/MCP docs before changing a live installation: <https://hermes-agent.nousresearch.com/docs/>.
- Resolve the active profile and its env-file path with `hermes config env-path`; do not assume the default profile or `/root/.hermes`.
- Have the operator provision `EXA_API_KEY` through the supported secret setup or a private editor. Never paste keys into chat, logs, summaries, skills, shell history, or example commands. Replace an existing entry instead of appending duplicates. Keep the file private (`0600` on Linux); do not source an entire dotenv file as shell code.
- After explicit authorization, the native-backend settings used in the observed Hermes installation were:

```bash
hermes config set web.backend exa
hermes config set web.search_backend exa
hermes config set web.extract_backend exa
```

Recheck support in the installed version. If new secrets require a reload, ask the user to start a fresh CLI or use their supported gateway restart action (for example `/restart`); do not restart the gateway from its own tool process or assume a particular systemd service layout.

## Verification pattern

Use the selected Hermes installation's own Python environment when inspecting internals; system Python can lack `httpx` and other dependencies. Discover its path instead of hardcoding a venv location. In the observed implementation, `tools.web_tools` exposed `check_web_api_key`, `_get_backend`, `_get_search_backend`, `_get_extract_backend`, and `web_search_tool`; these private names can change.

Verify only key-presence metadata and the resolved backend/search/extract values (`exa`), without printing credentials or the full environment. `hermes doctor` not reporting a missing search backend/API key proves readiness detection, not a successful request. With explicit permission for a quota-consuming probe, exercise Hermes's native search and extraction separately and inspect real results. Do not use anonymous MCP success as evidence that the native API-key backend is configured, or vice versa.

## Pricing/usage interpretation

A historically observed `20,000 requests per month` offer described API request count, not tokens, currency, or result count; it is **not a verified current allowance**. Search, extracted pages and additional results can use different billing units. Verify current Exa pricing and the account's entitlement before quoting a limit. Native API entitlements must not be attributed to the anonymous hosted MCP endpoint, which has no stable published numeric allowance in the upstream skill contract.
