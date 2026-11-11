# iCloud Access From the Relay — Decision Document

**Date:** 2026-08-02 · **Scope:** what the always-on Cloudflare relay can reach in iCloud without the MacBook being awake, what it costs, and what to build.

---

## 1. Capability map

| Capability | Route | Credential needed | Verdict | Note |
|---|---|---|---|---|
| **Calendar read** | CalDAV over HTTPS to `caldav.icloud.com` | App-specific password (ASP) | **Works today** | Plain `fetch()` from a Worker; `tsdav` officially supports the Workers runtime. |
| **Calendar read (zero-credential)** | Published `webcal://` .ics feed | None | **Works today** | Read-only, but no secret in the relay at all. Best risk-adjusted option if reads are 80% of the need. |
| **Calendar write** (create/move/delete, invite attendees) | CalDAV `PUT`/`DELETE` | ASP | **Works today** | Adding `ATTENDEE` to a VEVENT triggers real server-side iTIP invites. |
| **Contacts read/write** | CardDAV to `contacts.icloud.com` | ASP | **Works today** | Same client, same auth as CalDAV. This is your name→address resolver. |
| **Mail read (inbound push)** | iCloud forwarding rule → Cloudflare Email Routing → Email Worker | **None** | **Works with caveats** | True push, sub-second, no stored mailbox credential. No mailbox *state* (can't mark read, can't search history). |
| **Mail read (full mailbox)** | IMAP `imap.mail.me.com:993` | ASP | **Works with caveats** | Trivial on the Node relay. Awkward on Workers — needs raw `cloudflare:sockets` and a hand-rolled client. |
| **Mail send** | SMTP `smtp.mail.me.com` | ASP | **Works with caveats** | Port 587 STARTTLS is Apple-documented but unusable from Workers (`workerd` #2712 hangs). Use 465 implicit TLS from a Worker, or just send from the Node relay. |
| **Reminders** | — | — | **Blocked** | Migrated off CalDAV at iOS 13/Catalina into a private CloudKit store. Stays on the Mac (or an iPhone app). |
| **Notes** | — | — | **Blocked** | Left the IMAP `Notes` folder a decade ago; CloudKit-only, E2EE under ADP. |
| **Photos** | Reverse-engineered web API | Real Apple ID password + 2FA | **Risky / effectively blocked** | ~2-month session expiry, breaks unattended. Disabled entirely by ADP. |
| **iCloud Drive / files** | Reverse-engineered `docws` endpoints | Real Apple ID password + 2FA | **Risky / effectively blocked** | ASPs explicitly do **not** work here. Keep files on the Mac or in R2. |
| **Find My** | Reverse-engineered `fmipservice` | Real Apple ID password + 2FA | **Blocked** | Forces credential re-entry within minutes. Polling it is the single likeliest way to get flagged. |
| **Messages / iMessage** | — | — | **Blocked** | E2EE by design. Mac-local `chat.db` only. |
| **Keychain / Passwords** | — | — | **Blocked** | Apple holds no keys. Correct outcome; don't pursue. |
| **Your own app's data** | CloudKit Web Services, server-to-server key | ECDSA P-256 keypair (no Apple ID) | **Works with caveats** | Public database only, and only *your* container — never Apple's. Useful as a Worker↔iPhone bus, useless for reading personal iCloud data. |

**The structural rule behind this table:** Apple excludes Mail, Contacts, and Calendar from end-to-end encryption *specifically* so they can interoperate with the global IMAP/CalDAV/CardDAV ecosystem. Those three, and only those three, are reachable by any server-side credential. Everything else is a cryptographic wall, not a documentation gap. Stop looking for a Notes or Photos API.

---

## 2. What an app-specific password actually buys you

An ASP is a 16-character string in the form `xxxx-xxxx-xxxx-xxxx`. You generate it at **account.apple.com → Sign-In and Security → App-Specific Passwords → generate**, give it a label, and copy the value once. It requires two-factor authentication on the account, which you have. You can hold 25 active at a time.

You use it as the password in HTTP Basic auth (CalDAV, CardDAV) or in `IMAP LOGIN` / `SMTP AUTH`. The username is your Apple Account email address for CalDAV, CardDAV, and SMTP. For IMAP, Apple's docs show the local part (`johnappleseed`) but the full address generally works — try the full address first and fall back.

What it grants, exactly:

- iCloud Mail over IMAP (read, flag, move, delete) and SMTP (send).
- iCloud Calendar over CalDAV (read, create, modify, delete, invite).
- iCloud Contacts over CardDAV (read, create, modify, delete).
- Incidentally, `notarytool` and App Store Connect CLI auth — which is the clearest proof that it is not service-scoped.

What it does **not** grant: sign-in at appleid.apple.com or iCloud.com, device sign-in, Find My, Apple Pay, purchases, account settings changes, generating further ASPs, iCloud Drive, or Photos. The persistent misconception worth flagging: an ASP does not authenticate against the private `icloud.com` web API, which is what every `pyicloud`-family tool needs. That's why the Drive/Photos/Find My rows above degrade to "store your real password in the cloud," which you should not do.

The label you type when generating it is cosmetic. There is no scope selector, no per-service restriction, and no read-only mode.

---

## 3. The risks, stated honestly

### Blast radius

Model an ASP as **a password for your mail, calendar, and contacts, with no second factor and no audit trail** — not as a scoped token.

Concretely, if the relay is compromised, the attacker gets: full mailbox read (which is password-reset capability for every other account you own — Google, GitHub, your bank), the ability to send mail as your real address *and* delete the resulting reset emails via IMAP, and full read/write/delete on every contact and calendar you have.

Two properties make this worse than an OAuth token. First, an ASP **bypasses 2FA by design** — there is no trusted-device approval on the protocol path, so a stolen ASP is used silently and produces no "new sign-in" notification on your devices. Second, Apple provides **zero telemetry**: no last-used timestamp, no source IP, no per-ASP activity log. If it leaks, nothing on Apple's side will tell you.

The mitigation that actually matters is architectural: expose **narrow verbs** from the relay (`list events for date range`, `create event`), never a generic iCloud passthrough route, and gate any outbound send behind explicit human confirmation rather than model judgement. An injected instruction reaching your LLM planner — from a transcript, a fetched page, an email body — otherwise becomes a spoofed email from your real address.

### Does enabling Advanced Data Protection break this?

**No.** This is the important answer and it goes the convenient way.

Apple's iCloud data security overview lists Mail, Contacts, and Calendars as "In transit & on server / Apple" under **both** standard protection and ADP. Apple's stated reason is interoperability: Mail must work with the global email system, and Contacts/Calendars are built on CalDAV/CardDAV, which have no E2EE story. So the entire CalDAV/CardDAV/IMAP path survives ADP untouched.

ADP does change two adjacent things. It turns off iCloud.com web access by default (re-enabling it requires per-session authorization from a trusted device, valid one hour — unusable for headless automation), and it moves Notes, Reminders, Drive, Photos, Safari data, Shortcuts, Freeform, and iCloud Backup to E2EE with keys only on your devices.

The practical reading: **turning ADP on costs you nothing you can actually have, and permanently closes the reverse-engineered Drive/Photos/Find My routes you shouldn't build on anyway.** It is a decision to commit to the ASP + on-device architecture, which is the right trade regardless. Turn it on.

### Rate limits and account-lock risk

Apple publishes no request budget for CalDAV/CardDAV. Throttling surfaces as HTTP 503, and third parties consistently report that Apple's suggested retry interval is *too short* — retrying at it re-triggers the limit. IMAP caps simultaneous connections at roughly 4 per account (your phone's Mail app counts), and bulk fetches are throttled hard. SMTP is capped at 1,000 messages/day, 1,000 recipients/day, 500 recipients per message, 20 MB per message.

The dangerous interaction specific to this architecture:

> **Changing or resetting your Apple ID password silently revokes every ASP.** An always-on relay on a 1-minute cron will then retry a now-invalid credential every minute, forever. That is a self-inflicted credential-stuffing attack against your own account, and "entering account info incorrectly too many times" is exactly what Apple's lockout page names as the trigger.

Mandatory mitigations, in priority order:

1. **On any 401, set a persistent `auth_dead` flag in D1 and stop entirely** until a human clears it from the dashboard. Never back off and retry a 401.
2. Treat 503 separately with exponential backoff plus jitter and a circuit breaker.
3. Cap total iCloud requests per hour in the relay itself.
4. Surface auth failure loudly on the dashboard — the default failure mode is your pendant quietly going deaf.

A second, under-appreciated risk: Cloudflare Workers egress from whichever data center handles the request, and cron triggers run from arbitrary locations. Your iCloud sessions will appear to originate from IPs hopping between continents every few minutes, which is the textbook signature of a compromised credential. **You already have a fixed-IP option** — `Dockerfile` + `.gcloudignore` show `cloud-relay/server.js` is deployable as a container. Routing iCloud traffic through that host rather than straight out of the edge is worth doing, and it happens to be where IMAP/SMTP are trivial anyway.

If a lock does happen, recovery requires a password reset, which revokes all ASPs and takes down every integration at once — and the lock covers your devices, Find My, purchases, and your paid Developer account, not just mail.

### Storage and rotation

Store the ASP in **Cloudflare Secrets Store** (account-level, RBAC, and — critically — an audit log of create/bind/rotate/delete, which is the only usage record you will ever have since Apple provides none). `wrangler secret put ICLOUD_ASP` is the acceptable minimum.

Hard rules:

- **Never in the repo**, never in `wrangler.jsonc` `vars`, never in `.env`, never in D1. Note that this repo currently stores device auth material in D1 — do not follow that pattern here.
- Never log it and never echo response headers into error payloads; a 401 handler that dumps the `Authorization` header is a realistic leak path.
- No Worker route may proxy arbitrary iCloud requests using it.
- Generate a **dedicated ASP for the relay**, separate from anything else, so revocation is surgical. The 25-slot cap is generous.
- Assume anyone with Cloudflare dashboard or API-token access has your iCloud mail. Put a hardware key on the Cloudflare account and scope deploy tokens tightly — your CI is part of the trust boundary, because a Worker secret is readable by any code you deploy.

Rotation is manual only; there is no API to mint one. Set a calendar reminder. Containment order if you suspect a leak: revoke that one ASP at account.apple.com (disturbs nothing else) → rotate the Cloudflare secret → only if you believe the primary password is involved, reset it and accept re-provisioning everything.

---

## 4. The design I recommend

### The decision rule

Route every capability by two questions: **is the data E2EE**, and **does the answer need to be right now?**

- **Tier 1 — relay-direct, always available.** Calendar (CalDAV), Contacts (CardDAV), inbound mail (forwarding → Email Worker). If a capability is Tier 1, the relay must **never** delegate it to the Mac, even when the Mac is awake.
- **Tier 2 — iPhone via APNs, seconds, best-effort.** Reminders, Notes, anything needing a live iCloud session on a signed-in device. Silent push is opportunistic (roughly 2–3/hour budget, skipped in Low Power Mode), so treat it as an accelerator with a deadline, never a synchronous RPC.
- **Tier 3 — Mac when awake, opportunistic and batch.** Messages history, full-text mail search, Photos library analysis, iCloud Drive files, screen and app control — everything already in `local-agent/`.

For Tier 2 and Tier 3, the relay must **return a partial answer immediately and reconcile later**, never block. You already have the queue for this in `cloud-relay/jobs.js` and `/v1/bridge/work`.

### The recommendation

**Adopt one app-specific password, held only in Cloudflare Secrets Store, and use it for CalDAV and CardDAV. Get inbound mail via iCloud forwarding into a Cloudflare Email Worker rather than IMAP. Keep Reminders, Notes, Messages, and files on the Mac. Do not touch the private iCloud web API.**

Reasons: CalDAV plus CardDAV is the largest availability win for the least work — it is plain `fetch()` with XML, no TCP-socket gymnastics, and it removes the closed-laptop dependency for the majority of pendant commands. The forwarding path gives you true push for new mail with **no stored mailbox credential at all**, which is strictly better than IMAP for the "tell me about new email" use case that motivates most of the value. And the private-API routes cost the most, break silently, and put your entire Apple ID — including your Developer account — at risk for capabilities you can get on-device.

If you want to be more conservative still: start with a **published .ics feed** for calendar reads (zero credential, zero account risk) and only introduce the ASP when you need writes. That is a legitimate stopping point if "what's on my calendar" is most of what you actually ask.

### Integration sketch for this codebase

New module, mirroring the existing `cloud-relay/` layout:

```
cloud-relay/icloud/
  dav.js         # tsdav client, principal + home-set discovery, discovery cache
  calendar.js    # list/create/update/delete events, free-busy
  contacts.js    # search, resolve name -> email/phone
  mailIngest.js  # Email Worker handler: postal-mime parse -> R2 raw + D1 row
  mailSend.js    # send path (see below)
  guard.js       # auth_dead flag, hourly request cap, 401/503 policy
```

Endpoints to add to `cloud-relay/server.js` and `cloudflare-worker/worker.js`, following the existing `/v1/...` + scope-table convention around line 1574:

| Endpoint | Scope | Notes |
|---|---|---|
| `GET /v1/icloud/calendar/events?from=&to=` | `icloud:read` | CalDAV `calendar-query` REPORT |
| `POST /v1/icloud/calendar/events` | `icloud:write` | PUT an .ics |
| `PATCH/DELETE /v1/icloud/calendar/events/:uid` | `icloud:write` | |
| `GET /v1/icloud/calendar/freebusy?date=` | `icloud:read` | powers "am I free Thursday 3pm" |
| `GET /v1/icloud/contacts/resolve?q=` | `icloud:read` | name → addresses |
| `GET /v1/icloud/mail/recent?since=` | `icloud:read` | reads D1, not IMAP |
| `POST /v1/icloud/mail/send` | `icloud:send` | **requires a confirmation token issued by a prior pendant confirm step** |
| `GET /v1/icloud/health` | `admin` | exposes `auth_dead`, last success, request counts |

D1 tables: `icloud_dav_discovery` (principal + home-set URLs, cached with TTL — discover the `pNN-` partition host, **never hardcode it**), `icloud_mail_messages` (from, subject, snippet, received_at, r2_key, read flag), `icloud_auth_state` (the `auth_dead` latch and last-error), `icloud_call_log` (verb, timestamp, result — your only anomaly-detection surface).

**Flow: "what's on my calendar tomorrow"**

Today this goes pendant → `/v1/transcribe` → `/v1/mac/plan` → job queued → `/v1/bridge/work` → Mac wakes or the command dies. The change: `local-agent/intentRouter.js` gains a `calendar` intent and **moves (or is duplicated) into a shared module the relay can import** — that file is currently Mac-side only, which is why every command needs the Mac. Then:

```
pendant → POST /v1/transcribe
        → classifyIntent() in the relay → 'calendar'
        → cloud-relay/icloud/calendar.js listEvents(tomorrow)
        → summarize → POST /v1/pendant/speak
```

No `/v1/mac/plan`, no bridge job, no Mac. Latency is one CalDAV REPORT.

**Flow: "read me my new email"**

```
iCloud rule forwards → Cloudflare Email Routing → Email Worker email() handler
        → postal-mime parse → raw to R2 → row into icloud_mail_messages
        → (optionally) POST /v1/pendant/announce for proactive notification

pendant asks → classifyIntent() → 'mail'
        → SELECT from icloud_mail_messages WHERE read = 0
        → summarize → /v1/pendant/speak
```

Note the bootstrap: Apple emails a verification code to the forwarding destination before enabling the rule, so route that address to a real mailbox first, capture the code, then switch it to the Worker. Leave "delete after forwarding" **off** so iCloud stays the system of record.

**Mail send.** Start by routing sends through the containerized Node relay (`node:tls` + `nodemailer` against `smtp.mail.me.com:465`) or through the Mac agent when awake, and use Email Workers' `reply()` for in-thread replies — that variant works today and needs no SMTP at all. If you want send from the Worker itself, use **port 465 implicit TLS**, not the Apple-documented 587 STARTTLS; `socket.startTls()` in `workerd` has hung since September 2024 (issue #2712) and is still open. Gate every send behind explicit pendant/dashboard confirmation.

**What stays on the Mac.** `local-agent/reminders.js` and `local-agent/builtins/reminder.js` are correctly placed and should not move — Reminders has no server route. Same for Messages, Photos, iCloud Drive, and everything in `computerUse.js` / `uiControl.js`. The change is demoting the Mac from "required for every command" to "accelerator for the heavy local stuff."

**One caveat on TCC**, since it will bite you on the Mac side: permission grants attach to a code-signed bundle identifier, not to a script. Node started from Terminal borrows Terminal's grants and appears to work; the same code under a LaunchAgent has no grants and fails with no prompt and no useful error. `local-agent/macos/setupPermissions.js` is the right place to handle this, and a signed helper bundle is the durable fix.

---

## 5. Alternatives worth considering instead

The honest comparison is that **Google and Microsoft both offer strictly better credentials than an ASP on every axis that matters**, and both offer push for new mail, which iCloud does not.

| | iCloud + ASP | Google OAuth | Microsoft Graph |
|---|---|---|---|
| Scopes | None — all-or-nothing | Per-scope (`calendar.readonly`, `gmail.send`, …) | Per-permission |
| Token lifetime | Never expires | Short-lived access + refresh token | Short-lived + refresh (rolled on use) |
| Survives password change | **No** — silently revoked | Yes | Yes |
| Per-app revocation | No (only the shared ASP) | Yes, at myaccount.google.com | Yes |
| Usage audit | **None** | Third-party access page | Sign-in logs |
| New-mail push | No (poll, or the forwarding trick) | Yes — `users.watch` → Pub/Sub → your webhook | Yes — change notifications |
| Calendar push | No | Yes — `events.watch` → webhook | Yes |
| Incremental sync | `sync-token` (RFC 6578) | `syncToken` | `delta` tokens |

**Google** is the strongest technical option. A read-only calendar scope means a fully compromised relay still cannot read your mail or delete anything — that is a real security improvement over the ASP's all-or-nothing grant. The frictions are specific and knowable: leave the OAuth consent screen in "Testing" and your refresh token is revoked every **7 days**, so you must publish to "In Production" (unverified apps then show a one-time warning screen and are user-capped, which is fine for one person). Your webhook domain must be verified in Google Cloud and serve a valid public CA cert — you cannot verify `*.workers.dev`, so the Worker needs a custom domain. Watch channels expire in days with **no auto-renew**; run a cron that re-watches early and tolerates overlap. Gmail's restricted scopes nominally require a security assessment, but that gate is about distribution — a personal production app under ~100 users runs unverified. Note that service accounts with domain-wide delegation are Workspace-only and will not work for a consumer `@gmail.com` address; that is a common dead end.

**Microsoft Graph** has the best delta-sync story of the three — delta tokens plus webhooks give both push and a guaranteed catch-up path when your relay was down, with missed notifications retried for up to 4 hours. Subscriptions max out just under 7 days (under a day if you request resource data inline), so the same cron-renew pattern applies. Refresh tokens last up to 90 days and roll on use. Only worth adopting if you already live in Outlook.

**The tradeoff you're actually making.** Adopting Google means moving (or mirroring) your calendar and mail out of iCloud, which is a real lifestyle change, not just a config change. If you're unwilling to do that, the ASP is the only option and its risks are manageable with the guards in section 3. If you are willing — or if you'd accept a Google calendar as the agent's *working* calendar with iCloud subscribed to it — you get real push, real scopes, a credential that survives password rotation, and an audit trail. That is a genuinely better foundation for an autonomous agent.

**CloudKit with a server-to-server key** is sometimes proposed as the Apple-sanctioned answer. It is not, for this purpose: the key reaches only the **public** database of **your own** container, never a user's private database and never Apple's containers. Apple DTS confirmed this explicitly in November 2025 — the 500 errors people hit on private-DB calls are a design limit, not a bug. It is useful as a free APNs-backed Worker↔iPhone data bus, but you already run D1 and R2 and control both ends, so it mostly buys you a second sync system to maintain. Don't start here.

---

## 6. Build order

1. **Turn on Advanced Data Protection.** It costs nothing here and closes Notes, Drive, Photos, and Backup to everyone including Apple.
2. **Published .ics calendar feed → Worker.** Half a day. Zero credentials, zero account risk, and it proves the relay-side intent routing path end to end. This requires moving `intentRouter.js` into a shared module, which is the real prerequisite for everything below.
3. **Generate a dedicated ASP → Secrets Store. Ship `icloud/dav.js` + `calendar.js` + `guard.js`.** Discovery with caching, calendar read/write, the `auth_dead` latch, backoff, and the hourly cap. This is the largest availability win. Ship the dashboard health panel in the same PR — an unmonitored ASP is the failure mode where your pendant goes quietly deaf.
4. **`contacts.js`.** Small, and it unlocks name resolution for everything else.
5. **iCloud forwarding → Cloudflare Email Routing → Email Worker.** Push notification of new mail with no stored mailbox credential. Budget time for the verification-code bootstrap, and expect strict-DMARC senders to be dropped at the Cloudflare edge — that's a documented limitation of forwarding, and it fails silently.
6. **Mail send, confirmation-gated.** Node relay or Email Worker `reply()` first; Worker SMTP on 465 only if you need it.
7. **Later, if Tier 2 matters:** an EventKit plugin in the existing Capacitor app plus APNs silent push, so Reminders and Notes stop depending on the Mac. Treat it as best-effort with a fallback.

Do **not** build: the private iCloud web API, CloudKit as a personal-data reader, or Wake-on-LAN for the Mac. Network wake produces a ~30–60 second darkwake that isn't enough for a multi-step task, a lid-closed MacBook on battery won't wake at all, and a magic packet is layer-2 so your Worker can't send one anyway.