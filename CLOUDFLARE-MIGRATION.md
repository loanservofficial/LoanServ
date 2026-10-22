# Moving loanserv.in from Vercel to Cloudflare Workers

Vercel's Hobby plan has refused new deployments since 2026-10-22
(`402 resource_creation_blocked`, "fair use"), so merged fixes such as
removing the free CIBIL check (PR #13) can't go live. This branch makes the site
build and run on **Cloudflare Workers** with the
[OpenNext Cloudflare adapter](https://opennext.js.org/cloudflare), on
Cloudflare's **free plan**.

Nothing here has been deployed. DNS, Vercel and Cloudflare accounts are
untouched. Everything below was tested locally with `wrangler dev` (the real
Workers runtime, `workerd`).

---

## 1. What changed and why

| Change | Why |
| --- | --- |
| `next` and `eslint-config-next` 16.3.2 → **16.4.2** (own commit) | The adapter (`@opennextjs/cloudflare@1.20.13`) supports `next >=16.4.1`; 16.0–16.4.0 are excluded. Build, `tsc`, lint and tests pass. |
| Added `@opennextjs/cloudflare`, `wrangler`, `wrangler.jsonc`, `open-next.config.ts`, scripts `preview` / `deploy` / `upload` / `cf-typegen` | Standard adapter setup. `nodejs_compat` is on; compatibility date 2026-10-19. |
| **Static-assets page cache** (`open-next.config.ts`) with cache interception | Every page is prerendered at build time, so the prerendered HTML ships as Workers static assets. No KV/R2, no cache writes, nothing to create or clean up, free. (A KV cache was tried first: each deploy writes ~229 keys / ~53 MB with no expiry, which hits the free 1,000 writes/day and 1 GB limits after a few deploys.) |
| `/news` renders per request (was ISR, hourly) | The static-assets cache is read-only, so ISR can't refresh. `src/lib/news.ts` keeps the parsed feed in memory for an hour instead, so the RSS host isn't hit on every view. |
| Chat knowledge is built at build time | `/api/chat` read `content/` from disk on every request; Workers have no project filesystem at runtime. `scripts/build-chat-corpus.mjs` (npm `prebuild`/`predev`/`pretest`) snapshots the articles into `src/generated/chat-corpus.ts` (gitignored) and `src/lib/chat-knowledge.ts` imports it. Use `npm run typecheck` rather than bare `tsc` on a fresh checkout (it generates the file first). Retrieval is identical: same chunks, same ranking and scores on test queries. The `outputFileTracingIncludes` entry in `next.config.ts` is gone. |
| `dynamicParams = false` on blog, legal, knowledge-center, offers and `/[loanType]/[city]` | All their valid pages are prerendered; anything else was already a 404. Now the 404 is served without rendering, so no request ever reads `content/` or `data/` from disk, and stray `/a/b` URLs cost no CPU. |
| Lead email: switchable provider (`src/lib/email.ts`) | `LEAD_EMAIL_PROVIDER` = `smtp` (default, unchanged behaviour), `resend` or `brevo` (HTTP APIs, plain `fetch`). Nodemailer is loaded only for SMTP. Same function signature; all lead paths unchanged. Tests added. |
| `icon`, `apple-icon`, `opengraph-image` are now static PNGs | They were `next/og` routes that Next prerendered anyway, but they pulled the image renderer (~0.7 MiB compressed of WASM + font) into the worker. The PNGs are byte-for-byte what those routes produced; the `.tsx` designs moved to `design/metadata-images/` with regeneration steps. JSON-LD now points at `/opengraph-image.png` (and `/icon.png`, which used to 404). Not strictly required any more (see bundle size); it just makes the worker smaller and cold starts cheaper. |
| `public/_headers` | Lets browsers cache Next's hashed `/_next/static/*` files for a year (Workers static assets otherwise send `max-age=0`). |

Unchanged: all pages, URLs, redirects (`/free-cibil-score`, `/legal/data-policy`
→ 308), security headers/CSP, API behaviour. The site still builds with plain
`next build`, so it can still go back to Vercel (see rollback).

## 2. Local test results

Build: `opennextjs-cloudflare build` passes (on Windows only with a workaround,
see 5). Then `opennextjs-cloudflare preview` on `http://127.0.0.1:8787`.

**Pass 1: no secrets at all**

| Route | Result |
| --- | --- |
| `/` | 200 |
| `/blog`, `/blog/how-to-improve-cibil-score` | 200, 200 |
| `/blog/no-such-post` | 404 |
| `/offers`, `/offers/hdfc-bank`, `/offers/hdfc-bank/personal` | 200, 200, 200 |
| `/calculators`, `/calculators/emi-calculator` | 200, 200 |
| `/knowledge-center`, `/knowledge-center/tutorials/how-to-apply-for-a-loan` | 200, 200 |
| `/legal/privacy-policy`, `/apply` | 200, 200 |
| `/personal-loan/hyderabad` / `/personal-loan/nowhere-town` | 200 / 404 |
| `/news` | 200, 12 live headlines from the RSS feed |
| `/confirm/abc` | 200 (expired-link page) |
| `/sitemap.xml`, `/robots.txt`, `/ads.txt` | 200 (xml), 200, 200 |
| `/opengraph-image.png`, `/icon.png`, `/apple-icon.png`, `/favicon.ico` | 200 PNG / ICO |
| `/free-cibil-score` | **308** → `/blog/what-is-a-good-credit-score-in-india` |
| `/legal/data-policy` | **308** → `/legal/privacy-policy` |
| `POST /api/apply` valid / invalid | 200 `{"ok":true}` (lead accepted, "SMTP not configured" warning, consent record logged) / 422 |
| `POST /api/chat-lead` | 200 `{"ok":true}` (same) |
| `POST /api/chat/prefill` | 200 `{}` (chat not enabled) |
| `POST /api/chat` | 503 "assistant is unavailable" (not enabled) |
| `POST /api/partner/me`, `POST /api/partner/referrals` | 503 "partner portal isn't set up yet" |
| `POST /api/referral/decision` | 410 "link has expired" (no Supabase) |
| `POST /api/voice-webhook` | 401 (no webhook secret) |
| `GET /api/whatsapp` (verify) / `POST /api/whatsapp` | 403 / 401 (no WhatsApp secrets) |

Also checked: security headers and CSP are present on every page,
`/_next/static/*` is served with `max-age=31536000, immutable`, and no
errors appeared in the worker log.

**Pass 2: lead email and chat with stand-ins** (local SMTP sink, mock Sarvam API)

- `/api/apply` and `/api/chat-lead`: both lead emails reached the SMTP sink
  (AUTH, MAIL FROM, RCPT, DATA) from inside the worker, so **Nodemailer over
  SMTP works on Workers with `nodejs_compat`**.
- TLS: pointed at `smtp.gmail.com` with fake credentials, both port **587
  (STARTTLS)** and **465 (TLS)** got as far as Gmail's `535 bad credentials`,
  which Gmail only sends after a successful TLS handshake.
- `/api/chat`: answered 200; the prompt sent to the (mock) model contained the
  right article (`/blog/how-to-improve-cibil-score`), so the bundled corpus
  works in the worker.
- `LEAD_EMAIL_PROVIDER=resend` with a fake key: the worker reached Resend's
  API (401), logged the failure and still accepted the lead.
- Not tested: a real send from Cloudflare's production network (needs a
  deployed worker and real SMTP credentials). Cloudflare blocks outbound port
  25 only; 465/587 are fine. If SMTP ever misbehaves there, switch to
  `LEAD_EMAIL_PROVIDER=resend` or `brevo`; no code change needed.

## 3. Bundle size and the free plan

| Measure | This worker | Limit |
| --- | --- | --- |
| Uncompressed (`Total Upload`) | **11,747 KiB (11.5 MiB)** | **64 MiB on every plan** (the only size limit since ~Sept 2026) |
| gzip (reference only) | **2,485 KiB (2.43 MiB)** | Old limits, no longer enforced: 3 MiB free / 10 MiB paid |

(`npx wrangler deploy --dry-run --outdir <dir>`.) Size is **not** a blocker on
free or paid; it would even pass the old 3 MiB cap. Before the OG images became
static files it was 3,226 KiB gzipped, which the old free cap would have refused.

What decides free vs paid is **CPU time: 10 ms per request on the free plan**
(paid: 30 s default). CPU can't be measured locally (`wrangler dev` reports 0),
so these are local wall-clock medians of warm requests on this PC:

| Kind of request | Local median | Free-plan outlook |
| --- | --- | --- |
| Prerendered pages (home, blog, offers, calculators, city pages, sitemap), 404s | 18–26 ms | Good: served from static assets via cache interception; about the same as the dev server's own overhead (`/ads.txt` and a rejected API call also take ~20 ms). |
| API routes (apply, chat-lead, webhooks…) | ~20 ms + the outside services they call (waiting on I/O doesn't count as CPU) | Probably fine. |
| Pages rendered per request: `/news`, `/confirm/[token]` | **~150–165 ms with no I/O at all** | **Likely over 10 ms** → may fail with error 1102 on the free plan. |

**Recommendation: start on the free plan.** It costs nothing, and almost all
traffic is prerendered pages. After deploying, open Workers & Pages → loanserv
→ Metrics and check CPU time (p50/p99) and errors, and open `/news` and a
partner `/confirm/...` link. If they fail with **error 1102 "Worker exceeded
resource limits"**, the cheap fix is Workers Paid at **$5/month** (no code
change). The free alternative is to make `/news` static (headlines refreshed
only on each deploy); `/confirm/[token]` must stay dynamic because it reads the
referral token.

## 4. What you need to do

### 4.1 Cloudflare account and first deploy (free)

1. Sign up at cloudflare.com (free plan; no card needed for Workers free).
2. **Recommended: deploy with Workers Builds** (Cloudflare's CI, Linux, free
   3,000 build minutes/month; works like Vercel's Git integration):
   Workers & Pages → Create → Import a repository → `toolsrift/LoanServ` →
   - Build command: `npx opennextjs-cloudflare build`
   - Deploy command: `npx opennextjs-cloudflare deploy`
   - Production branch: `main`
   - Add the **build variables** from 4.3 (the `NEXT_PUBLIC_*` ones) under
     *Build variables and secrets*.
3. Add the **runtime secrets** (4.2), in the dashboard (Settings → Variables
   and Secrets, type *Secret*) or from a terminal:

   ```bash
   npx wrangler login
   ```

   ```bash
   npx wrangler secret put SMTP_PASS
   ```

   (one command per secret; or put them all in a JSON file and run
   `npx wrangler secret bulk secrets.json`, then delete the file.)
4. Open the `*.workers.dev` URL it gives you and click around before touching DNS.

Values: copy them from Vercel → loan-serv → Settings → Environment Variables
(reading them doesn't need a deployment). Secrets survive later deploys;
`keep_vars` in `wrangler.jsonc` also keeps plain-text dashboard variables.

### 4.2 Runtime secrets (read on the server at request time)

Set only what you use; everything is optional and fails safe when missing
(as on Vercel). There was no `.env.example` on `main`; this list comes from the
code.

| Variable | Used for |
| --- | --- |
| `LEAD_EMAIL_PROVIDER` | `smtp` (default), `resend` or `brevo` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Lead email over SMTP (e.g. Gmail app password, port 465 or 587) |
| `RESEND_API_KEY` | **new** — only if `LEAD_EMAIL_PROVIDER=resend` |
| `BREVO_API_KEY` | **new** — only if `LEAD_EMAIL_PROVIDER=brevo` |
| `LEAD_FROM_EMAIL` | **new** — sender address for resend/brevo (must be a domain/sender verified with that provider, e.g. `leads@loanserv.in`). SMTP keeps using `SMTP_USER`. |
| `LEAD_TO_EMAIL` | Where lead emails go (defaults to the site email) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Lead store, consent records, partner portal, do-not-call list |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | New-lead alerts |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Site-wide rate limits and daily chat cap (recommended: without it limits are per worker instance) |
| `CHAT_AGENT_ENABLED`, `SARVAM_API_KEY` | AI chat assistant (`true` + key) |
| `SARVAM_CHAT_URL`, `SARVAM_CHAT_MODEL`, `CHAT_DAILY_LIMIT` | Optional chat overrides |
| `WHATSAPP_BOT_ENABLED`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_VERSION` | WhatsApp bot (see `WHATSAPP-BOT.md`) |
| `VOICE_AGENT_ENABLED`, `DOGRAH_API_URL`, `DOGRAH_API_KEY`, `DOGRAH_TRIGGER_UUID`, `DOGRAH_TELEPHONY_CONFIG_ID`, `DOGRAH_FROM_PHONE_NUMBER_ID`, `DOGRAH_WEBHOOK_SECRET` | Voice callback (see `VOICE-AGENT.md`) |
| `NEWS_RSS_URL` | Optional: another feed for `/news` |

After DNS moves, update the webhook URLs you registered with Meta (WhatsApp)
and Dograh only if they pointed at a Vercel URL; `https://loanserv.in/...`
URLs keep working.

### 4.3 Build variables (baked in at build time)

`NEXT_PUBLIC_*` values are compiled into the pages, and `next.config.ts` builds
the Content-Security-Policy from them at build time, so they must be set where
the **build** runs (Workers Builds → *Build variables and secrets*), not just
as runtime secrets:

`NEXT_PUBLIC_SITE_URL` (`https://loanserv.in`, required), `NEXT_PUBLIC_WHATSAPP_NUMBER`,
`NEXT_PUBLIC_PHONE_NUMBER`, `NEXT_PUBLIC_GSC_VERIFICATION`, `NEXT_PUBLIC_GA_ID`,
`NEXT_PUBLIC_ADSENSE_CLIENT`, `NEXT_PUBLIC_GOOGLE_BUSINESS_URL`,
`NEXT_PUBLIC_GOOGLE_ADS_ID`, `NEXT_PUBLIC_GOOGLE_ADS_LEAD_LABEL`,
`NEXT_PUBLIC_META_PIXEL_ID`, `NEXT_PUBLIC_NEWS_RSS`.

Changing one needs a rebuild (push a commit or click *Retry build*).

### 4.4 DNS cutover (GoDaddy → Cloudflare nameservers)

The domain **registration stays at GoDaddy**; only DNS moves. Done in this
order there is no downtime: the site keeps being served by Vercel's last
deployment until step 6.

1. **A day before:** in GoDaddy DNS, lower the TTL of the `@` (A 76.76.21.21)
   and `www` records to the minimum (600 s), so later changes spread fast. Write
   down every record (MX, TXT for Google Search Console/SPF/DKIM, etc.).
2. If DNSSEC is on at GoDaddy, turn it off first (it breaks a nameserver move).
3. Cloudflare → Add a domain → `loanserv.in` → Free plan. Cloudflare imports
   the existing records; **check every record against your list** (especially
   MX and TXT, or email/verification breaks). Leave the Vercel `@` and `www`
   records as they are, set to **DNS only** (grey cloud) for now.
4. In GoDaddy → Domain → Nameservers → *I'll use my own nameservers*: replace
   `ns49.domaincontrol.com` / `ns50.domaincontrol.com` with the two names
   Cloudflare shows. Wait for Cloudflare to say the zone is **Active**
   (minutes to a few hours; up to 48 h).
5. Check the site still loads (still Vercel) and email still arrives.
6. **Switch to the worker:** in Cloudflare DNS delete the `@` A record
   (76.76.21.21) and the `www` record, then Workers & Pages → loanserv →
   Settings → Domains & Routes → *Add custom domain* `loanserv.in` (Cloudflare
   creates the record and certificate).
7. `www`: add a proxied record (e.g. `CNAME www → loanserv.in`, orange cloud)
   and a Rules → Redirect Rule: hostname `www.loanserv.in` → 301 to
   `https://loanserv.in${uri}` with query string kept (free plan includes
   redirect rules). This matches the current www → apex behaviour.
8. Verify: `https://loanserv.in`, `/free-cibil-score` (308), `/sitemap.xml`,
   the apply form (you get the lead email), then resubmit the sitemap in
   Search Console.
9. Re-enable DNSSEC from Cloudflare (DNS → Settings) if you want it, adding
   the DS record at GoDaddy.

### 4.5 Plan

Free plan to start (see 3). Upgrade to Workers Paid only if Metrics show CPU
limit errors.

## 5. Building on Windows

`opennextjs-cloudflare build` fails on this Windows PC with
`EPERM: operation not permitted, symlink` (Windows only lets admins create
symlinks unless **Developer Mode** is on, and OpenNext doesn't support Windows
officially). Options:

- Use **Workers Builds** (recommended, 4.1): builds run on Linux.
- Or turn on Windows *Settings → System → For developers → Developer Mode*,
  or use WSL, then `npm run preview` / `npm run deploy` work locally.

For this prototype the build was run with a throwaway script (outside the
repo) that made Node fall back to directory junctions when a symlink was
refused; the output is the same.

## 6. Rollback to Vercel

Vercel still serves its last good deployment for as long as the project and
its domain settings exist, so **don't delete the Vercel project** or remove
the domain from it until Cloudflare has run cleanly for a couple of weeks.
Note that this old deployment predates PR #13 and still has the free CIBIL
check that collects PAN and date of birth.

- **Fast (minutes), after nameservers have moved:** in Cloudflare, remove the
  worker's custom domain and the `www` redirect, then add back
  `A @ 76.76.21.21` and `CNAME www cname.vercel-dns.com`, both **DNS only**.
  Traffic goes back to Vercel as the old records expire.
- **Full (hours, up to 48 h):** put the GoDaddy nameservers back
  (`ns49.domaincontrol.com`, `ns50.domaincontrol.com`). The GoDaddy zone keeps
  its old records unless you delete them, so don't.
- **Code:** nothing on this branch stops the app building on Vercel (`next
  build` still works); the Cloudflare files are simply ignored there. Vercel
  deploys stay blocked until the fair-use block is lifted or the plan changes.

## 7. Cost

| Item | Cost |
| --- | --- |
| Workers Free | **$0**: 100,000 requests/day, 10 ms CPU per request. Static assets (JS, CSS, images, fonts) are free and unlimited and don't count as requests. |
| Workers Paid (only if needed) | **$5/month**: 10 M requests + 30 M CPU-ms included, 30 s CPU per request. |
| Workers Builds | Free: 3,000 build minutes/month (a build here takes a few minutes). |
| DNS on Cloudflare | Free. |
| Domain | Unchanged: renewal stays with GoDaddy. |
| KV / R2 / D1 | Not used. |
| Lead email | SMTP with an existing mailbox: free. Resend and Brevo both have free tiers (check current limits); only needed if SMTP misbehaves. |

For comparison, Vercel Pro is $20 per member per month.

## 8. Known gaps / not verified

- CPU time per request on the real network (needs a deployment). `/news` and
  `/confirm/[token]` are the pages most likely to exceed the free plan's 10 ms.
- A real SMTP send from Cloudflare's network (tested locally up to Gmail's
  login step on 465 and 587).
- Workers Builds itself was not run (no account was used).
- `/news` is no longer ISR; it renders per request with an in-memory hourly
  feed cache. Each worker instance fetches the feed once an hour.
- In-memory rate limits are per worker instance (as on Vercel); set the
  Upstash variables for site-wide limits.
- One unit test (`chunking strips markdown and bounds chunk size`) already
  failed on `main`; it still fails, nothing new fails.
