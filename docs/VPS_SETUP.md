# VPS Setup Guide for MatchBuddy Backend

This guide outlines how to prepare a clean Ubuntu VPS (e.g., 20.04 or 22.04 LTS) to run the MatchBuddy backend with Nginx, PM2, PostgreSQL (with PostGIS), and HTTPS.

---

## 1. Initial Server Setup & Core Tools

Log in to your VPS via SSH and update the system:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essentialufw
```

Configure the firewall:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## 2. Install Node.js and PM2

Install Node.js (version 20 LTS is recommended):
```bash
# Using NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify installations:
```bash
node -v
npm -v
```

Install PM2 globally:
```bash
sudo npm install -g pm2
```

Configure PM2 to automatically start on server reboot:
```bash
pm2 startup
# Run the command generated in the output of the command above
```

---

## 3. Database Setup (Choose Option A or B)

### Option A: Dockerized Postgres + PostGIS (Recommended)
This option matches your local environment. It is the easiest to set up and automatically handles the PostGIS spatial extensions.

1. Install Docker and Docker Compose on the VPS:
   ```bash
   sudo apt install -y docker.io
   sudo systemctl enable --now docker
   sudo usermod -aG docker $USER
   # Apply group membership without logging out
   newgrp docker
   ```
2. Once you run the deployment script for the first time, it will pull the repository. Navigate to the deployment path on the VPS (e.g., `/var/www/matchbuddy-backend`) and start the Postgres container:
   ```bash
   docker compose up -d postgres
   ```
3. Your database will be running inside Docker on port `5433` (as per `compose.yaml`).

---

### Option B: Native Postgres + PostGIS
If you prefer not to use Docker, install PostgreSQL and the matching PostGIS version directly on the VPS host:

1. Install PostgreSQL and PostGIS:
   ```bash
   sudo apt install -y postgresql postgresql-contrib postgis postgresql-16-postgis-3
   ```
2. Start and enable PostgreSQL:
   ```bash
   sudo systemctl enable --now postgresql
   ```
3. Log in as the postgres user and set up the role:
   ```bash
   sudo -i -u postgres
   psql
   ```
4. Create the role matching your environment config:
   ```sql
   CREATE USER postgres WITH PASSWORD 'your_secure_password_here';
   CREATE DATABASE matchbuddy;
   GRANT ALL PRIVILEGES ON DATABASE matchbuddy TO postgres;
   \c matchbuddy
   -- Enable spatial extensions
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS postgis;
   \q
   exit
   ```
5. Ensure PostgreSQL allows connections on `127.0.0.1`. (Usually active by default).

---

## 4. Git Authentication Setup

Since the repository is on GitHub, you need to authorize the VPS to clone/pull the code.
If the repository is public, no action is needed. If it is private:

1. Generate an SSH key on the VPS:
   ```bash
   ssh-keygen -t ed25519 -C "vps-matchbuddy"
   ```
2. View the public key:
   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```
3. Copy the output and add it as a **Deploy Key** (with read access) in your GitHub repository settings under:
   *Repository -> Settings -> Deploy keys -> Add deploy key*.

---

## 5. Configure Nginx Reverse Proxy with WebSockets

Create a new Nginx configuration block:
```bash
sudo nano /etc/nginx/sites-available/matchbuddy
```

Paste the configuration below, replacing `api.matchbuddy.shop` with your domain or VPS IP:
```nginx
server {
    listen 80;
    server_name api.matchbuddy.shop;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Dedicated block for WebSocket connections
    location /ws {
        proxy_pass http://127.0.0.1:4000/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400; # Keep socket alive
        proxy_send_timeout 86400;
    }
}
```

Enable the configuration and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/matchbuddy /etc/nginx/sites-enabled/
# Test config syntax
sudo nginx -t
sudo systemctl restart nginx
```

---

## 6. Secure Nginx with SSL (Let's Encrypt HTTPS)

Secure the endpoint by obtaining a free SSL certificate from Let's Encrypt:
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.matchbuddy.shop
```
Certbot will verify your domain, issue the certificate, and automatically modify your Nginx file to enforce SSL/HTTPS redirect.

---

## 7. How to run local scripts

Once the VPS server is prepared and `.env.deploy` is configured in your project root:

1. **Deploy all code, install packages, and restart PM2**:
   ```bash
   npm run deploy
   ```
2. **Transfer local database data to remote**:
   ```bash
   npm run db:sync
   ```
