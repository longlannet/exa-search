# exa-search

面向 OpenClaw 的 Exa 语义搜索 skill，通过 `mcporter` 调用 Exa MCP。

## 它能做什么

- 用自然语言做全网语义搜索
- 在文档、博客、GitHub、社区内容里找高相关页面
- 抓取指定 URL 的可读正文
- 作为深度阅读前的语义检索层

## 安装

```bash
bash scripts/install.sh
```

安装脚本现在会额外检查：

- 当前 shell 能否找到 `mcporter`
- `bash -lc` 这种 login shell 能否找到 `mcporter`

如果 login shell 找不到，安装脚本会自动把 PATH 补到：

- `~/.bashrc`
- `~/.profile`

然后再次验证。

## 校验

```bash
bash scripts/check.sh
```

`check.sh` 现在也会验证 login shell 是否能解析 `mcporter`。

## 常用命令

```bash
cd exa-search
mcporter list exa --schema
mcporter call exa.web_search_exa query:"OpenClaw 入门指南" numResults:5
mcporter call exa.web_fetch_exa 'urls:["https://openclaw.ai/"]' maxCharacters:4000
```

## 说明

- 请在 skill 根目录执行 `mcporter`，确保本地配置生效。
- 建议直接用自然语言提问，而不只是堆很短的关键词。
- 如果只是读取某个固定 URL 的简单正文，`web_fetch` 有时已经够用。
