# Setup

## GitHub Pages

1. Create a GitHub repository and upload all files from this folder directly into the repository root. Keep the files flat; do not create folders.
2. Open **Settings → Pages**. Choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
3. Wait for GitHub Pages to publish and open the site URL.

`providers.json` is publicly served because the map loads it in the browser. The source workbook is not included in this folder.

## Cloudflare Worker

1. In Cloudflare, create a Worker, deploy the starter, then open **Edit code**.
2. Paste the full contents of the separate `worker.txt` into the editor and deploy.
3. In the Worker settings, add the following variables. Keep these names exactly as shown:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | Your Supabase project URL (text variable) |
   | `SUPABASE_PUBLISHABLE_KEY` | Your Supabase publishable key (store as a Secret) |
   | `ALLOWED_ORIGINS` | Your GitHub Pages origin only, e.g. `https://account.github.io` (text variable, no repository path) |

   Do not add a Supabase secret/service-role key. Supabase row-level security continues to control database access.
4. In the Worker settings, add the custom domain `api.shroomberg.com` under **Domains & Routes**. Then reload the site; `worker-config.js` is already set to that domain.

If the website later uses a custom domain, update `ALLOWED_ORIGINS` to that site origin (for example `https://shroomberg.com`) and add it to Supabase's Authentication redirect URL allow-list. `api.shroomberg.com` is already allowed by the site's Content Security Policy.

## Supabase email redirects

In **Authentication → URL Configuration**, set the Site URL to the published site URL and add that exact URL (including any repository path) to Additional Redirect URLs, ending in `/**`. Email confirmation and password reset return to this address.
