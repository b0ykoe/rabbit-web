cd D:\Personal\repositories\LastChaos\BotProject\portal-v2

# Install root deps
npm install

# Install server deps
cd server && npm install && cd ..

# Install client deps
cd client && npm install && cd ..

# Copy and configure .env
copy .env.example .env
# Edit .env with your DB credentials

# Run migrations + seed
npm run migrate
npm run seed

# Generate Ed25519 keypair
npm run keygen

# Start dev (runs both server + client)
npm run dev

## Navigation-cache multipart deployment and upload

Cloudflare Free/Pro limits each request body to 100 MB, so navigation caches use
a manifest plus 64 MiB upload parts. Generate them from the schema-v4 cache
directory on the admin PC:

```powershell
cd D:\Personal\repositories\LastChaos\BotProject\portal-v2
.\scripts\New-NavigationCacheParts.ps1 -PackageName Nemesis
```

If Windows PowerShell blocks local scripts, run the same generator explicitly:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\New-NavigationCacheParts.ps1 -PackageName Nemesis
```

Optional parameters select a different source, output directory, or part size:

```powershell
.\scripts\New-NavigationCacheParts.ps1 `
  -CacheDirectory "$env:APPDATA\chrome_143\mapviewer_nav_cache\v4" `
  -OutputDirectory '.\navigation-cache-parts' `
  -PackageName Nemesis `
  -PartSizeMiB 64
```

The command creates a timestamped folder containing
`navigation-cache-parts.json` and numbered `.part0001.bin` files. In
**Admin → Navigation Caches**:

1. Select the intended game server.
2. Press **Select parts folder** and select that timestamped folder.
3. Press **Upload parts**. The browser sends the files sequentially and can
   retry without changing the currently published cache package.
4. Once every part is present, press **Analyze & publish**.

The server rechecks every part SHA-256 while reassembling the original ZIP,
checks the complete ZIP size and SHA-256, extracts only `.mvnav` entries into
private temporary storage, and validates every cache header, filename, source
fingerprint, whole-file SHA-256 and payload SHA-256. Only then is the published
package replaced atomically. Temporary upload sessions expire after 24 hours.

After deploying this feature, install the new server dependency and rebuild:

```powershell
cd server
npm ci
cd ..\client
npm ci
npm run build
```

The reverse proxy must accept one part plus multipart overhead and allow enough
time for final analysis. In the relevant Nginx `server` or API `location`
block, use for example:

```nginx
client_max_body_size 90m;
proxy_request_buffering off;
proxy_read_timeout 1800s;
proxy_send_timeout 1800s;
```

Reload Nginx after validating its configuration, then restart the Node/PM2
process. Each default part remains below Cloudflare's current 100 MB Free/Pro
request limit; the total package may be much larger because every part uses a
separate request.
See: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/

