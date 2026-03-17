# Tracker deployment on Ubuntu (DigitalOcean droplet)

Use this guide after you can SSH into your droplet. Replace `YOUR_DROPLET_IP` and `your-domain.com` with your values.

---

## 1. Update system and basics

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential
```

---

## 2. Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should show v20.x
npm -v
```

---

## 3. (Optional) Firewall

```bash
sudo ufw allow 22        # SSH
sudo ufw allow 80        # HTTP (for Nginx / Let's Encrypt)
sudo ufw allow 443       # HTTPS
sudo ufw enable
sudo ufw status
```

---

## 4. Clone your repo and install tracker

```bash
cd ~
# If you use GitHub (replace with your repo URL):
git clone https://github.com/Cosmo-US-LLC/predict-markets-white-website.git predictapp
cd predictapp/bfx-dashboard/tracker
npm install
```

If the tracker lives in a different repo or path, clone that and run `npm install` in the tracker folder.

---

## 5. Environment variables

Create production `.env` on the server (do not commit real secrets to git):

```bash
nano .env
```

Set at least (adjust values for production):

```env
PORT=1337
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
PARSE_APP_ID=myAppId
PARSE_MASTER_KEY=your-secure-master-key
# Use your droplet public URL (HTTPS once Nginx is set up):
PARSE_SERVER_URL=https://your-domain.com/parse
# Or for testing with IP only (HTTP):
# PARSE_SERVER_URL=http://YOUR_DROPLET_IP:1337/parse
ALCHEMY_API_KEY=your-alchemy-api-key
WALLET_TO_MONITOR=0xefe9895559f7b01384a1aaF58164B8bd7636d8FD
DASHBOARD_USER=admin
DASHBOARD_PASS=your-secure-dashboard-password
# Optional: custom BSC RPC if you have one
# BSC_RPC_URL=https://bsc-dataseed1.binance.org/
# BSC_POLL_INTERVAL_MS=15000
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

Important: `PARSE_SERVER_URL` must match the URL the outside world uses to reach your tracker (e.g. `https://your-domain.com/parse`). The tracker reads `PARSE_SERVER_URL` and `PARSE_MASTER_KEY` from `.env` for the Parse server config.

---

## 6. Run with PM2 (keeps tracker running)

```bash
sudo npm install -g pm2
pm2 start trackerserver.js --name tracker
pm2 save
pm2 startup
# Follow the command it prints to enable startup on boot
```

Useful commands:

- `pm2 status`
- `pm2 logs tracker`
- `pm2 restart tracker`

---

## 7. (Recommended) Nginx + HTTPS with Let's Encrypt

Only needed if you want a domain and HTTPS (e.g. so Netlify predict app can call `https://api.yourdomain.com/parse`).

### 7a. Point DNS to droplet

In your domain DNS, add an A record:

- Host: `@` or `api` (e.g. `api.yourdomain.com`)
- Value: your droplet IP

### 7b. Install Nginx and Certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 7c. Nginx config for the tracker

Create a vhost (replace `your-domain.com` with your real domain):

```bash
sudo nano /etc/nginx/sites-available/tracker
```

Paste (replace `your-domain.com` and `1337` if you use another port):

```nginx
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:1337;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/tracker /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 7d. Get SSL certificate

```bash
sudo certbot --nginx -d your-domain.com
```

Follow prompts. Certbot will adjust Nginx for HTTPS.

### 7e. Update tracker URL

In tracker `.env` set:

```env
PARSE_SERVER_URL=https://your-domain.com/parse
```

Then in `trackerserver.js` the Parse server config uses `process.env.PORT` and the app listens on 1337; Nginx proxies to it. If you need the Parse dashboard to show the correct URL, ensure `publicServerURL` in code or config matches `https://your-domain.com/parse`. Then restart:

```bash
pm2 restart tracker
```

---

## 8. Point Predict (Netlify) to this tracker

In your Netlify deploy (or build env), set:

- `VITE_PARSE_SERVER_URL=https://your-domain.com/parse`

So the predict app talks to your droplet’s Parse API over HTTPS.

---

## 9. Checklist

- [ ] Node 20 installed
- [ ] Repo cloned, `npm install` in tracker folder
- [ ] `.env` created with production values (MONGODB_URI, PARSE_SERVER_URL, ALCHEMY_API_KEY, WALLET_TO_MONITOR, etc.)
- [ ] PM2 running and saved (`pm2 status`, `pm2 save`, `pm2 startup`)
- [ ] (Optional) Nginx + Certbot for HTTPS
- [ ] DNS A record pointing to droplet
- [ ] Predict app env: `VITE_PARSE_SERVER_URL=https://your-domain.com/parse`

---

## Quick test without domain (HTTP only)

If you only have the droplet IP for now:

1. Set in `.env`: `PARSE_SERVER_URL=http://YOUR_DROPLET_IP:1337/parse`
2. Start with PM2.
3. Open `http://YOUR_DROPLET_IP:1337` in a browser; you should see "Server is running".
4. For production and CORS/HTTPS, use a domain and Nginx + SSL as in step 7.
