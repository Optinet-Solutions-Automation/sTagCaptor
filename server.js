require("dotenv").config();
const express = require("express");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3500;

const MAX_HOPS = parseInt(process.env.MAX_HOPS) || 20;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS) || 1000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS) || 10000;
const TRACKING_PARAMS = (process.env.TRACKING_PARAMS || "btag,stag,cxd,mid,affid")
  .split(",")
  .map((p) => p.trim().toLowerCase());
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRequestHeaders(referer) {
  const headers = { ...BROWSER_HEADERS };
  if (referer) {
    headers["Referer"] = referer;
    headers["Sec-Fetch-Site"] = "cross-site";
  }
  return headers;
}

function hasTrackingParams(url) {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()].map((k) => k.toLowerCase());
    return TRACKING_PARAMS.some((param) => keys.includes(param));
  } catch {
    return false;
  }
}

function buildProxyAuthHeader(proxy) {
  if (!proxy.username) return null;
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return "Basic " + Buffer.from(credentials).toString("base64");
}

// ─── Direct request (no proxy) ────────────────────────────────────────────────

function requestDirect(targetUrl, referer) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }

    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.get(
      targetUrl,
      { headers: buildRequestHeaders(referer), timeout: TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve({ statusCode: res.statusCode, headers: res.headers });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${TIMEOUT_MS / 1000}s for ${targetUrl}`));
    });
    req.on("error", (err) =>
      reject(new Error(`Request failed for ${targetUrl}: ${err.message}`))
    );
  });
}

// ─── Proxied request ──────────────────────────────────────────────────────────

/**
 * Route a single hop through an HTTP/HTTPS proxy.
 *
 * - HTTP  target → forward full URL to proxy as the request path
 * - HTTPS target → send CONNECT to open a tunnel, then negotiate TLS inside it
 */
function requestViaProxy(targetUrl, proxyUrl, referer) {
  return new Promise((resolve, reject) => {
    let target, proxy;
    try {
      target = new URL(targetUrl);
      proxy = new URL(proxyUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${e.message}`));
    }

    const isHttps = target.protocol === "https:";
    const targetPort = parseInt(target.port) || (isHttps ? 443 : 80);
    const proxyPort = parseInt(proxy.port) || 80;
    const proxyAuth = buildProxyAuthHeader(proxy);

    if (isHttps) {
      // ── HTTPS via CONNECT tunnel ────────────────────────────────────────
      const connectHeaders = {
        Host: `${target.hostname}:${targetPort}`,
        "User-Agent": USER_AGENT,
      };
      if (proxyAuth) connectHeaders["Proxy-Authorization"] = proxyAuth;

      const connectReq = http.request({
        host: proxy.hostname,
        port: proxyPort,
        method: "CONNECT",
        path: `${target.hostname}:${targetPort}`,
        headers: connectHeaders,
        timeout: TIMEOUT_MS,
      });

      connectReq.on("connect", (_res, socket, _head) => {
        if (_res.statusCode !== 200) {
          socket.destroy();
          return reject(
            new Error(`Proxy CONNECT failed with status ${_res.statusCode} for ${proxy.hostname}`)
          );
        }

        // Wrap the raw TCP socket in TLS directed at the real target
        const tlsSocket = tls.connect(
          { socket, servername: target.hostname, rejectUnauthorized: false },
          () => {
            const reqPath = (target.pathname || "/") + (target.search || "");
            const reqHeaders = buildRequestHeaders(referer);
            reqHeaders.Host = target.hostname;

            const innerReq = https.request(
              {
                createConnection: () => tlsSocket,
                hostname: target.hostname,
                port: targetPort,
                path: reqPath,
                method: "GET",
                headers: reqHeaders,
                timeout: TIMEOUT_MS,
              },
              (innerRes) => {
                innerRes.resume();
                resolve({ statusCode: innerRes.statusCode, headers: innerRes.headers });
              }
            );

            innerReq.on("timeout", () => {
              innerReq.destroy();
              reject(new Error(`Request timed out after ${TIMEOUT_MS / 1000}s for ${targetUrl}`));
            });
            innerReq.on("error", (err) =>
              reject(new Error(`Request failed for ${targetUrl}: ${err.message}`))
            );
            innerReq.end();
          }
        );

        tlsSocket.on("error", (err) =>
          reject(new Error(`TLS error for ${targetUrl}: ${err.message}`))
        );
      });

      connectReq.on("timeout", () => {
        connectReq.destroy();
        reject(new Error(`Proxy CONNECT timed out for ${proxy.hostname}`));
      });
      connectReq.on("error", (err) =>
        reject(new Error(`Proxy connection failed for ${proxy.hostname}: ${err.message}`))
      );
      connectReq.end();
    } else {
      // ── Plain HTTP: send full URL as the request path ───────────────────
      const reqHeaders = buildRequestHeaders(referer);
      reqHeaders.Host = target.hostname;
      if (proxyAuth) reqHeaders["Proxy-Authorization"] = proxyAuth;

      const req = http.request(
        {
          host: proxy.hostname,
          port: proxyPort,
          method: "GET",
          path: targetUrl,
          headers: reqHeaders,
          timeout: TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          resolve({ statusCode: res.statusCode, headers: res.headers });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out after ${TIMEOUT_MS / 1000}s for ${targetUrl}`));
      });
      req.on("error", (err) =>
        reject(new Error(`Request failed for ${targetUrl}: ${err.message}`))
      );
      req.end();
    }
  });
}

// ─── Redirect tracer ─────────────────────────────────────────────────────────

/**
 * Follow redirects hop-by-hop from startUrl, optionally through a proxy.
 * Returns { finalUrl, status, hops }.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function traceRedirectsOnce(startUrl, proxyUrl) {
  let currentUrl = startUrl;
  let referer = null;
  let hops = 0;

  // Check if the starting URL already has tracking params
  if (hasTrackingParams(currentUrl)) {
    return { finalUrl: currentUrl, status: null, hops, found: true };
  }

  while (true) {
    const { statusCode, headers } = proxyUrl
      ? await requestViaProxy(currentUrl, proxyUrl, referer)
      : await requestDirect(currentUrl, referer);

    if (!REDIRECT_CODES.has(statusCode)) {
      return { finalUrl: currentUrl, status: statusCode, hops, found: hasTrackingParams(currentUrl) };
    }

    hops++;
    if (hops > MAX_HOPS) {
      return { finalUrl: currentUrl, status: statusCode, hops, found: false };
    }

    const location = headers.location;
    if (!location) {
      return { finalUrl: currentUrl, status: statusCode, hops: hops - 1, found: hasTrackingParams(currentUrl) };
    }

    referer = currentUrl;
    currentUrl = new URL(location, currentUrl).href;

    // Check each hop — stop early if tracking params found
    if (hasTrackingParams(currentUrl)) {
      return { finalUrl: currentUrl, status: statusCode, hops, found: true };
    }
  }
}

async function traceRedirects(startUrl, proxyUrl) {
  let lastResult;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    lastResult = await traceRedirectsOnce(startUrl, proxyUrl);

    if (lastResult.found) {
      lastResult.attempts = attempt;
      return lastResult;
    }

    if (attempt < MAX_RETRIES) {
      await delay(RETRY_DELAY_MS);
    }
  }

  lastResult.attempts = MAX_RETRIES;
  return lastResult;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/trace", async (req, res) => {
  const { url, proxy } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing required query parameter: url" });
  }

  // Validate target URL
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "URL must use http or https protocol" });
    }
  } catch {
    return res.status(400).json({ error: `Invalid URL: ${url}` });
  }

  // Validate proxy URL (optional)
  if (proxy) {
    try {
      const parsedProxy = new URL(proxy);
      if (!["http:", "https:"].includes(parsedProxy.protocol)) {
        return res.status(400).json({ error: "Proxy must use http or https protocol" });
      }
    } catch {
      return res.status(400).json({ error: `Invalid proxy URL: ${proxy}` });
    }
  }

  try {
    const { finalUrl, status, hops, attempts, found } = await traceRedirects(url, proxy || null);

    const response = { input_url: url, final_url: finalUrl, status, hops, attempts, tracking_found: found };
    if (proxy) response.proxy = proxy;

    return res.json(response);
  } catch (err) {
    return res.status(502).json({ error: err.message, input_url: url });
  }
});

app.get("/", (_req, res) => {
  res.json({
    service: "stagCaptorAPI",
    usage: "GET /trace?url=<encoded_url>[&proxy=<encoded_proxy_url>]",
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`stagCaptorAPI listening on http://localhost:${PORT}`);
});
