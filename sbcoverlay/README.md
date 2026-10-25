# fut-sbc-db

Hourly player database and price table for the **FUT SBC Solver** Firefox extension. A GitHub Actions workflow builds it from FUT.GG and publishes it on GitHub Pages; the extension downloads it, so it needs no crawling of its own.

Published files:
- `db.json`: player details (rating, rarity, club, league, nation, positions, name)
- `prices.json`: every player's price, console and PC, plus tradability
- `meta.json`: build time and counts

## Setup (one time, ~5 minutes)
1. **Create a public GitHub repository**, for example `fut-sbc-db`. GitHub Pages is free for public repositories.
2. **Push this folder:**
   ```bash
   cd fut-sbc-db
   git init && git add . && git commit -m "fut-sbc-db"
   git branch -M main
   git remote add origin https://github.com/<you>/fut-sbc-db.git
   git push -u origin main
   ```
3. **Enable Pages from Actions:** go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. **Run the first build:** go to **Actions → Build player database → Run workflow**. It takes about 5–8 minutes, then repeats hourly.
5. **Point the extension at it:** click the extension icon, paste `https://<you>.github.io/fut-sbc-db`, then press **Save** and **Allow access**.

Check it worked by opening `https://<you>.github.io/fut-sbc-db/meta.json`.

## Notes
- **Edition year:** `FUT_YEAR` in `.github/workflows/build.yml` must match the edition (27 for FC27).
- **Failed runs:** if FUT.GG fails, the run stops and the last good database stays published.
- **Merging:** each build merges with the previous one, so coverage only grows. Prices always come fresh from the current run.
- **Scheduled runs pause** after 60 days without repository activity. Push any commit, or click **Enable workflow** under Actions, to restart them.
- **Public data:** the published files are public and derived from FUT.GG's data, so keep the repository for personal use.
