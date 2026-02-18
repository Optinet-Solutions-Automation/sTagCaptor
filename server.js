const express = require("express");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3500;

const MAX_HOPS = 20;
const TIMEOUT_MS = 10000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Make a single HTTP(S) request that does NOT follow redirects.
 * Resolves with { statusCode, headers, location }.
 */
function request(targetUrl) {
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
      {
        headers: { "User-Agent": USER_AGENT },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        // Consume the response body so the socket is freed
        res.resume();
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${TIMEOUT_MS / 1000}s for ${targetUrl}`));
    });

    req.on("error", (err) => {
      reject(new Error(`Request failed for ${targetUrl}: ${err.message}`));
    });
  });
}

/**
 * Follow redirects hop-by-hop starting from `startUrl`.
 * Returns { finalUrl, status, hops }.
 */
async function traceRedirects(startUrl) {
  let currentUrl = startUrl;
  let hops = 0;

  while (true) {
    const { statusCode, headers } = await request(currentUrl);

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

    // Resolve relative redirects against the current URL
    currentUrl = new URL(location, currentUrl).href;
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get("/trace", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: "Missing required query parameter: url" });
  }

  // Basic URL validation
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "URL must use http or https protocol" });
    }
  } catch {
    return res.status(400).json({ error: `Invalid URL: ${url}` });
  }

  try {
    const { finalUrl, status, hops } = await traceRedirects(url);

    return res.json({
      input_url: url,
      final_url: finalUrl,
      status,
      hops,
    });
  } catch (err) {
    return res.status(502).json({
      error: err.message,
      input_url: url,
    });
  }
});

app.get("/", (_req, res) => {
  res.json({
    service: "stagCaptorAPI",
    usage: "GET /trace?url=<encoded_url>",
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`stagCaptorAPI listening on http://localhost:${PORT}`);
});
