# exa-search

Semantic web search and page-text fetching through Exa MCP via `mcporter`.

## What it does

- search the web with natural-language intent
- find relevant pages across docs, blogs, GitHub, and communities
- fetch readable page text from selected URLs
- work as a semantic-search layer before deeper reading

## Install

```bash
bash scripts/install.sh
```

## Validate

```bash
bash scripts/check.sh
```

## Quick commands

```bash
cd exa-search
mcporter list exa --schema
mcporter call exa.web_search_exa query:"OpenClaw beginner guide" numResults:5
mcporter call exa.web_fetch_exa 'urls:["https://openclaw.ai/"]' maxCharacters:4000
```

## Notes

- Run `mcporter` from the skill root so the local config is used.
- Use natural-language queries, not only short keywords.
- For a specific URL with simple readable text needs, `web_fetch` may be enough.
