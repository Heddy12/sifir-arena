# ASMD Sifir Hero Arena - Multiplayer Edition

Real-time multiplayer math battle game for 2 players on separate devices.

## Files

| File | Description |
|------|-------------|
| `server.js` | WebSocket server (Node.js) — room management, game logic, state sync |
| `client.html` | Multiplayer client — connect screen, battle arena, real-time sync |
| `package.json` | Node.js dependencies and scripts |
| `index.html` | Solo/Local version (not used by server) |

## Quick Start (Local Testing)

### Prerequisites
- Node.js 14+ installed

### Run Locally
```bash
# 1. Install dependencies
npm install

# 2. Start server
npm start

# 3. Open in browser
# Laptop 1: http://localhost:3000
# Laptop 2: http://<LAPTOP1_IP>:3000 (same WiFi network)
```

## Deploy to Render.com (Free)

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "ASMD Sifir Hero Arena Multiplayer"
git remote add origin https://github.com/YOUR_USERNAME/sifir-arena.git
git push -u origin main
```

### Step 2: Deploy on Render
1. Go to https://render.com and sign up / log in
2. Click **New +** → **Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Name:** `sifir-arena` (or any name)
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** `Free`
5. Click **Create Web Service**
6. Wait for deployment to finish (2-3 minutes)
7. You'll get a URL like: `https://sifir-arena.onrender.com`

### Step 3: Play!
1. Both laptops open the Render URL in browser
2. Laptop 1: Enter name → **Create Room** → share room code
3. Laptop 2: Enter name → type room code → **Join Room**
4. Battle starts automatically!

## How to Play

### Create Room
1. Enter your name
2. Select timer (4s/6s/8s/10s), sifir (1-12 or All), difficulty
3. Click **Create Room**
4. Share the 6-character room code with opponent

### Join Room
1. Enter your name
2. Type the room code
3. Click **Join Room**
4. Battle starts automatically when both players connected

### Gameplay
- Answer multiplication questions to attack opponent
- Correct answer = damage opponent
- Wrong answer = lose 5 HP
- Time out = lose 8 HP
- Each player gets 3 random Magic Cards before battle
- Click a card during your turn to activate it
- First to drop opponent HP to 0 wins!

## Magic Cards (10 Types)

| Card | Effect |
|------|--------|
| Double Strike | 2x damage on next correct answer |
| Shield | Block next incoming attack |
| Time Freeze | Stop timer for current question |
| Heal Potion | Restore +20 HP |
| Reveal Hint | Show if answer is even or odd |
| Skip Question | New question, no penalty |
| Steal HP | Steal 15 HP from opponent |
| Second Chance | No penalty on next wrong answer |
| Streak Boost | +3 streak instantly |
| Mirror Shield | Reflect damage to opponent (1 turn) |

## Server Architecture

- **Server-authoritative:** Server controls all game logic (questions, timer, damage, HP)
- **Room-based:** 6-char room code, max 2 players per room
- **WebSocket:** Real-time bidirectional communication
- **Auto-cleanup:** Rooms deleted after disconnect + 5s delay

## Troubleshooting

### Can't connect?
- Check if server is running (`npm start`)
- Check URL is correct
- Check firewall allows the port

### Opponent disconnected?
- Server detects disconnect and notifies the other player
- Click "Back to Menu" to return to connect screen

### Render free tier sleeps after 15 min inactivity
- First request after sleep takes ~30s to wake up
- Consider paid plan for always-on

## Tech Stack
- **Server:** Node.js + ws (WebSocket library)
- **Client:** Vanilla HTML/CSS/JS (no frameworks)
- **Audio:** Web Audio API (no external files)
- **Storage:** None (server-authoritative, state in memory)

## License
MIT
