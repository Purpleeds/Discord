# Database setup: moving to Neon (free, never expires)

## Why

Render's free Postgres databases are **deleted** 30 days after they're created (plus a 14-day grace period). That's why accounts and messages kept disappearing. Neon's free plan is permanent, needs no credit card, and keeps your data even if you go over its limits (it just pauses writes).

The app itself stays on Render's free web service. Only the database moves.

## Steps

1. Go to **neon.com** and sign up (free, no card).
2. Create a project (any name, pick the region closest to your Render service — your chat service is in Oregon, so a US West region is ideal).
3. On the project dashboard click **Connect**, tick **Connection pooling**, and copy the connection string. It looks like:
   `postgresql://user:password@ep-something-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require`
4. In the Render dashboard open your chat web service → **Environment** → set `DATABASE_URL` to that string → **Save** (Render redeploys automatically).
5. Push the updated files (`server.js`, `package.json`, `render.yaml`, `public/`) to your GitHub repo so Render deploys the new version.

That's it — the app creates all its tables on first start. Nothing in the code needs changing; it already uses SSL, which Neon requires.

`render.yaml` no longer creates a Render database, so a Blueprint deploy will ask you for `DATABASE_URL` instead.

## Notes

- Neon puts the database to sleep after 5 idle minutes and wakes it in well under a second on the next request — you won't notice.
- Free limits: 1 GB storage per project, which is a lot of chat messages (avatars count too, but each one is at most ~2 MB).
- The 10 GB file-sharing feature still stores files on Render's temporary disk and deletes them after 6 hours, same as before. Accounts, messages, avatars, server icons, pins and settings all live in the database.
- Render's free web service still sleeps after 15 minutes without visitors and takes about a minute to wake up.
