# Couch Riot

Party games for one big screen and everyone's phones. Open the page on the projector, players scan the QR code, and the host picks a game from the menu.

**Playable now:** Superlatives Tournament, Hot Takes Draft, Group Chat Simulator, Unpopular Opinions Bingo.
**Coming soon:** Crowd Pilot, Hot Potato Phone, Red Light Green Light, Stock the Fridge, Fake Wikipedia, Who Wrote This?, Herd Mentality but Meaner, One of Us Isn't Briefed.

## How it fits together

- `index.html`: the whole game, served by GitHub Pages. The projector runs all the game logic; phones are just controllers.
- `server/`: a tiny Cloudflare Worker that relays messages between the projector and phones over WebSockets, with one Durable Object per room code.

If `RELAY_URL` in `index.html` is empty, the page falls back to PeerJS, which connects phones peer-to-peer through a free public server. The relay is more reliable on school, office, and hotel Wi-Fi.

## Setup

### 1. Game page (GitHub Pages)

Go to **Settings → Pages**, set Source to "Deploy from a branch," pick `main` and `/ (root)`, and save. The site appears at `https://duckunicorn.github.io/couch-riot/`.

### 2. Relay (Cloudflare Workers, free plan)

1. In the Cloudflare dashboard, go to **Workers & Pages → Create**, choose the Workers option, click **Continue with GitHub**, and pick this repo.
2. Keep the Worker name `couch-riot` (it must match `name` in `wrangler.toml`) and the deploy command `npx wrangler deploy`. No root directory setting is needed; `wrangler.toml` sits at the repo root.
3. Deploy, then copy the Worker URL (e.g. `https://couch-riot.<you>.workers.dev`).
4. Paste that URL into `RELAY_URL` near the top of the script in `index.html` and push.

Cloudflare redeploys the relay on every push. To lock the relay to your site, set `ALLOWED_ORIGINS = "https://duckunicorn.github.io"` in `wrangler.toml`.

### 3. Shared song library (optional, Workers KV)

Songs added in Dance Riot are always saved on the hosting computer. To share them with every computer you host from:

1. In the Cloudflare dashboard, go to **Storage & Databases → Workers KV → Create**, name it `couch-riot-songs`, and copy its ID.
2. In `wrangler.toml`, uncomment the `[[kv_namespaces]]` block and paste the ID.
3. On the `couch-riot` Worker, go to **Settings → Variables and Secrets → Add**, choose type **Secret**, name it `LIBRARY_KEY`, and enter a password.
4. Push. Then open **Songs** in the lobby and enter that password once on each hosting computer.

Free plan limits: 1 GB of songs (about 200) and 1,000 uploads per day. Keep the password private: anyone with it can download or delete songs.

## Testing

- **One computer, no network:** open `index.html?host&local`, then use "Open a test phone tab."
- **Relay on your machine:** run `cd server && npm install && npx wrangler dev`, then open `index.html?host&relay=http://localhost:8787`.
- **Any relay without editing the file:** add `&relay=https://...` to the host URL. Phones inherit it through the QR code.
