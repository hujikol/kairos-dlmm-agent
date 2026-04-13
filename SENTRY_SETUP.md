# Sentry Setup

## Create a Sentry Project

1. Go to [sentry.io](https://sentry.io) and sign in (or create an account)
2. Click **"Create Project"** → select **Node.js** as the platform
3. Name your project (e.g., `meridian-dlmm-agent`)
4. Copy the **DSN** from the project settings

## Finding the DSN

Project Settings → Client Keys (DSN) → copy the DSN URL (looks like `https://abc123@o123456.ingest.sentry.io/1234567`)

## Environment Variable

Set in your `.env`:

```
SENTRY_DSN=https://abc123@o123456.ingest.sentry.io/1234567
```

## Sampling Rates

| Setting | Value | Meaning |
|---------|-------|---------|
| `tracesSampleRate` | `0.1` | 10% of transactions are traced (errors + performance) |
| `profilesSampleRate` | `0.1` | 10% of sampled transactions get CPU profiles |

Both are set low to keep costs minimal. You can raise to `1.0` for full tracing in dev/staging.

## Free Tier Limits

- **5,000 errors/month** — enough for a single agent
- **10,000 transactions/month** — 10% sampling on a busy agent goes a long way

If you exceed limits, Sentry will alert you in the dashboard. Reduce `tracesSampleRate` to `0.05` to cut sampling in half.