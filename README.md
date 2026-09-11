# AutoMate — Backend

The REST API for AutoMate / FixMyRide. The user, mechanic and admin modules keep their
own folders, their own connection pool and their own database — but run as **one
deployable service**, namespaced by role:

| Module | Base path | Database |
|---|---|---|
| User | `/api/user` | `am_user` |
| Mechanic | `/api/mechanic` | `am_mech` |
| Admin | `/api/admin` | `am_admin` |
| — | `/health` | — |

```
apps/backend/server     the single entry point: mounts the three routers
apps/backend/user       user routes, pool, auth (role: user)
apps/backend/mechanic   mechanic routes, pool, auth (role: mechanic)
apps/backend/admin      admin routes, pool, auth (role: admin)
packages/shared-*       types and utils shared with the web apps
```

## Why one service instead of three

The modules were originally three separate Express apps on ports 4001/4002/4003. On a
free host that meant three cold starts, three sets of env vars, and — the real problem —
the roadside dispatch flow makes HTTP calls *between* the user and mechanic modules. If
the mechanic service was asleep, dispatch timed out.

Running them in one process makes those calls loopback. Nothing inside the three modules
changed; only the deployment unit did. `npm run dev:user:split` and friends still run a
module standalone if you need it.

## Local development

```bash
npm install                      # from the repo root
cp .env.example apps/backend/server/.env
npm run dev                      # http://localhost:4000
```

Create and seed the three databases from `docs/*.sql` first. Demo password for all
seeded accounts is `password123`.

```bash
curl http://localhost:4000/health
```

## Deploying to Render

`render.yaml` is a blueprint — point Render at this repo and it configures the service.
Manual setup:

| Setting | Value |
|---|---|
| Root Directory | *(repo root)* |
| Build Command | `npm ci` |
| Start Command | `npm run start:backend` |
| Health Check Path | `/health` |

Set `USER_DATABASE_URL`, `MECHANIC_DATABASE_URL`, `ADMIN_DATABASE_URL`, `JWT_SECRET`,
`INTERNAL_DISPATCH_SECRET` and `CORS_ORIGINS` in the dashboard. `PORT` is injected.

**Read `docs/DEPLOYMENT.md` before deploying** — it covers the two free-tier constraints
that will bite otherwise: uploads are lost on restart (no persistent disk), and the three
databases need either a provider allowing multiple DBs or a single-instance schema layout.

## Notes

- The service runs TypeScript directly via `tsx`; there is no build step.
- All three modules share one `JWT_SECRET`, but each rejects tokens issued for another
  role, so a user token is refused by `/api/mechanic` and `/api/admin`.
