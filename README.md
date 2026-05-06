# 订阅改名 Cloudflare Worker

这是一个可部署到 Cloudflare Workers 的订阅转换服务，支持 Workers KV 缓存、Cron 定时刷新、VMess/VLESS/Trojan/Shadowsocks 节点自动改名，并可输出 Base64 订阅、Clash YAML 和 Sing-box JSON。

## 文件说明

- `src/index.js`：ES Module Worker 源码。负责 HTTP 接口、Cron 定时刷新、KV 缓存、基础限流、Base64 解析、节点改名、Clash 转换和 Sing-box 转换。
- `wrangler.toml`：Worker 入口、KV 绑定、Cron Trigger 和非敏感默认配置。
- `.dev.vars.example`：本地开发环境变量模板。复制为 `.dev.vars` 后填写真实配置。
- `package.json`：Wrangler 开发、部署和语法检查脚本。

## 节点命名规则

Worker 会从节点的 host 或原始名称中识别线路编号，并自动改名：

- `s1` -> `US-CN2-GT-1`
- `s2` -> `US-CN2-GT-2`
- `s3` -> `US-CN2-GIA`
- `s4` -> `JP-Softbank`
- `s5` -> `NL-CN2-GIA`
- `s801` -> `US-0.1x`

对于 VMess 节点，会修改 `ps` 字段；如果原节点已经存在 `name` 字段，也会同步修改 `name`。对于 VLESS、Trojan 和 SS 节点，会修改 URI 中 `#` 后面的节点名。其他协议参数会原样保留在 Base64 订阅输出中。

## KV Key

- `raw_sub`：原始订阅响应内容。
- `converted_sub`：转换后的 Base64 订阅。
- `converted_clash`：缓存的 Clash YAML。
- `converted_singbox`：缓存的 Sing-box JSON。
- `updated_at`：最近一次成功刷新时间，格式为 ISO-8601 UTC。
- `converted_meta`：节点数量、不支持的节点数量和刷新元数据。

## HTTP API

- `GET /sub`：返回转换后的 Base64 订阅，内容类型为 `text/plain`。
- `GET /sub?target=clash`：返回 Clash 兼容 YAML。
- `GET /sub?target=singbox`：返回 Sing-box JSON。
- `GET /refresh?token=xxxx`：手动拉取原始订阅，并重建所有缓存。
- `GET /status`：返回缓存状态，不会泄露原始订阅地址。

`/refresh` 也支持通过请求头传 token：

```http
Authorization: Bearer xxxx
```

## 部署并创建 KV

```bash
npm install
npx wrangler login
npx wrangler deploy
npx wrangler kv namespace create SUB_KV
npx wrangler kv namespace create SUB_KV --preview
```

把命令返回的生产环境 `id` 和预览环境 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "SUB_KV"
id = "YOUR_PRODUCTION_KV_ID"
preview_id = "YOUR_PREVIEW_KV_ID"
```

## 配置密钥

不要把真实订阅 URL 或刷新 token 写入 `wrangler.toml`。

```bash
npx wrangler secret put ORIGIN_SUB_URL
npx wrangler secret put REFRESH_TOKEN
```

本地开发时执行：

```bash
cp .dev.vars.example .dev.vars
```

然后编辑 `.dev.vars`：

- `ORIGIN_SUB_URL`：你的原始订阅地址。
- `REFRESH_TOKEN`：用于 `/refresh` 的长随机 token。

## Cron 定时刷新

`wrangler.toml` 中已经配置：

```toml
[triggers]
crons = [ "0 4 * * *" ]
```

Cloudflare Cron Trigger 使用 UTC 时间。当前配置表示每天 UTC 04:00 执行一次，也就是北京时间 12:00。  
如果希望每天北京时间 04:00 刷新，可以改成：

```toml
[triggers]
crons = [ "0 20 * * *" ]
```

因为北京时间是 UTC+8，所以 UTC 20:00 对应次日北京时间 04:00。

## 本地调试

```bash
npm install
npm run dev
curl "http://localhost:8787/refresh?token=change-me-to-a-long-random-token"
curl "http://localhost:8787/sub"
curl "http://localhost:8787/sub?target=clash"
curl "http://localhost:8787/sub?target=singbox"
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"
```

说明：

- `npm run dev` 会执行 `wrangler dev --test-scheduled`。
- `http://localhost:8787/__scheduled?cron=0+4+*+*+*` 用于在本地模拟 Cron Trigger。
- 本地环境变量从 `.dev.vars` 读取。

## 部署

部署前先做语法检查：

```bash
npm run check
```

部署到 Cloudflare Workers：

```bash
npm run deploy
```

部署后可以测试：

```bash
curl "https://subscription-rename.YOUR_SUBDOMAIN.workers.dev/refresh?token=YOUR_TOKEN"
curl "https://subscription-rename.YOUR_SUBDOMAIN.workers.dev/sub"
curl "https://subscription-rename.YOUR_SUBDOMAIN.workers.dev/sub?target=clash"
curl "https://subscription-rename.YOUR_SUBDOMAIN.workers.dev/sub?target=singbox"
```

## 如何替换自己的订阅 URL

线上环境使用 Wrangler Secret：

```bash
npx wrangler secret put ORIGIN_SUB_URL
```

根据提示输入你的真实订阅 URL。该 URL 不会写入代码仓库，也不会在公开接口响应中返回。

本地环境修改 `.dev.vars`：

```env
ORIGIN_SUB_URL="https://example.com/your/raw/subscription"
REFRESH_TOKEN="change-me-to-a-long-random-token"
```

修改后重启 `npm run dev`。

## 安全说明

- 原始订阅 URL 只保存在 `ORIGIN_SUB_URL` secret 中。
- `/refresh` 必须提供正确的 `REFRESH_TOKEN`。
- 公共响应不会返回原始订阅 URL。
- `/sub`、`/status` 和 `/refresh` 都启用了基于 IP 的基础 KV 限流。
- `wrangler.toml` 中只保存非敏感配置和 KV namespace ID。KV namespace ID 不是订阅密钥，但仍建议只在项目配置中使用。

## 常见问题

### 为什么 `/sub` 第一次访问比较慢？

如果 KV 里还没有缓存，第一次访问 `/sub` 会自动拉取原始订阅并生成缓存。之后会直接读取 KV 缓存。

### VMess 为什么要双层 Base64？

原始订阅整体是 Base64；订阅内每个 `vmess://` 后面的 JSON 也是 Base64。Worker 会先解开订阅整体 Base64，再逐个解开 VMess JSON，改名后重新编码 VMess，最后再把整个订阅重新 Base64 编码。

### Clash 和 Sing-box 输出是否会完全覆盖所有高级协议参数？

Base64 订阅输出会尽量保留原始 URI 参数。Clash 和 Sing-box 输出会转换常见参数，例如 TLS、Reality、WebSocket、gRPC、HTTP/H2 等。不同客户端支持的字段略有差异，如遇到特殊参数，可以在 `src/index.js` 中扩展对应转换函数。
