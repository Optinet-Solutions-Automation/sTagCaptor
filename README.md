# stagCaptorAPI

API that traces HTTP redirects hop-by-hop and returns the final destination URL. Supports optional proxy routing so redirects resolve from the correct country.

## Setup

```bash
# Install dependencies
npm install

# (Optional) Copy and edit environment variables
cp .env.example .env

# Start the server
npm start
```

The server listens on `http://localhost:3500` by default. Set the `PORT` environment variable to change it.

## Usage

### `GET /trace?url=<encoded_url>[&proxy=<encoded_proxy_url>]`

Follows all HTTP redirects (301, 302, 303, 307, 308) and returns the final URL.

**Query parameters:**

| Param   | Required | Description                                            |
| ------- | -------- | ------------------------------------------------------ |
| `url`   | Yes      | URL-encoded target URL                                 |
| `proxy` | No       | URL-encoded proxy address (`http://host:port` or with credentials `http://user:pass@host:port`) |

**Success response (no proxy):**

```json
{
  "input_url": "http://example.com/short",
  "final_url": "https://example.com/final-destination",
  "status": 200,
  "hops": 2
}
```

**Success response (with proxy):**

```json
{
  "input_url": "http://example.com/short",
  "final_url": "https://example.com/final-destination",
  "status": 200,
  "hops": 2,
  "proxy": "http://user:pass@proxy.example.com:8080"
}
```

**Error response:**

```json
{
  "error": "descriptive error message",
  "input_url": "http://example.com/bad"
}
```

## Example curl commands

```bash
# Trace a URL with no proxy (direct)
curl "http://localhost:3500/trace?url=http%3A%2F%2Fgithub.com"

# Trace through an anonymous proxy (country-accurate redirect)
curl "http://localhost:3500/trace?url=http%3A%2F%2Fgithub.com&proxy=http%3A%2F%2Fproxyhost%3A8080"

# Trace through a proxy with authentication
curl "http://localhost:3500/trace?url=https%3A%2F%2Fexample.com&proxy=http%3A%2F%2Fuser%3Apass%40proxyhost%3A8080"

# Trace a shortened URL through a US proxy
curl "http://localhost:3500/trace?url=https%3A%2F%2Fbit.ly%2F3abc123&proxy=http%3A%2F%2Fus-proxy.example.com%3A3128"
```

## How proxy routing works

- **HTTP targets** — the full target URL is forwarded to the proxy as the request path (standard HTTP proxy forwarding).
- **HTTPS targets** — a `CONNECT` tunnel is opened to the proxy, then TLS is negotiated directly with the target through the tunnel. Each redirect hop is routed through the same proxy.

## Limits

- **Max redirects:** 20 hops
- **Timeout:** 10 seconds per request
