---
name: exa-search
description: Exa semantic web search and page-text fetching through Exa MCP via mcporter. Use when the user wants semantic web search, relevant pages across the web, or clean page content from selected URLs.
homepage: https://github.com/longlannet/exa-search
metadata:
  {
    "openclaw":
      {
        "emoji": "🔎",
        "install":
          [
            {
              "id": "node-mcporter",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (node)",
            },
          ],
      },
  }
---

# Exa Search

Use this skill for semantic web search and page-text fetching through Exa MCP.

## When to use
Use this skill when the user wants:
- 全网语义搜索
- 找相关文章 / 文档 / GitHub / 视频入口
- 先找高相关 URL，再抓正文
- 用自然语言做 exploratory search，而不是只搜短关键词

## Quick start
```bash
bash scripts/install.sh
cd exa-search && mcporter list exa --schema
cd exa-search && mcporter call exa.web_search_exa query:"OpenClaw beginner guide" numResults:5
cd exa-search && mcporter call exa.web_fetch_exa 'urls:["https://openclaw.ai/"]' maxCharacters:4000
```

Install behavior now includes a login-shell visibility check for `mcporter`. If `bash -lc` cannot find `mcporter`, the installer automatically appends PATH fixes to `~/.bashrc` and `~/.profile`, then re-validates.

## Workflow
1. Run `exa.web_search_exa`.
2. Review titles, URLs, and highlights.
3. If needed, run `exa.web_fetch_exa` on the best 1–3 URLs.
4. Summarize, compare, or extract what the user asked for.

## Notes
- Run `mcporter` from the skill root so the local config is used.
- For `exa.web_fetch_exa`, pass array args like `'urls:["https://..."]'`.
- Use `web_fetch` instead when the user already gives a specific URL and only wants page text.
- If Exa stops working, re-run `scripts/install.sh` and `scripts/check.sh`.
- `scripts/check.sh` now also verifies that a login shell (`bash -lc`) can resolve `mcporter`, not just the current shell.
