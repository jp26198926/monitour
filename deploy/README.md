# Monitour Deployment Guide — Ubuntu + PM2 + Nginx

## Prerequisites

```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install MongoDB 6+
curl -fsSL https://www.mongodb.org/static/pgp/server-6.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-6.0.gpg --dearmor
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
sudo apt-get update
sudo apt-get install -y mongodb-org
sudo systemctl enable mongod
sudo systemctl start mongod

# Install Nginx
sudo apt-get install -y nginx

# Install PM2 globally
sudo npm install -g pm2
```

## Step 1: Build the Application

```bash
git clone <repo-url> /opt/monitour
cd /opt/monitour
npm install
npm run build
```

## Step 2: Configure the Server

```bash
cd /opt/monitour/server
cp .env.example .env
nano .env
```

Set these values:
- `JWT_SECRET`: `openssl rand -base64 48`
- `MONGO_URI`: your MongoDB connection string
- `CORS_ORIGIN`: `https://your-domain.com`
- `PUBLIC_URL`: `https://monitour.yourdomain.com` — the externally reachable server URL baked into generated agent packages (falls back to the request Host header)
- `NODE_ENV`: `production`

## Step 3: Start with PM2

```bash
cd /opt/monitour
pm2 start deploy/pm2.config.js
pm2 save
pm2 startup   # Follow the instructions to enable auto-start
```

Verify:
```bash
pm2 status
pm2 logs monitour-server
curl http://127.0.0.1:4430/api/health
```

## Step 4: Deploy the Dashboard

```bash
# Copy built dashboard to Nginx web root
sudo mkdir -p /var/www/monitour
sudo cp -r /opt/monitour/dashboard/dist /var/www/monitour/dashboard
```

## Step 5: Configure Nginx

```bash
sudo cp /opt/monitour/deploy/nginx-monitour.conf /etc/nginx/sites-available/monitour
sudo nano /etc/nginx/sites-available/monitour  # Update server_name and TLS cert paths

sudo ln -s /etc/nginx/sites-available/monitour /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default  # Remove default site
sudo nginx -t
sudo systemctl reload nginx
```

## Step 6: TLS Certificate (Let's Encrypt)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d monitour.yourdomain.com
# Auto-renewal is set up automatically
```

## Step 7: Firewall

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

## Packaging the Agent (Electron Builder)

Compiled JS lands in `agent/out/`; installers land in `agent/dist/`. Installers are
Electron-based — expect roughly 90–130 MB each. Always start from a clean tree
(`npm run clean` guarantees no stale artifacts):

```bash
cd /opt/monitour/agent
npm run clean
npm run dist -- --win     # or --mac / --linux
```

### Build matrix — build each installer ON its target OS

Native modules (`node-pty`, `koffi`, `node-screenshots`, `@nut-tree-fork/nut-js`) ship
prebuilt binaries (`npmRebuild: false` in `agent/electron-builder.yml`) — they must
match the target OS. **There is no cross-building**: a Windows installer built on a
Mac will not work.

| Installer | Build on | Command | Artifact in `agent/dist/` |
|---|---|---|---|
| Windows NSIS (x64) | **Windows** | `npm run dist -- --win` | `Monitour Agent Setup 0.2.3.exe` |
| macOS DMG (x64 + arm64) | **macOS** | `npm run dist -- --mac` | `Monitour Agent-0.2.3.dmg` and `Monitour Agent-0.2.3-arm64.dmg` |
| Linux AppImage (x64) | **Linux** | `npm run dist -- --linux` | `Monitour Agent-0.2.3.AppImage` |

Notes:
- Exact file names include the version and may vary slightly with electron-builder
  versions — the assemble script and the server match by **pattern** (`.exe` / `.dmg`
  / `.AppImage`), not by exact name.
- One `--mac` run produces both dmg arches (see `agent/electron-builder.yml`).
- Unsigned builds: Windows shows a SmartScreen warning ("More info" → "Run anyway";
  per-machine install needs admin/UAC). macOS Gatekeeper blocks the app — right-click
  → Open, or `xattr -dr com.apple.quarantine "/Applications/Monitour Agent.app"`.

## Agent Packages (Auto-Enrollment)

The dashboard's **Settings → Agent Software** section builds a pre-configured zip
(installer + `monitour-bootstrap.json` + launcher) so end users install with zero
input — the agent auto-enrolls on first run. The server needs the stock installers
in `server/agent-packages/<platform>-<arch>/` (one installer per slot):

```
server/agent-packages/
├── win32-x64/     Monitour Agent Setup 0.2.3.exe
├── win32-arm64/   (future — config currently builds x64 only)
├── darwin-x64/    Monitour Agent-0.2.3.dmg
├── darwin-arm64/  Monitour Agent-0.2.3-arm64.dmg
├── linux-x64/     Monitour Agent-0.2.3.AppImage
└── linux-arm64/   (future — config currently builds x64 only)
```

### Delivery path A — dashboard upload (primary, works with a remote server)

1. Build installers on each target OS (build matrix above).
2. In the dashboard: **Settings → Agent Software** → upload the installer into the
   matching slot. Uploading **replaces** any existing installer in that slot
   (the slot table shows what's present; Delete removes it).
3. **Settings → Enrollment** → create a key (optionally with group/labels),
   then **Agent Software** → the slot row → **Package** → Download Zip.

Unzip on the target machine and run `install.bat` (Windows) or `install.sh` (macOS/
Linux). The launcher copies the bootstrap into `~/.monitour-agent/` and runs the
installer; the agent deletes the bootstrap after enrollment.

### Delivery path B — assemble script + copy (local dev server / staging)

```bash
# From the repo root, after building on each platform:
npm run assemble:packages
# → copies agent/dist/ artifacts into server/agent-packages/<slot>/ (copy, not move)
# → prints a summary table and which slots are still MISSING

# Remote server alternative to the upload UI:
scp -r server/agent-packages/* user@prod:/opt/monitour/server/agent-packages/
```

The script matches artifacts by pattern, warns if several candidates match one slot
(newest wins), and replaces any existing installer in the slot.

Notes:
- The enrollment key is a bearer secret — anyone holding the package can enroll
  machines into that group. Revoke keys you no longer use.
- Windows auto-start uses Task Scheduler (SYSTEM, at boot) — the GUI offers
  "Install as Service" from the agent's Settings view.
- The config at rest (`~/.monitour-agent/config.json`) stores the server URL and
  enrollment material obfuscated. This is obscurity, not encryption.
- **Breaking change**: one-time enrollment tokens and the open/locked enrollment
  mode were removed — enrollment keys are the only credential. Agents built
  before this change cannot enroll (401); re-deploy them via a package or
  re-enroll manually with a key.

## Monitoring & Maintenance

```bash
# Server logs
pm2 logs monitour-server

# Restart server
pm2 restart monitour-server

# MongoDB backup
mongodump --db monitour --out /backup/$(date +%Y%m%d)

# Certificate data backup (CRITICAL)
tar czf /backup/monitour-certs-$(date +%Y%m%d).tar.gz /opt/monitour/server/data/
```

> **Important**: Back up the `server/data/` folder — it contains the certificate hierarchy.
> If lost, all enrolled agents must be re-enrolled.

## Scaling Notes

- Socket.IO uses a single process (sticky sessions required for multi-instance)
- For horizontal scaling, add `@socket.io/redis-adapter` and a shared Redis instance
- The Nginx config handles WebSocket upgrade for Socket.IO
- For high-volume deployments, put a load balancer (HAProxy/ALB) in front of multiple Nginx instances
