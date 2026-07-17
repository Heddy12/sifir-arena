# ASMD Times Table Hero Arena - Multiplayer Edition

Real-time multiplayer math battle game for 2 players on separate devices.

## Files

| File | Description |
|------|-------------|
| `server.js` | WebSocket server (Node.js) — room management, game logic, state sync |
| `client.html` | Game client (self-contained) — connect screen, Solo Quest, Sprint & multiplayer battle arena, real-time sync |
| `leaderboard-store.js` | PostgreSQL account, session and persistent leaderboard storage |
| `game-master.html` | Secured Game Master dashboard for player management and live monitoring |
| `server-auth.test.js` | Authentication, WebSocket access and Create Room regression tests |
| `client-audio.test.js` | Chiptune scheduler, Music/SFX controls and persistence tests |
| `package.json` | Node.js dependencies and scripts |

## Quick Start (Local Testing)

### Prerequisites
- Node.js 18+ installed

### Run Locally
```bash
# 1. Install dependencies
npm install

# 2. Required: enable player accounts and the global leaderboard
# PowerShell: $env:DATABASE_URL='postgresql://...'
# macOS/Linux: export DATABASE_URL='postgresql://...'

# 3. Start server
npm start

# 4. Open in browser
# Laptop 1: http://localhost:3000
# Laptop 2: http://<LAPTOP1_IP>:3000 (same WiFi network)
```

## Deploy to Render.com (Free)

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "ASMD Times Table Hero Arena Multiplayer"
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
6. Add a secret environment variable named `DATABASE_URL` using the connection string from your hosted PostgreSQL provider (Supabase, Neon, or another provider)
7. Add `GAME_MASTER_EMAIL` with the exact email address of the one authorized Game Master account
8. Wait for deployment to finish (2-3 minutes)
9. You'll get a URL like: `https://sifir-arena.onrender.com`

### Step 3: Play!
1. Both players register with an email/password and choose a unique Player ID
2. Laptop 1: Login → **Multiplayer** → **Create Room** → share room code
3. Laptop 2: Login → **Multiplayer** → type room code → **Join Room**
4. Battle starts automatically!

## How to Play

### Create Room
1. Register or login; your unique Player ID becomes your in-game name
2. Select timer (4s/6s/8s/10s), sifir (1-12 or All), difficulty
3. Click **Create Room**
4. Share the 6-character room code with opponent

### Join Room
1. Register or login; your Player ID is loaded automatically
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
- Use the music-note button to toggle chiptune music and the SFX button to control effects independently

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
- **Account required:** Gameplay WebSockets only accept authenticated sessions
- **Secure passwords:** Passwords are stored as salted scrypt hashes, never as plain text
- **Secure sessions:** Random server-side sessions use `HttpOnly`, `SameSite=Strict` cookies (`Secure` on HTTPS)
- **Room-based:** 6-char room code, max 2 players per room
- **WebSocket:** Real-time bidirectional communication
- **Auto-cleanup:** Rooms deleted after disconnect + 5s delay
- **Global leaderboard:** Top 10 records are stored in PostgreSQL when `DATABASE_URL` is configured

## Game Master Dashboard

- Log in to the arena using the account whose email exactly matches `GAME_MASTER_EMAIL`
- Open **Game Master** on the home screen or visit `/game-master`
- Monitor live battles and Quick Match activity without exposing questions or answers
- Search player accounts, send password reset emails, rename offline players, suspend access, and archive or restore records
- Sensitive actions are confirmed and written to the Game Master audit log
- Player passwords, password hashes, reset codes, session tokens, and private profile-edit controls are never exposed

## Ranked Leaderboard

- Open the trophy button on the landing page or result screen
- Separate rankings are available for Single Player, Multiplayer, and Sprint
- Ranked preset: All Tables and Random difficulty, with a 20s timer for Single Player/Multiplayer and one unified 60s timer for Sprint
- Custom settings remain playable but are marked **Unranked**
- Single Player stores the best winning score, Sprint stores the best individual result, and Multiplayer counts wins and games played
- PostgreSQL is required for account login and gameplay; a temporary database outage blocks new game sessions safely

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
- **Audio:** Original menu and battle chiptunes plus sound effects generated with Web Audio API (no external files)
- **Storage:** PostgreSQL for accounts, sessions and leaderboard data; active rooms remain server-authoritative in memory

## License
MIT
