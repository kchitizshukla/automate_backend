# Deploying FixMyRide

Two deployable units: **one backend service** (Render) and **four static/SSR web apps**
(Vercel). The Expo apps are handled separately via EAS.

```
Vercel                                  Render
┌─────────────────┐                     ┌──────────────────────────┐
│ landing  :3000  │                     │  fixmyride-backend       │
│ user     :3001  │ ──── /api/user ───► │   /api/user              │
│ mechanic :3002  │ ─ /api/mechanic ──► │   /api/mechanic          │
│ admin    :3003  │ ──── /api/admin ──► │   /api/admin             │
└─────────────────┘                     └────────────┬─────────────┘
                                                     │
                                    am_user · am_mech · am_admin
```

## 1. Backend → Render

The repo ships a blueprint at `render.yaml`. Point Render at the repo and it creates the
service; otherwise configure a Web Service by hand:

| Setting | Value |
|---|---|
| Root directory | *(repo root)* |
| Build command | `npm ci` |
| Start command | `npm run start:backend` |
| Health check path | `/health` |

### Required environment variables

| Variable | Notes |
|---|---|
| `USER_DATABASE_URL` | Postgres connection string for `am_user` |
| `MECHANIC_DATABASE_URL` | …for `am_mech` |
| `ADMIN_DATABASE_URL` | …for `am_admin` |
| `JWT_SECRET` | Shared by all three modules — one value |
| `INTERNAL_DISPATCH_SECRET` | Guards the internal dispatch endpoints |
| `CORS_ORIGINS` | Comma-separated Vercel origins. **Leave unset and CORS is open to all.** |
| `PG_POOL_MAX` | Three pools now live in one process — keep it small (5) on free tiers |

`PORT` is injected by Render. The modules' cross-calls (`USER_INTERNAL_API`,
`MECHANIC_INTERNAL_API`) default to loopback on that port and need no configuration.

## 2. Web apps → Vercel

Create **four** Vercel projects from the same repo, each differing only by root directory:

| Project | Root directory | Env |
|---|---|---|
| landing | `apps/web/landing` | `NEXT_PUBLIC_*_APP_URL` |
| user | `apps/web/user` | `NEXT_PUBLIC_USER_API=https://<backend>/api/user` |
| mechanic | `apps/web/mechanic` | `NEXT_PUBLIC_MECHANIC_API=https://<backend>/api/mechanic` |
| admin | `apps/web/admin` | `NEXT_PUBLIC_ADMIN_API=https://<backend>/api/admin` |

Vercel detects the npm workspace and installs from the repo root automatically.
After the four URLs exist, set `CORS_ORIGINS` on Render to that comma-separated list.

## Known free-tier constraints

**Uploads do not survive a restart.** `multer` writes to `apps/backend/<module>/uploads/`
and Render's free tier has no persistent disk, so every uploaded issue photo is lost on
each redeploy or idle spin-down. Move to object storage (Cloudinary / S3 / Supabase
Storage) before relying on uploads in production.

**Three databases on one free Postgres.** The modules deliberately use three separate
databases, and Render's free plan gives one instance. Options:

1. Use a provider that allows several databases per free project (Neon, Supabase) and
   point the three URLs at `…/am_user`, `…/am_mech`, `…/am_admin`.
2. Put the three in one database as three *schemas* and append
   `?options=-c%20search_path%3Dam_user` to each URL. The modules share table names
   (`notifications`), so they cannot share a single schema.

**Cold starts.** A free service spins down after ~15 minutes idle and takes ~50s to wake.
Consolidating to one service means one such wait instead of three, and the roadside
dispatch hop is now in-process rather than a second service that might be asleep.
