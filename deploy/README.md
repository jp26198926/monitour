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

```bash
cd /opt/monitour/agent

# Start from a clean tree (removes previous out/ and dist/ artifacts)
npm run clean

# Windows installer
npm run dist -- --win

# macOS DMG
npm run dist -- --mac

# Linux AppImage
npm run dist -- --linux
```

Compiled JS lands in `agent/out/`; installers land in `agent/dist/`. Distribute the
installer to end-user machines (and upload it to the server — the agent self-updater
downloads it from the server's `downloadUrl`, not from this folder).

Note: installers are Electron-based, so expect roughly 90–130 MB each — the Electron/
Chromium runtime is the floor. Stale installers must never be present while packaging;
`npm run clean` guarantees this.

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
