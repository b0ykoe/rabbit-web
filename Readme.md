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

## Navigation-cache ZIP deployment and upload

The super-admin page **Admin → Navigation Caches** accepts one ZIP archive per
game server. Create the archive from the generated schema-v4 cache directory:

```powershell
$cache = Join-Path $env:APPDATA 'chrome_143\mapviewer_nav_cache\v4'
Compress-Archive -Path "$cache\*.mvnav" -DestinationPath '.\nemesis-navigation-cache-v4.zip' -CompressionLevel Optimal
```

Select the intended game server, choose the ZIP, and press **Upload cache**. The
server extracts only `.mvnav` entries into private temporary storage, validates
every cache header, filename, source fingerprint, whole-file SHA-256 and payload
SHA-256, then atomically replaces the published package. The Loader still
downloads the verified `.mvnav` files individually; the ZIP is only the admin
upload transport and is deleted after processing.

After deploying this feature, install the new server dependency and rebuild:

```powershell
cd server
npm ci
cd ..\client
npm ci
npm run build
```

The reverse proxy must accept the archive and allow enough time for upload plus
validation. In the relevant Nginx `server` or API `location` block, use limits
appropriate for the deployment, for example:

```nginx
client_max_body_size 2048m;
proxy_request_buffering off;
proxy_read_timeout 1800s;
proxy_send_timeout 1800s;
```

Reload Nginx after validating its configuration, then restart the Node/PM2
process. Cloudflare also limits a single request body by plan (currently 100 MB
on Free/Pro and 200 MB on Business). If the finished ZIP exceeds that limit,
route the admin upload through a protected DNS-only origin hostname or implement
a chunked upload; raising only the Nginx limit cannot bypass Cloudflare's limit.
See: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/

