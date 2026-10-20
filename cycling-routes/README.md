# Club Routes

A map of all the club's cycling routes, drawn on top of each other with Leaflet. The site is hosted free on GitHub Pages. Club members add routes by dropping GPX files onto the page, and the routes appear for everyone a minute or two later. Nobody needs a GitHub account to add routes.

## How it works

```
member drops GPX ─► upload service (Cloudflare Worker) ─► commit to routes/ ─► GitHub Action rebuilds ─► everyone sees it
                     checks club code + file
```

- Every `.gpx` file in `routes/` is part of the shared map.
- On each commit, a GitHub Action runs `scripts/build.mjs`, which merges all GPX files into one compact `data/routes.json` (tracks simplified to about 8 m) and publishes the site.
- The upload service is a small free Cloudflare Worker (`upload-worker/worker.js`). It holds the GitHub token, so the token is never exposed on the public page. It checks the club code, rejects files that aren't GPX, skips files that are already on the map, gives files clean names (`Søndag Amager rundt.gpx` → `soendag-amager-rundt.gpx`) and commits them.
- The member who uploads sees the route straight away, drawn as a dashed line. It turns into a normal line once the rebuild has finished.
- Without an upload service configured, dropped files are only kept in the visitor's own browser.

## Features

- All routes overlaid. In "Overlap view" each line is semi-transparent, so roads used by many routes look darker.
- "Distinct colours" gives each route its own colour.
- Click a line or a list item to highlight it and see distance, climbing and a GPX download link.
- Search, sort by name, distance or climbing, and show or hide individual routes.
- Three base maps: Light, OpenStreetMap, CyclOSM.

---

## Setup, part 1: the site on GitHub Pages

1. On github.com, create a new **public** repository, e.g. `club-routes`. Free GitHub Pages needs a public repository.
2. Push this folder to it:
   ```
   cd cycling-routes
   git init -b main
   git add .
   git commit -m "Club routes map"
   git remote add origin https://github.com/<your-user>/club-routes.git
   git push -u origin main
   ```
3. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Open **Actions → Build and publish map → Run workflow**. This is only needed the first time.
5. The site is at `https://<your-user>.github.io/club-routes/` after about a minute.

## Setup, part 2: shared uploads

### a) A GitHub token that can only add files to this repository

1. GitHub → your profile picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access:** *Only select repositories* → `club-routes`.
3. **Permissions → Repository permissions → Contents:** *Read and write*. Leave everything else at *No access*.
4. Choose an expiry date and write it down. Uploads stop working when the token expires, until you make a new one and paste it in at step b4.
5. Generate the token and copy it (it starts with `github_pat_`).

### b) The upload service on Cloudflare (free plan)

1. Create a free account at cloudflare.com.
2. **Workers & Pages → Create → Create Worker**. Name it `club-routes-upload` and click **Deploy**.
3. Click **Edit code**, replace all the code with the contents of `upload-worker/worker.js`, and click **Deploy**.
4. Go to the Worker's **Settings → Variables and Secrets** and add:

   | Name | Type | Value |
   |---|---|---|
   | `GITHUB_TOKEN` | Secret | the token from step a |
   | `UPLOAD_CODE` | Secret | a club code to share with members, e.g. `pedal42` |
   | `GITHUB_REPO` | Text | `<your-user>/club-routes` |
   | `ALLOWED_ORIGIN` | Text | `https://<your-user>.github.io` (no path, no trailing slash) |

   Click **Deploy** again so the settings take effect.
5. Copy the Worker's address, e.g. `https://club-routes-upload.<something>.workers.dev`. Opening it in a browser should show `{"ok":true,...}`.

If you prefer the command line: set the values in `upload-worker/wrangler.toml`, then run `npx wrangler deploy` and `npx wrangler secret put GITHUB_TOKEN` / `UPLOAD_CODE` inside `upload-worker/`.

### c) Point the site at the upload service

On github.com, open `config.js`, click the pencil icon, paste in the address:
```js
uploadUrl: 'https://club-routes-upload.<something>.workers.dev'
```
and commit. After the rebuild, the drop area says "They are added to the club map for everyone".

---

## Day-to-day use

- **Adding routes:** drop GPX files on the page. The first time, the page asks for the club code and an optional name. Both are remembered on that device, and the name goes into the commit message. Large batches are sent 10 files at a time.
- **The first 150 routes:** drop them all on the page at once, or upload them on github.com via `routes/` → **Add file → Upload files**. The github.com uploader takes a limited number of files at a time, so it may need a few rounds.
- **Removing or renaming a route:** delete or rename the file in `routes/` on github.com. The upload service can only add files, never change or delete them.
- **Changing the club code:** change `UPLOAD_CODE` in Cloudflare. Members are asked for the new code next time they upload.
- **Example routes:** delete the three `example-*.gpx` files before the club starts using the map.

## Limitations

- Anyone with the club code can add routes. Every addition is a commit in the repository history, so unwanted files can be found and deleted.
- The repository is public, so all GPX files can be downloaded by anyone who finds the site.
- Climbing is calculated from GPX elevation with a 3 m noise filter, so figures will differ somewhat from Strava or Garmin.
- Route names come from the `<name>` in the GPX file, falling back to the file name.

## Preview locally

```
node scripts/build.mjs
python3 -m http.server
```
Then open http://localhost:8000.
