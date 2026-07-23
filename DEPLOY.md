# Deploying Prospect to DigitalOcean App Platform

Prospect ships as **one Docker image**: a Node stage builds the React frontend, and the Python
API serves both that frontend and `/api` from a single origin (no CORS). The 384MB analytics
DuckDB is **not** in the image or git — the container downloads it at boot from a URL you
control (a free GitHub Release asset). App Platform builds straight from your GitHub repo and
redeploys on every push.

```
  GitHub repo (code)  ──build──▶  App Platform service  ──serves──▶  https://prospect-xxxx.ondigitalocean.app
  GitHub Release (current.duckdb) ──download at boot──▶  /app/data/current.duckdb
```

---

## One-time: get the code onto GitHub

You need a GitHub repo for App Platform to build from. The local repo already exists (`main`
branch) but has no remote yet.

**Option A — GitHub website (no CLI):**
1. Go to <https://github.com/new>, name it `prospect`, keep it **Private** (recommended), and
   **do not** initialize with a README. Click *Create repository*.
2. Back in this folder, connect and push:
   ```bash
   cd /Users/maximbaginskiy/hobby/prospect
   git remote add origin https://github.com/kachan1208/steam-prospect.git
   git add -A && git commit -m "Add DigitalOcean deploy config"
   git branch -M main
   git push -u origin main
   ```
   (The 5.2GB source DB and the 384MB marts are gitignored, so only source code is pushed.)

**Option B — GitHub CLI:** `brew install gh && gh auth login`, then
`gh repo create prospect --private --source=. --remote=origin --push`.

---

## One-time: publish the analytics DB as a Release asset

The container fetches `current.duckdb` on boot. GitHub Releases host files up to 2GB for free.

With the GitHub CLI (easiest — resolves the symlink and uploads the real file):
```bash
cd /Users/maximbaginskiy/hobby/prospect
gh release create data-latest "$(readlink -f data/current.duckdb)#current.duckdb" \
  --title "Analytics data" --notes "DuckDB marts for Prospect"
```
The asset URL will be:
`https://github.com/kachan1208/steam-prospect/releases/download/data-latest/current.duckdb`

> No CLI? Create a release named `data-latest` in the GitHub UI and drag the real file
> (`data/prospect_YYYYMMDD.duckdb`, ~384MB) in, renaming the upload to `current.duckdb`.

---

## Create the App Platform app

**UI path (recommended for the first deploy):**
1. DigitalOcean → **Apps** → **Create App** → **GitHub**. Authorize DO to access your GitHub
   account (this is "adding your GitHub"), then pick the `prospect` repo and the `main` branch.
2. DO detects the **Dockerfile** automatically — accept it. Choose the **basic-xxs** size
   (512MB, ~$5/mo; bump to a 1GB plan if it runs out of memory).
3. In **Environment Variables**, add:
   - `PROSPECT_DUCKDB_URL` = the Release asset URL from above.
4. Create the app. First build + boot takes a few minutes (it downloads the DB once). When it's
   live you get a free `https://prospect-xxxx.ondigitalocean.app` URL with HTTPS.

**CLI path:** edit the two placeholders in `.do/app.yaml`, then
`doctl apps create --spec .do/app.yaml`.

---

## Updating

- **Code**: `git push` → App Platform rebuilds and redeploys automatically.
- **Data** (after re-running `task etl` locally): re-upload the asset, then redeploy so the new
  DB is fetched:
  ```bash
  gh release upload data-latest "$(readlink -f data/current.duckdb)#current.duckdb" --clobber
  ```

---

## Things to know about this deployment

- **State is ephemeral.** App Platform has no persistent disk, so the control-plane SQLite
  (`prospect_control.db` — watchlists, outreach board, alerts, notes) **resets to empty on every
  redeploy**. It self-seeds the solo org on boot, so nothing breaks; you just lose mutations
  across deploys. To make it durable later: add a DO **Managed Postgres**, then set
  `PROSPECT_CONTROL_DSN=postgresql://…` (no code change — the config already supports it).
- **No login.** You chose "fully open," so anyone with the URL can view *and* edit the boards.
  To lock it down later, put it behind DO's app-level auth or add basic-auth at the edge.
- **Analytics Chat won't work hosted.** It drives your local `claude` CLI (your subscription),
  which doesn't exist on the server — the chat panel will just report unavailable. To enable it,
  set `PROSPECT_CHAT_MODE=api` + `ANTHROPIC_API_KEY` (metered API billing).
- **Cost:** ~$5/mo for the basic-xxs instance. The GitHub repo + Release hosting is free.
