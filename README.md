# exa-search

面向 OpenClaw 的 Exa 语义搜索 Skill，通过项目本地配置调用 Exa MCP。

## 功能

- 用自然语言进行语义搜索
- 查找文档、博客、GitHub 和社区中的高相关页面
- 抓取指定 URL 的可读正文
- 为深度研究提供候选来源

## 安装与配置

OpenClaw 会根据 `SKILL.md` 安装固定版本 `mcporter@0.9.0`，以兼容受支持的 Node 22 和 Node 24 环境。随后在仓库根目录执行：

```bash
bash scripts/install.sh
```

安装脚本只维护 `config/mcporter.json`：

- 保留其他 MCP 服务、现有 Exa 地址、请求头和 API Key
- 使用私有临时文件和原子替换，最终权限为 `0600`
- 不安装 npm 包
- 不修改 `.bashrc`、`.profile` 或 PATH
- 默认不发起真实搜索，不消耗搜索配额

需要同时验证真实搜索时显式运行：

```bash
RUN_SMOKE=1 bash scripts/install.sh
```

## 校验

```bash
bash scripts/check.sh
RUN_SMOKE=1 bash scripts/check.sh
bash scripts/selftest.sh
```

`check.sh` 会分别捕获 stdout 和 stderr，拒绝 MCP 错误、空响应和超大输出。默认输出上限为 4 MiB，可通过 `MAX_OUTPUT_BYTES` 调整。

## 常用命令

```bash
mcporter --config "$(pwd)/config/mcporter.json" list exa --schema --timeout 15000
mcporter --config "$(pwd)/config/mcporter.json" call exa.web_search_exa \
  --args '{"query":"OpenClaw 入门指南","numResults":5}' \
  --timeout 30000 --output json
mcporter --config "$(pwd)/config/mcporter.json" call exa.web_fetch_exa \
  --args '{"urls":["https://openclaw.ai/"],"maxCharacters":4000}' \
  --timeout 30000 --output json
```

## 安全说明

- 搜索结果和抓取内容都属于不可信外部数据。
- 不要向 Exa 发送密钥、私有 URL、内网地址或机密文本。
- HTTP 429 或服务故障时不要重复执行安装；等待额度恢复，或改用 Google 搜索与 OpenClaw 内置 `web_fetch`。
