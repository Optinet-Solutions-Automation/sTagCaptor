const express = require("express");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3500;

const MAX_HOPS = 20;
const TIMEOUT_MS = 10000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProxyAuthHeader(proxy) {
  if (!proxy.username) return null;
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return "Basic " + Buffer.from(credentials).toString("base64");
}

// ─── Direct request (no proxy) ────────────────────────────────────────────────

function requestDirect(targetUrl) {
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
      { headers: { "User-Agent": USER_AGENT }, timeout: TIMEOUT_MS },
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
function requestViaProxy(targetUrl, proxyUrl) {
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

            const innerReq = https.request(
              {
                createConnection: () => tlsSocket,
                hostname: target.hostname,
                port: targetPort,
                path: reqPath,
                method: "GET",
                headers: { "User-Agent": USER_AGENT, Host: target.hostname },
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
      const reqHeaders = { "User-Agent": USER_AGENT, Host: target.hostname };
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
async function traceRedirects(startUrl, proxyUrl) {
  let currentUrl = startUrl;
  let hops = 0;

  while (true) {
    const { statusCode, headers } = proxyUrl
      ? await requestViaProxy(currentUrl, proxyUrl)
      : await requestDirect(currentUrl);

    if (!REDIRECT_CODES.has(statusCode)) {
      return { finalUrl: currentUrl, status: statusCode, hops };
    }

    hops++;
    if (hops > MAX_HOPS) {
      throw new Error(`Too many redirects (exceeded ${MAX_HOPS} hops)`);
    }

    const location = headers.location;
    if (!location) {
      // Redirect status but no Location header — treat as final
      return { finalUrl: currentUrl, status: statusCode, hops: hops - 1 };
    }

    // Resolve relative Location headers against the current URL
    currentUrl = new URL(location, currentUrl).href;
  }
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
    const { finalUrl, status, hops } = await traceRedirects(url, proxy || null);

    const response = { input_url: url, final_url: finalUrl, status, hops };
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
