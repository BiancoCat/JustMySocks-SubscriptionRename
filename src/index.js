const KV_KEYS = Object.freeze({
  raw: "raw_sub",
  converted: "converted_sub",
  clash: "converted_clash",
  singbox: "converted_singbox",
  updatedAt: "updated_at",
  meta: "converted_meta"
});

const LINE_NAME_MAP = Object.freeze({
  s1: "US-CN2-GT-1",
  s2: "US-CN2-GT-2",
  s3: "US-CN2-GIA",
  s4: "JP-Softbank",
  s5: "NL-CN2-GIA",
  s801: "US-0.1x"
});

const DEFAULT_CACHE_TTL_SECONDS = 300;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
const DEFAULT_REFRESH_RATE_LIMIT_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

const COMMON_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "X-Content-Type-Options": "nosniff"
});

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.publicMessage = message;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return handleError(error);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      updateSubscription(env, {
        reason: "cron",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime
      }).catch((error) => {
        console.error("Scheduled subscription update failed:", safeErrorMessage(error));
      })
    );
  }
};

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: COMMON_HEADERS });
  }

  if (request.method !== "GET") {
    throw new AppError(405, "Method not allowed");
  }

  assertKv(env);
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/help") {
    return helpResponse();
  }

  if (url.pathname === "/status") {
    await applyRateLimit(request, env, "status", readInt(env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE));
    return statusResponse(env);
  }

  if (url.pathname === "/sub") {
    await applyRateLimit(request, env, "sub", readInt(env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE));
    return subscriptionResponse(url, env);
  }

  if (url.pathname === "/refresh") {
    await applyRateLimit(
      request,
      env,
      "refresh",
      readInt(env.REFRESH_RATE_LIMIT_PER_MINUTE, DEFAULT_REFRESH_RATE_LIMIT_PER_MINUTE)
    );
    return refreshResponse(request, url, env);
  }

  throw new AppError(404, "Not found");
}

function helpResponse() {
  return textResponse(
    [
      "Subscription Rename Worker",
      "",
      "GET /sub                       Base64 subscription",
      "GET /sub?target=clash          Clash YAML",
      "GET /sub?target=singbox        Sing-box JSON",
      "GET /refresh?token=TOKEN       Refresh cache from origin",
      "GET /status                    Cache status"
    ].join("\n"),
    {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    }
  );
}

async function statusResponse(env) {
  const [updatedAt, meta, converted] = await Promise.all([
    env.SUB_KV.get(KV_KEYS.updatedAt),
    env.SUB_KV.get(KV_KEYS.meta),
    env.SUB_KV.get(KV_KEYS.converted)
  ]);

  return jsonResponse({
    cached: Boolean(converted),
    updated_at: updatedAt || null,
    meta: parseJsonOrNull(meta)
  });
}

async function subscriptionResponse(url, env) {
  const target = normalizeTarget(url.searchParams.get("target"));
  const cached = await getCachedPayload(env, target);
  const cacheTtl = readInt(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS);

  const headers = {
    "Cache-Control": `public, max-age=${cacheTtl}`,
    "X-Updated-At": cached.updatedAt || "",
    "X-Subscription-Target": target
  };

  if (target === "clash") {
    headers["Content-Type"] = "application/yaml; charset=utf-8";
  } else if (target === "singbox") {
    headers["Content-Type"] = "application/json; charset=utf-8";
  } else {
    headers["Content-Type"] = "text/plain; charset=utf-8";
  }

  return textResponse(cached.payload, headers);
}

async function refreshResponse(request, url, env) {
  assertOrigin(env);
  const token = url.searchParams.get("token") || readBearerToken(request);

  if (!env.REFRESH_TOKEN) {
    throw new AppError(500, "Refresh token is not configured");
  }

  if (!timingSafeEqual(token || "", env.REFRESH_TOKEN)) {
    throw new AppError(403, "Forbidden");
  }

  const converted = await updateSubscription(env, { reason: "manual" });
  return jsonResponse({
    ok: true,
    updated_at: converted.updatedAt,
    node_count: converted.nodeCount,
    unsupported_count: converted.unsupportedCount,
    errors: converted.errors
  });
}

async function getCachedPayload(env, target) {
  const targetKey = targetToKvKey(target);
  let [payload, updatedAt] = await Promise.all([
    env.SUB_KV.get(targetKey),
    env.SUB_KV.get(KV_KEYS.updatedAt)
  ]);

  if (payload) {
    return { payload, updatedAt };
  }

  const raw = await env.SUB_KV.get(KV_KEYS.raw);
  if (raw) {
    const rebuilt = convertSubscription(raw, { updatedAt: updatedAt || nowIso() });
    await writeConvertedCache(env, rebuilt, { rawSub: raw, reason: "target-cache-miss" });
    return {
      payload: selectPayload(rebuilt, target),
      updatedAt: rebuilt.updatedAt
    };
  }

  const refreshed = await updateSubscription(env, { reason: "cache-miss" });
  return {
    payload: selectPayload(refreshed, target),
    updatedAt: refreshed.updatedAt
  };
}

async function updateSubscription(env, details = {}) {
  assertKv(env);
  assertOrigin(env);

  const response = await fetch(env.ORIGIN_SUB_URL, {
    method: "GET",
    headers: {
      "Accept": "text/plain, application/octet-stream, */*",
      "User-Agent": "subscription-rename-worker/1.0"
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false
    }
  });

  if (!response.ok) {
    throw new AppError(502, `Origin subscription fetch failed with HTTP ${response.status}`);
  }

  const rawSub = await response.text();
  if (!rawSub.trim()) {
    throw new AppError(502, "Origin subscription is empty");
  }

  const converted = convertSubscription(rawSub, { updatedAt: nowIso() });
  await writeConvertedCache(env, converted, { rawSub, reason: details.reason || "unknown", cron: details.cron });
  return converted;
}

async function writeConvertedCache(env, converted, details = {}) {
  const meta = {
    updated_at: converted.updatedAt,
    node_count: converted.nodeCount,
    unsupported_count: converted.unsupportedCount,
    errors: converted.errors,
    reason: details.reason || "unknown",
    cron: details.cron || null
  };

  const writes = [
    env.SUB_KV.put(KV_KEYS.converted, converted.convertedSub),
    env.SUB_KV.put(KV_KEYS.clash, converted.clashYaml),
    env.SUB_KV.put(KV_KEYS.singbox, converted.singboxJson),
    env.SUB_KV.put(KV_KEYS.updatedAt, converted.updatedAt),
    env.SUB_KV.put(KV_KEYS.meta, JSON.stringify(meta))
  ];

  if (details.rawSub !== undefined) {
    writes.push(env.SUB_KV.put(KV_KEYS.raw, details.rawSub));
  }

  await Promise.all(writes);
}

function convertSubscription(rawSub, options = {}) {
  const updatedAt = options.updatedAt || nowIso();
  const decodedText = decodeSubscriptionBody(rawSub);
  const lines = decodedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items = lines.map((line) => parseNodeLine(line));
  const outputLines = items.map((item) => item.url);
  const errors = items
    .filter((item) => item.error)
    .slice(0, 20)
    .map((item) => item.error);

  return {
    convertedSub: encodeUtf8ToBase64(outputLines.join("\n")),
    clashYaml: buildClashYaml(items, updatedAt),
    singboxJson: JSON.stringify(buildSingBoxConfig(items, updatedAt), null, 2),
    updatedAt,
    nodeCount: items.filter((item) => item.supported).length,
    unsupportedCount: items.filter((item) => !item.supported).length,
    errors
  };
}

function parseNodeLine(line) {
  const lower = line.toLowerCase();

  try {
    if (lower.startsWith("vmess://")) {
      return parseVmessNode(line);
    }

    if (lower.startsWith("vless://")) {
      return parseUrlNode(line, "vless");
    }

    if (lower.startsWith("trojan://")) {
      return parseUrlNode(line, "trojan");
    }

    if (lower.startsWith("ss://")) {
      return parseSsNode(line);
    }

    return unsupportedNode(line, "Unsupported protocol");
  } catch (error) {
    return unsupportedNode(line, safeErrorMessage(error));
  }
}

function parseVmessNode(line) {
  const encoded = line.slice("vmess://".length).trim();
  const jsonText = decodeBase64ToUtf8(encoded);
  const vmess = JSON.parse(jsonText);

  const oldName = stringifyValue(vmess.ps || vmess.name);
  const host = normalizeHost(vmess.add || vmess.host || extractHostFromText(oldName));
  const newName = resolveNodeName(host, oldName);

  if (newName) {
    vmess.ps = newName;
    if (Object.prototype.hasOwnProperty.call(vmess, "name")) {
      vmess.name = newName;
    }
  }

  const displayName = stringifyValue(vmess.ps || vmess.name || oldName || host || "vmess");
  const renamedUrl = `vmess://${encodeUtf8ToBase64(JSON.stringify(vmess))}`;

  return {
    supported: true,
    type: "vmess",
    url: renamedUrl,
    name: displayName,
    host,
    vmess
  };
}

function parseUrlNode(line, protocol) {
  const parsed = new URL(line);
  const host = normalizeHost(parsed.hostname);
  const port = toPort(parsed.port, defaultPort(protocol, parsed.searchParams));
  const oldName = safeDecodeURIComponent(parsed.hash ? parsed.hash.slice(1) : "");
  const newName = resolveNodeName(host, oldName);
  const displayName = newName || oldName || host || protocol;
  const renamedUrl = newName ? replaceFragment(line, displayName) : line;

  return {
    supported: true,
    type: protocol,
    url: renamedUrl,
    name: displayName,
    host,
    port,
    user: safeDecodeURIComponent(parsed.username),
    params: parsed.searchParams
  };
}

function parseSsNode(line) {
  const fragmentParts = splitFragment(line);
  const oldName = safeDecodeURIComponent(fragmentParts.fragment);
  const base = fragmentParts.base;
  const queryIndex = base.indexOf("?");
  const noQuery = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const query = queryIndex >= 0 ? base.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);
  const rest = noQuery.slice("ss://".length);

  let decodedUserInfo = "";
  let hostPort = "";

  if (rest.includes("@")) {
    const at = rest.lastIndexOf("@");
    decodedUserInfo = decodeSsUserInfo(rest.slice(0, at));
    hostPort = rest.slice(at + 1);
  } else {
    const decoded = decodeBase64ToUtf8(rest);
    const at = decoded.lastIndexOf("@");
    if (at < 0) {
      throw new Error("Invalid Shadowsocks URI");
    }
    decodedUserInfo = decoded.slice(0, at);
    hostPort = decoded.slice(at + 1);
  }

  const separator = decodedUserInfo.indexOf(":");
  if (separator < 0) {
    throw new Error("Invalid Shadowsocks user info");
  }

  const method = decodedUserInfo.slice(0, separator);
  const password = decodedUserInfo.slice(separator + 1);
  const endpoint = parseHostPort(hostPort);
  const newName = resolveNodeName(endpoint.host, oldName);
  const displayName = newName || oldName || endpoint.host || "ss";
  const renamedUrl = newName ? replaceFragment(line, displayName) : line;

  return {
    supported: true,
    type: "ss",
    url: renamedUrl,
    name: displayName,
    host: endpoint.host,
    port: endpoint.port,
    ss: {
      method,
      password,
      params
    }
  };
}

function unsupportedNode(line, message) {
  return {
    supported: false,
    type: "unknown",
    url: line,
    name: "",
    error: message
  };
}

function resolveNodeName(host, oldName) {
  const code = findLineCode(host, oldName);
  return code ? LINE_NAME_MAP[code] : "";
}

function findLineCode(host, oldName) {
  const source = `${host || ""} ${oldName || ""}`.toLowerCase();
  const match = source.match(/s(801|[1-5])(?=\.|:|@|$|-|_)/i);
  return match ? `s${match[1]}` : "";
}

function extractHostFromText(text) {
  const atMatch = String(text || "").match(/@([^:/\s]+)(?::\d+)?/);
  if (atMatch) {
    return atMatch[1];
  }

  const hostMatch = String(text || "").match(/((?:c?\d+)?s(?:801|[1-5])\.[^\s:@]+)/i);
  return hostMatch ? hostMatch[1] : "";
}

function decodeSubscriptionBody(rawSub) {
  const text = stripBom(String(rawSub || "").trim());
  if (containsNodeUrl(text)) {
    return text;
  }

  const compact = text.replace(/\s+/g, "");
  try {
    const decoded = stripBom(decodeBase64ToUtf8(compact).trim());
    if (containsNodeUrl(decoded) || decoded.includes("\n")) {
      return decoded;
    }
  } catch (_) {
    // Some providers return a plain text node list; fall back to the raw body.
  }

  return text;
}

function containsNodeUrl(text) {
  return /(^|\s)(vmess|vless|trojan|ss):\/\//i.test(text);
}

function buildClashYaml(items, updatedAt) {
  const proxies = items.map(itemToClashProxy).filter(Boolean);
  ensureUniqueObjectNames(proxies, "name");

  const proxyNames = proxies.map((proxy) => proxy.name);
  const config = {
    "mixed-port": 7890,
    "allow-lan": true,
    mode: "rule",
    "log-level": "info",
    proxies,
    "proxy-groups": proxyNames.length
      ? [
          {
            name: "Proxy",
            type: "select",
            proxies: [...proxyNames, "DIRECT"]
          }
        ]
      : [],
    rules: proxyNames.length ? ["MATCH,Proxy"] : ["MATCH,DIRECT"]
  };

  return `# Updated At: ${updatedAt}\n${yamlSerialize(config)}\n`;
}

function itemToClashProxy(item) {
  if (!item.supported) {
    return null;
  }

  if (item.type === "vmess") {
    return vmessToClashProxy(item);
  }

  if (item.type === "vless") {
    return vlessToClashProxy(item);
  }

  if (item.type === "trojan") {
    return trojanToClashProxy(item);
  }

  if (item.type === "ss") {
    return ssToClashProxy(item);
  }

  return null;
}

function vmessToClashProxy(item) {
  const node = item.vmess;
  const proxy = {
    name: item.name,
    type: "vmess",
    server: stringifyValue(node.add),
    port: toPort(node.port, 443),
    uuid: stringifyValue(node.id),
    alterId: readInt(node.aid, 0),
    cipher: stringifyValue(node.scy || node.cipher || "auto"),
    udp: true
  };

  if (isTruthyTls(node.tls)) {
    proxy.tls = true;
    proxy.servername = firstNonEmpty(node.sni, node.serverName, node.host);
  }

  if (isTruthy(node.allowInsecure)) {
    proxy["skip-cert-verify"] = true;
  }

  addClashTransport(proxy, node.net, {
    path: node.path,
    host: node.host,
    serviceName: node.path
  });

  return compactObject(proxy);
}

function vlessToClashProxy(item) {
  const params = item.params;
  const security = lowerParam(params, "security");
  const proxy = {
    name: item.name,
    type: "vless",
    server: item.host,
    port: item.port,
    uuid: item.user,
    udp: true
  };

  if (security === "tls" || security === "reality") {
    proxy.tls = true;
    proxy.servername = firstNonEmpty(params.get("sni"), params.get("servername"));
  }

  if (security === "reality") {
    proxy["reality-opts"] = compactObject({
      "public-key": params.get("pbk"),
      "short-id": params.get("sid")
    });
  }

  const flow = params.get("flow");
  if (flow) {
    proxy.flow = flow;
  }

  const fingerprint = params.get("fp");
  if (fingerprint) {
    proxy["client-fingerprint"] = fingerprint;
  }

  addClashTransportFromParams(proxy, params);
  return compactObject(proxy);
}

function trojanToClashProxy(item) {
  const params = item.params;
  const security = lowerParam(params, "security");
  const proxy = {
    name: item.name,
    type: "trojan",
    server: item.host,
    port: item.port,
    password: item.user,
    udp: true
  };

  if (security !== "none") {
    proxy.sni = firstNonEmpty(params.get("sni"), params.get("peer"), params.get("servername"));
  }

  if (isTruthy(params.get("allowInsecure"))) {
    proxy["skip-cert-verify"] = true;
  }

  addClashTransportFromParams(proxy, params);
  return compactObject(proxy);
}

function ssToClashProxy(item) {
  const params = item.ss.params;
  const proxy = {
    name: item.name,
    type: "ss",
    server: item.host,
    port: item.port,
    cipher: item.ss.method,
    password: item.ss.password,
    udp: true
  };

  const plugin = params.get("plugin");
  if (plugin) {
    const parsedPlugin = parsePluginOption(plugin);
    proxy.plugin = parsedPlugin.name;
    proxy["plugin-opts"] = parsedPlugin.options;
  }

  return compactObject(proxy);
}

function buildSingBoxConfig(items, updatedAt) {
  const outbounds = items.map(itemToSingBoxOutbound).filter(Boolean);
  ensureUniqueObjectNames(outbounds, "tag");

  const outboundTags = outbounds.map((outbound) => outbound.tag);
  return compactObject({
    updated_at: updatedAt,
    log: {
      level: "info"
    },
    outbounds: outboundTags.length
      ? [
          {
            type: "selector",
            tag: "proxy",
            outbounds: outboundTags
          },
          ...outbounds,
          {
            type: "direct",
            tag: "direct"
          }
        ]
      : [
          {
            type: "direct",
            tag: "direct"
          }
        ],
    route: {
      final: outboundTags.length ? "proxy" : "direct"
    }
  });
}

function itemToSingBoxOutbound(item) {
  if (!item.supported) {
    return null;
  }

  if (item.type === "vmess") {
    return vmessToSingBoxOutbound(item);
  }

  if (item.type === "vless") {
    return vlessToSingBoxOutbound(item);
  }

  if (item.type === "trojan") {
    return trojanToSingBoxOutbound(item);
  }

  if (item.type === "ss") {
    return ssToSingBoxOutbound(item);
  }

  return null;
}

function vmessToSingBoxOutbound(item) {
  const node = item.vmess;
  return compactObject({
    type: "vmess",
    tag: item.name,
    server: stringifyValue(node.add),
    server_port: toPort(node.port, 443),
    uuid: stringifyValue(node.id),
    security: stringifyValue(node.scy || "auto"),
    alter_id: readInt(node.aid, 0),
    tls: singBoxTlsFromVmess(node),
    transport: singBoxTransportFromVmess(node)
  });
}

function vlessToSingBoxOutbound(item) {
  const params = item.params;
  return compactObject({
    type: "vless",
    tag: item.name,
    server: item.host,
    server_port: item.port,
    uuid: item.user,
    flow: params.get("flow"),
    tls: singBoxTlsFromParams(params),
    transport: singBoxTransportFromParams(params)
  });
}

function trojanToSingBoxOutbound(item) {
  const params = item.params;
  return compactObject({
    type: "trojan",
    tag: item.name,
    server: item.host,
    server_port: item.port,
    password: item.user,
    tls: singBoxTlsFromParams(params, lowerParam(params, "security") !== "none"),
    transport: singBoxTransportFromParams(params)
  });
}

function ssToSingBoxOutbound(item) {
  return compactObject({
    type: "shadowsocks",
    tag: item.name,
    server: item.host,
    server_port: item.port,
    method: item.ss.method,
    password: item.ss.password
  });
}

function addClashTransportFromParams(proxy, params) {
  addClashTransport(proxy, params.get("type") || params.get("network"), {
    path: params.get("path"),
    host: params.get("host"),
    serviceName: params.get("serviceName") || params.get("service_name")
  });
}

function addClashTransport(proxy, network, options = {}) {
  const net = stringifyValue(network || "tcp").toLowerCase();
  if (!net || net === "tcp") {
    return;
  }

  proxy.network = net;

  if (net === "ws") {
    proxy["ws-opts"] = compactObject({
      path: options.path || "/",
      headers: options.host ? { Host: options.host } : undefined
    });
    return;
  }

  if (net === "grpc") {
    proxy["grpc-opts"] = compactObject({
      "grpc-service-name": options.serviceName
    });
    return;
  }

  if (net === "h2" || net === "http") {
    proxy["h2-opts"] = compactObject({
      path: options.path ? [options.path] : undefined,
      host: options.host ? [options.host] : undefined
    });
  }
}

function singBoxTransportFromParams(params) {
  return singBoxTransport(params.get("type") || params.get("network"), {
    path: params.get("path"),
    host: params.get("host"),
    serviceName: params.get("serviceName") || params.get("service_name")
  });
}

function singBoxTransportFromVmess(node) {
  return singBoxTransport(node.net, {
    path: node.path,
    host: node.host,
    serviceName: node.path
  });
}

function singBoxTransport(network, options = {}) {
  const net = stringifyValue(network || "tcp").toLowerCase();
  if (!net || net === "tcp") {
    return undefined;
  }

  if (net === "ws") {
    return compactObject({
      type: "ws",
      path: options.path || "/",
      headers: options.host ? { Host: options.host } : undefined
    });
  }

  if (net === "grpc") {
    return compactObject({
      type: "grpc",
      service_name: options.serviceName
    });
  }

  if (net === "h2" || net === "http") {
    return compactObject({
      type: "http",
      host: options.host ? [options.host] : undefined,
      path: options.path || undefined
    });
  }

  return compactObject({ type: net });
}

function singBoxTlsFromVmess(node) {
  if (!isTruthyTls(node.tls)) {
    return undefined;
  }

  return compactObject({
    enabled: true,
    server_name: firstNonEmpty(node.sni, node.serverName, node.host),
    insecure: isTruthy(node.allowInsecure) || undefined
  });
}

function singBoxTlsFromParams(params, defaultEnabled = false) {
  const security = lowerParam(params, "security");
  const enabled = defaultEnabled || security === "tls" || security === "reality";

  if (!enabled) {
    return undefined;
  }

  return compactObject({
    enabled: true,
    server_name: firstNonEmpty(params.get("sni"), params.get("servername"), params.get("peer")),
    insecure: isTruthy(params.get("allowInsecure")) || undefined,
    reality: security === "reality"
      ? compactObject({
          enabled: true,
          public_key: params.get("pbk"),
          short_id: params.get("sid")
        })
      : undefined
  });
}

function parsePluginOption(plugin) {
  const parts = String(plugin).split(";").filter(Boolean);
  const name = parts.shift() || "";
  const options = {};

  for (const part of parts) {
    const index = part.indexOf("=");
    if (index > 0) {
      options[part.slice(0, index)] = part.slice(index + 1);
    }
  }

  return {
    name,
    options: Object.keys(options).length ? options : undefined
  };
}

function yamlSerialize(value) {
  const lines = [];
  appendYaml(lines, value, 0);
  return lines.join("\n");
}

function appendYaml(lines, value, indent) {
  const space = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${space}[]`);
      return;
    }

    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${space}- ${yamlScalar(item)}`);
      } else {
        const entries = Object.entries(item).filter(([, entryValue]) => entryValue !== undefined);
        if (!entries.length) {
          lines.push(`${space}- {}`);
          continue;
        }

        const [firstKey, firstValue] = entries[0];
        if (isScalar(firstValue)) {
          lines.push(`${space}- ${firstKey}: ${yamlScalar(firstValue)}`);
        } else {
          lines.push(`${space}- ${firstKey}:`);
          appendYaml(lines, firstValue, indent + 4);
        }

        for (const [key, entryValue] of entries.slice(1)) {
          appendYamlKeyValue(lines, key, entryValue, indent + 2);
        }
      }
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, entryValue] of Object.entries(value)) {
      appendYamlKeyValue(lines, key, entryValue, indent);
    }
  }
}

function appendYamlKeyValue(lines, key, value, indent) {
  const space = " ".repeat(indent);

  if (Array.isArray(value) && value.length === 0) {
    lines.push(`${space}${key}: []`);
    return;
  }

  if (isPlainObject(value) && Object.keys(value).length === 0) {
    lines.push(`${space}${key}: {}`);
    return;
  }

  if (isScalar(value)) {
    lines.push(`${space}${key}: ${yamlScalar(value)}`);
    return;
  }

  lines.push(`${space}${key}:`);
  appendYaml(lines, value, indent + 2);
}

function yamlScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  return JSON.stringify(String(value));
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => compactObject(item))
      .filter((item) => item !== undefined);
  }

  if (!isPlainObject(value)) {
    return value === "" || value === null || value === undefined ? undefined : value;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const compacted = compactObject(item);
    if (compacted !== undefined && !(isPlainObject(compacted) && Object.keys(compacted).length === 0)) {
      result[key] = compacted;
    }
  }

  return Object.keys(result).length ? result : undefined;
}

function ensureUniqueObjectNames(items, key) {
  const seen = new Map();

  for (const item of items) {
    const original = stringifyValue(item[key] || "proxy");
    const count = seen.get(original) || 0;
    seen.set(original, count + 1);
    if (count > 0) {
      item[key] = `${original}-${count + 1}`;
    } else {
      item[key] = original;
    }
  }
}

async function applyRateLimit(request, env, scope, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return;
  }

  const client = getClientIdentifier(request);
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `rl:${scope}:${client}:${bucket}`;
  const current = readInt(await env.SUB_KV.get(key), 0);

  if (current >= limit) {
    throw new AppError(429, "Too many requests");
  }

  await env.SUB_KV.put(key, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2
  });
}

function getClientIdentifier(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) {
    return cfIp;
  }

  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return "local";
}

function targetToKvKey(target) {
  if (target === "clash") {
    return KV_KEYS.clash;
  }

  if (target === "singbox") {
    return KV_KEYS.singbox;
  }

  return KV_KEYS.converted;
}

function selectPayload(converted, target) {
  if (target === "clash") {
    return converted.clashYaml;
  }

  if (target === "singbox") {
    return converted.singboxJson;
  }

  return converted.convertedSub;
}

function normalizeTarget(target) {
  const value = stringifyValue(target || "base64").toLowerCase();
  if (["base64", "sub", "raw"].includes(value)) {
    return "base64";
  }

  if (value === "clash") {
    return "clash";
  }

  if (["singbox", "sing-box"].includes(value)) {
    return "singbox";
  }

  throw new AppError(400, "Unsupported target");
}

function encodeUtf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function decodeBase64ToUtf8(value) {
  const normalized = normalizeBase64(value);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder("utf-8").decode(bytes);
}

function normalizeBase64(value) {
  const compact = String(value || "").trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const remainder = compact.length % 4;

  if (remainder === 1) {
    throw new Error("Invalid base64 length");
  }

  return compact + "=".repeat((4 - remainder) % 4);
}

function decodeSsUserInfo(value) {
  const decodedComponent = safeDecodeURIComponent(value);
  if (decodedComponent.includes(":")) {
    return decodedComponent;
  }

  try {
    return decodeBase64ToUtf8(value);
  } catch (_) {
    return decodedComponent;
  }
}

function splitFragment(value) {
  const index = value.indexOf("#");
  if (index < 0) {
    return { base: value, fragment: "" };
  }

  return {
    base: value.slice(0, index),
    fragment: value.slice(index + 1)
  };
}

function replaceFragment(value, name) {
  const base = splitFragment(value).base;
  return `${base}#${encodeURIComponent(name)}`;
}

function parseHostPort(value) {
  let input = String(value || "").trim();
  input = input.split("/")[0].replace(/^\/+|\/+$/g, "");

  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end >= 0) {
      return {
        host: normalizeHost(input.slice(1, end)),
        port: toPort(input.slice(end + 2), 443)
      };
    }
  }

  const colon = input.lastIndexOf(":");
  if (colon < 0) {
    return {
      host: normalizeHost(input),
      port: 443
    };
  }

  return {
    host: normalizeHost(input.slice(0, colon)),
    port: toPort(input.slice(colon + 1), 443)
  };
}

function normalizeHost(value) {
  return stringifyValue(value).trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function defaultPort(protocol, params) {
  const security = lowerParam(params, "security");
  if (protocol === "trojan" || security === "tls" || security === "reality") {
    return 443;
  }

  return 80;
}

function lowerParam(params, key) {
  return stringifyValue(params.get(key)).toLowerCase();
}

function toPort(value, fallback) {
  const port = Number(value);
  if (Number.isFinite(port) && port > 0) {
    return port;
  }

  return fallback;
}

function readInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = stringifyValue(value);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function stringifyValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (_) {
    return String(value || "");
  }
}

function isTruthy(value) {
  return ["1", "true", "yes"].includes(stringifyValue(value).toLowerCase());
}

function isTruthyTls(value) {
  return ["tls", "true", "1", "reality"].includes(stringifyValue(value).toLowerCase());
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function parseJsonOrNull(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function readBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function timingSafeEqual(left, right) {
  const leftText = stringifyValue(left);
  const rightText = stringifyValue(right);
  let diff = leftText.length ^ rightText.length;
  const length = Math.max(leftText.length, rightText.length);

  for (let index = 0; index < length; index += 1) {
    diff |= (leftText.charCodeAt(index) || 0) ^ (rightText.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function assertKv(env) {
  if (!env.SUB_KV) {
    throw new AppError(500, "KV binding SUB_KV is not configured");
  }
}

function assertOrigin(env) {
  if (!env.ORIGIN_SUB_URL) {
    throw new AppError(500, "Origin subscription URL is not configured");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function textResponse(body, headers = {}, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...COMMON_HEADERS,
      ...headers
    }
  });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function handleError(error) {
  if (error instanceof AppError) {
    return jsonResponse({ error: error.publicMessage }, error.status);
  }

  console.error("Unhandled worker error:", safeErrorMessage(error));
  return jsonResponse({ error: "Internal server error" }, 500);
}
