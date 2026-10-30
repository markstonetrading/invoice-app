# Deploying Component Invoice Manager to GitHub Pages

This is the complete manual for putting the app on GitHub Pages — from an empty
GitHub account to a live URL, plus how every later update reaches the site.
The short version: **push to `main` with the tests green, and GitHub does the rest.**

The site is pure static files (no build step), so "deploying" means uploading the
repository root as-is. A GitHub Actions workflow (`.github/workflows/deploy.yml`)
automates that, but **only after the full test suite passes** — a broken build
can never replace the live site.

---

## Prerequisites

| You need | Why | Check |
|---|---|---|
| A GitHub account | hosts the repo, the CI and the site | github.com |
| Git | pushing the code | `git --version` |
| Node.js ≥ 18 | running the test suite locally before pushing | `node --version` |

Everything else (Bootstrap, Font Awesome) loads from CDNs; the SQLite engine is
already vendored in `js/vendor/`, so the deployed app works offline once loaded.

---

## Step 1 — Create the GitHub repository

1. Log in to GitHub → **New repository** (`github.com/new`).
2. Name it (e.g. `invoice-app`), leave it **Public** (GitHub Pages on the free
   plan serves public repos), and **do not** add a README / .gitignore / license —
   this repository already has them.
3. Click **Create repository**. Note the URL, e.g.
   `https://github.com/<you>/invoice-app`.

## Step 2 — Push the code

The local repo already has history on the `main` branch. Connect and push:

```bash
git remote add origin https://github.com/<you>/invoice-app.git
git push -u origin main
```

(If you cloned this app from somewhere else, just replace the remote:
`git remote set-url origin <new-url>` then `git push -u origin main`.)

## Step 3 — Enable GitHub Pages

1. In the repository, open **Settings → Pages** (left sidebar, "Code and automation").
2. Under **Build and deployment → Source**, pick **GitHub Actions**
   (not "Deploy from a branch" — the workflow in this repo handles deployment).
3. That's it — no other setting is needed. Close the page.

> If you don't see the **GitHub Actions** option, create it anyway: the option
> appears once a workflow file (already committed at
> `.github/workflows/deploy.yml`) is pushed to the repository.

## Step 4 — Watch the first deploy and open the site

1. Go to the **Actions** tab. You'll see **Deploy to GitHub Pages** running
   (triggered by your push). It has two jobs:
   - **Automated tests** — `npm ci` + `npm test` (68 tests, ~10s on the runner);
   - **Build & deploy** — uploads the repository root and publishes it.
     It only starts if the tests passed (`needs: test`).
2. When both jobs are green (✓), the site is live at:
   ```
   https://<you>.github.io/<repo>/
   ```
   The exact link is shown on **Settings → Pages** and on the deploy's summary
   page under **deployments → github-pages**.

Open that URL — the app boots to the invoice list, and data starts saving to
*that browser's* localStorage (each browser/device has its own database; use
**Export DB / Import DB** to move data between them).

---

## How later updates reach the site

Everyday flow — nothing extra to remember:

```bash
npm test                 # 1. local gate: all green before pushing
git add -A
git commit -m "..."      # 2. one focused commit
git push                 # 3. push to main -> Actions redeploys automatically
```

- **Push to `main`** triggers the workflow: tests re-run, then the site is
  replaced if (and only if) they pass.
- **Manual re-deploy** without a commit: **Actions → Deploy to GitHub Pages →
  Run workflow** (the workflow also listens to `workflow_dispatch`).
- Deploys are serialised (`concurrency: pages`) — pushing twice quickly just
  cancels the older run; the newest push always wins.
- A red **Automated tests** job means nothing was deployed — the live site
  still serves the last green commit. Fix the tests and push again.

### Preview changes locally before pushing

```bash
python3 -m http.server 8000     # open http://localhost:8000
npm test                        # the same suite CI runs
```

The deployed app and the local copy are identical static files — what works at
`localhost:8000` is what goes live.

---

## Optional — custom domain

To serve the app at e.g. `https://invoices.yourcompany.com`:

1. **Settings → Pages → Custom domain** — enter the domain and save.
2. At your DNS provider, add a CNAME record pointing the subdomain at
   `<you>.github.io` (or A records for an apex domain — GitHub shows the exact
   IPs in the Pages settings).
3. Wait for DNS to propagate, then tick **Enforce HTTPS** in the same panel.

The app uses **relative paths only** (`css/app.css`, `js/vendor/…`), so it works
unchanged at a repository sub-path (`/<repo>/`) and at a custom domain root.
`index.html` already sets a favicon and correct `<title>` — nothing to adjust.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Actions tab shows nothing after pushing** | Workflow file missing on `main` — confirm `.github/workflows/deploy.yml` is committed (`git ls-files .github`). |
| **"Automated tests" job is red** | A test failed — open the job log, or run `npm test` locally. **Nothing was deployed**; the site still runs the last green commit. |
| **Tests green but no "Build & deploy" job** | Pages Source isn't set to **GitHub Actions** (Step 3). |
| **Deploy fails with a permissions error** | Check **Settings → Actions → General → Workflow permissions** — the workflow declares the permissions it needs (`pages: write`, `id-token: write`), but organisation policies can override them. |
| **404 at the site URL** | URL is `https://<you>.github.io/<repo>/` — note the repository name in the path. Give the first deploy a minute after the jobs turn green. |
| **Site is stale after a push** | Check **Actions** — a queued/running deploy may still be in progress; an older run is auto-cancelled by the newer one. |
| **Styles/icons missing on the live site** | The CDN stylesheets (Bootstrap, Font Awesome) are integrity-checked — if a CDN link was edited or a version bumped without recomputing the `integrity` hash, browsers refuse the file. Recompute per AGENTS.md. The database engine itself is vendored, so invoicing still works. |

---

## What the pipeline does NOT handle

- **No secrets**: the app is fully client-side; no API keys, no server, no
  environment configuration — nothing to set up or rotate.
- **No user data on the server**: all invoice data lives in each visitor's
  browser (localStorage) unless they export a `.db` file. GitHub Pages only
  hosts the app's code.
- **No build artifacts to clean**: the workflow uploads the repo root as-is;
  `node_modules/` is gitignored and `package.json` is test-harness only.
