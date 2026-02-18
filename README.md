# stagCaptorAPI

API that traces HTTP redirects hop-by-hop and returns the final destination URL.

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

### `GET /trace?url=<encoded_url>`

Follows all HTTP redirects (301, 302, 303, 307, 308) and returns the final URL.

**Query parameters:**

| Param | Required | Description              |
| ----- | -------- | ------------------------ |
| `url` | Yes      | URL-encoded target URL   |

**Success response:**

```json
{
  "input_url": "http://example.com/short",
  "final_url": "https://example.com/final-destination",
  "status": 200,
  "hops": 2
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
# Trace a URL that redirects
curl "http://localhost:3500/trace?url=http%3A%2F%2Fgithub.com"

# Trace a shortened URL
curl "http://localhost:3500/trace?url=https%3A%2F%2Fbit.ly%2F3abc123"

# Trace with a URL that has no redirects
curl "http://localhost:3500/trace?url=https%3A%2F%2Fexample.com"
```

## Limits

- **Max redirects:** 20 hops
- **Timeout:** 10 seconds per request
"# sTagCaptor" 
