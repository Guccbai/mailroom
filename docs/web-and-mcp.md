# Use the web app, remote MCP, attachments, and notifications

Mailroom can serve a private web app, accept MCP clients over HTTPS, send
attachments, and notify Telegram or a webhook when mail arrives. Each feature
is off until its secret is set. Mailroom has one owner. There are no user
accounts or roles.

Deploy the central Worker first by following the [deployment guide](deploy.md).

## Turn on the web app

The web app is served by the central Worker at its root URL. It shows the
inbox, sent mail, archive, spam, search, threads, drafts that wait for
approval, a composer, and settings. Its interface is in Simplified Chinese.

Choose a password of at least 12 characters and store it as a secret:

```sh
pnpm --filter @mailroom/worker exec wrangler secret put MAILROOM_WEB_PASSWORD \
  --config wrangler.local.jsonc
```

Open the Worker URL and sign in. The session lasts seven days in an
`HttpOnly`, `Secure`, `SameSite=Strict` cookie. Changing the password or
`MAILROOM_API_TOKEN` signs out every session.

Check that it worked: the page shows the inbox after sign-in, and
`GET /v1/session` returns `"authenticated": true` from the same browser.

Five wrong passwords from one IP address lock that address for 15 minutes.
Fifty failures from all addresses lock sign-in for everyone for 15 minutes.
The private API token keeps working during a lockout.

Email HTML renders in a sandboxed frame with scripts disabled. Remote images
stay blocked until you choose to show them for that message, because images
can report that you opened the email.

### Send from the web app

Sending from the web app follows the same rules as the CLI and MCP. The
composer creates a draft, records your approval as `owner (web)`, and sends
it with a new idempotency key. A confirmation dialog shows every recipient
before anything is sent. Use the save-as-draft button (存为草稿) to stop before approval.

Drafts that an agent or automation created appear in the drafts view (草稿与审批). Open one to
approve and send it, approve it only, or reject it with a reason.

To forward a message, open it and choose 转发 (or press `f`). Mailroom
creates a new draft with the original quoted below your note and, unless you
untick it, the original attachments. It is sent only after the same
confirmation as any other draft. Agents use the `drafts.forward` operation.

### Keyboard shortcuts

Press `?` in the web app for the full list. The main ones are `c` compose,
`/` search, `j` and `k` move through the list, `Enter` opens, `r` reply,
`f` forward, `e` archive, `#` spam, `u` back, and `g` then `i`, `s`, `d` or
`,` to jump to the inbox, sent mail, drafts or settings.

### Manage settings in the web app

Settings (设置) has sections for domains and mailbox addresses, notifications,
forwarding, MCP clients and access tokens, and appearance.

- **Domains and addresses:** add a domain, add addresses under it (each new
  address gets an exact route), choose where mail for unlisted addresses
  goes, and pause or resume a domain, an address or its route. Cloudflare
  Email Routing still has to send the domain's mail to the Worker, and a new
  sending address has to be allowed in the Worker's `send_email` binding.
- **Notifications and forwarding:** the values listed in
  [stored settings](#stored-settings) can be set here instead of as Worker
  variables.
- **Appearance:** light, dark, or the system setting. The sidebar groups
  addresses by domain and filters the lists by domain or address.

#### Stored settings

These keys can be stored in D1 from the web app or with the `settings.update`
operation. A stored value overrides the Worker variable of the same name.
Clearing it falls back to the Worker variable:

`MAILROOM_PUBLIC_URL`, `MAILROOM_FORWARD_TO`, `MAILROOM_FORWARD_TO_BY_DOMAIN`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_NOTIFY_MAILBOXES`,
`WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_EVENTS`, `WEBHOOK_NOTIFY_MAILBOXES`.

`settings.get` never returns `TELEGRAM_BOT_TOKEN` or `WEBHOOK_SECRET`; it only
says whether they are set. `MAILROOM_API_TOKEN`, `MAILROOM_WEB_PASSWORD`,
`INGRESS_SECRET` and the other credentials stay Worker secrets.

## Connect an MCP client over HTTPS

The Worker serves the same three MCP tools as `mailroom mcp serve` at `/mcp`,
using the Streamable HTTP transport:

- `mailroom_list_operations`
- `mailroom_describe_operation`
- `mailroom_run_operation`

OAuth is the recommended way to connect. Access tokens and static bearer
tokens are optional, for clients that do not support OAuth.

### Use OAuth

With Claude Code:

```sh
claude mcp add --transport http mailroom https://mail.example.com/mcp
```

Then run `/mcp` in Claude Code, select `mailroom` and choose Authenticate. In
Claude on the web or desktop, add a custom connector with the same URL. Other
clients that support remote MCP with OAuth take the same URL.

Clients register themselves through `/oauth/register`. When you connect, Mailroom shows a
consent page with the client name and the address it will return to. Enter
your web password to approve. Tokens last one hour and refresh for up to 30
days.

OAuth needs `MAILROOM_WEB_PASSWORD` and the `OAUTH_KV` binding:

```sh
pnpm --filter @mailroom/worker exec wrangler kv namespace create mailroom-oauth
```

Put the namespace ID in the `OAUTH_KV` entry of `wrangler.local.jsonc`.

Set `MAILROOM_PUBLIC_URL` to the Worker's public origin, such as
`https://mail.example.com`, when the Worker has a custom domain. Mailroom uses
it as the OAuth resource identifier and in notification links.

### Use an access token

For a client or script without OAuth, create an access token in Settings →
MCP 与令牌. The token starts with `mrt_` and is shown once. Only its SHA-256
hash is stored, and you can revoke it there at any time. Send it as
`Authorization: Bearer mrt_…` to `/mcp` or `/v1/operations`.

Access tokens and MCP clients cannot run `settings.update` or the `tokens.*`
operations. Those need the web session or `MAILROOM_API_TOKEN`.

### Use a static bearer token

Clients that accept custom headers can also send a static token:

```sh
claude mcp add --transport http mailroom https://mail.example.com/mcp \
  --header "Authorization: Bearer $MAILROOM_MCP_TOKEN"
```

Store a separate random value as `MAILROOM_MCP_TOKEN`. When it is not set,
`/mcp` accepts `MAILROOM_API_TOKEN` instead. Setting `MAILROOM_MCP_TOKEN`
lets you revoke MCP access without changing the CLI token.

Check that it worked: `mailroom_list_operations` returns the operation list,
and a request without a token returns HTTP 401 with a `WWW-Authenticate`
header.

### What an MCP client can do

An MCP client can do everything the private API can do, including approving
and sending drafts. Approve only clients you control. The tool instructions
tell agents that email content is untrusted and that sending needs the owner's
request, but the server cannot tell who is typing in the client.

## Send and receive attachments

Inbound attachments are stored in R2 when a message is parsed. Read them with
`attachments.get`, which returns a download path signed for 15 minutes.
Small files, up to 48 KB, can be returned inline with `includeContent: true`.

`drafts.create` and `drafts.compose` accept up to 10 attachments, 10 MB in
total, as base64:

```json
{
  "filename": "invoice.pdf",
  "contentType": "application/pdf",
  "contentBase64": "JVBERi0xLjc..."
}
```

Attachments are stored with the draft and sent only when the draft is sent.
Check Cloudflare's
[Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)
before sending large files.

`drafts.compose` starts a new conversation. Pass `inboxId` or a `from`
address that belongs to a configured inbox, `to`, optional `cc`, `subject`,
and `text`. The first send creates the thread.

## Try sending without delivering

Set the `MAILROOM_SEND_MODE` variable to `dry-run` to record sends without
calling Email Service or a relay. Drafts, threads, and attachments are stored
as if the message was sent, and the provider message id starts with
`<dry-run.`. Use this for test deployments only.

## Get Telegram notifications

Create a bot with [BotFather](https://core.telegram.org/bots#how-do-i-create-a-bot),
send it a message, and find your chat ID. Then store three secrets:

| Secret | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The token from BotFather |
| `TELEGRAM_CHAT_ID` | The chat that should receive alerts |
| `TELEGRAM_NOTIFY_MAILBOXES` | A JSON array of mailbox addresses, or `["*"]` for every mailbox |

Each alert shows the sender, mailbox, subject, attachment names, and a
preview. With `MAILROOM_PUBLIC_URL` set, it also links to the message in the
web app.

Check that it worked: open settings (设置) in the web app and select
测试 Telegram, or run `notifications.test` with `{"channel": "telegram"}`.

## Send webhooks

Store the endpoint and a signing secret of at least 16 characters:

| Secret | Value |
| --- | --- |
| `WEBHOOK_URL` | An `https` URL |
| `WEBHOOK_SECRET` | A random value shared with the receiver |
| `WEBHOOK_EVENTS` | Optional: `message.received`, `message.sent`, or both, comma-separated. Defaults to `message.received` |
| `WEBHOOK_NOTIFY_MAILBOXES` | Optional JSON array of mailbox addresses. Defaults to every mailbox |

Mailroom sends a JSON `POST`:

```json
{
  "id": "evt_...",
  "type": "message.received",
  "createdAt": "2026-11-13T18:00:00.000Z",
  "data": {
    "message": {
      "id": "msg_...",
      "threadId": "thr_...",
      "mailbox": "hello@example.com",
      "from": "sender@example.net",
      "to": ["hello@example.com"],
      "cc": [],
      "subject": "Question",
      "preview": "First 240 characters",
      "receivedAt": "2026-11-13T18:00:00.000Z",
      "attachments": [{ "id": "att_...", "filename": "a.pdf", "contentType": "application/pdf", "sizeBytes": 1024 }]
    },
    "links": { "web": "https://mail.example.com/#/message/msg_..." }
  }
}
```

Message bodies are not included. Fetch them with the API or MCP when needed.

Verify each request before trusting it. Compute an HMAC-SHA256 with
`WEBHOOK_SECRET` over the `x-mailroom-timestamp` header, a dot, and the raw
body. Compare it with the hex value after `v1=` in `x-mailroom-signature`, and
reject timestamps older than five minutes:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret, timestamp, rawBody, header) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
  const provided = header.replace(/^v1=/, '')
  return (
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  )
}
```

Use `x-mailroom-delivery` to ignore duplicates. Mailroom retries timeouts,
HTTP 429, and 5xx responses up to three times. It does not follow redirects.
Recent results appear in the web app settings and in `notifications.status`.

## Security notes

- Keep `MAILROOM_WEB_PASSWORD`, `MAILROOM_API_TOKEN`, and
  `MAILROOM_MCP_TOKEN` different.
- Cookie-authenticated writes must come from the same origin.
- Attachment downloads are always served as `attachment` with
  `Content-Security-Policy: sandbox`, except images, PDFs, and plain text
  opened with `?inline=1`.
- The web app sets a strict content security policy and refuses to be framed.
