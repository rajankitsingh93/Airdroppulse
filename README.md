# Airdroppulse

Airdroppulse is a no-sign-in way to send files and text between devices. The sender uploads a file to the Airdroppulse server; the paired receiver downloads it from the Activity list.

## Run it

1. Install [Node.js](https://nodejs.org/) if it is not already installed.
2. Open a terminal in this folder and run `npm install`.
3. Run `npm start`.
4. On this computer, open `http://localhost:3000`.
5. To connect a phone on your local network, open `http://<computer-local-IP>:3000` on the phone, where `<computer-local-IP>` is this computer's address shown by `ipconfig`.
6. On the sending device, select **Generate 6-digit code**. On the receiving device, open the same website and enter that code.

For internet access from anywhere, deploy the app behind HTTPS with a persistent storage volume and set `STORAGE_DIR` to that volume's mount path. Keep the volume private; the app controls access to downloads using the active pairing code. Do not expose the server over plain HTTP on the public internet.

### Cloudflare Workers deployment

The Cloudflare Worker serves the static site and runs the WebSocket/API backend. The backend uses a SQLite-backed Durable Object for pairing, temporary file storage, and 24-hour cleanup. A static-asset-only deployment does not support transfers.

For Git-based automatic deployments, connect this repository's `main` branch to a Cloudflare Worker build and use:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: the repository root

The `wrangler.jsonc` configuration creates the Durable Object binding and its initial migration. For a local deployment, install dependencies, run `npx wrangler login`, then run `npm run deploy:cloudflare`. Keep the Worker on a plan that supports Durable Objects and check Cloudflare's current limits and pricing.

Use the Worker's `workers.dev` HTTPS URL on both devices. Each file can be up to 50 MB; total stored data is limited to 800 MiB and files expire after 24 hours.

The Node.js server can still be run locally with `npm start`; it is not the backend for a static Cloudflare deployment.

### Google Search Console and indexing

After the public HTTPS site is live, add its exact URL as a URL-prefix property in [Google Search Console](https://search.google.com/search-console). For HTML-tag verification, follow Google's [site ownership verification steps](https://support.google.com/webmasters/answer/9008080). The verification meta tag is included directly in `index.html`; after changing it, redeploy the Worker and click **Verify**. The app serves `/robots.txt` and `/sitemap.xml` on the public origin; submit that sitemap in Search Console. Verification and indexing do not guarantee search ranking or a top result.

Files are stored temporarily on the host and are not end-to-end encrypted. Anyone with the six-digit code can join that drop, so only share it with the intended receiver.

## Included

- Temporary six-digit pairing codes, valid for one hour.
- Two connected devices can send and download files, photos, videos, and text notes.
- Clear an individual transfer or clear all transfers immediately; clearing deletes the stored files for everyone in that drop.
- Transfers not cleared manually are automatically deleted after 24 hours.
- Recent files appear beside the connection panel so users can quickly see new drops.
- Drag-and-drop, multi-file selection, copy-code button, transfer activity, and a responsive animated interface.
- Per-item size limit of 50 MB on Cloudflare Workers (250 MB on the Node.js server), a 100-item limit per drop, an 800 MiB Cloudflare storage limit, and a limit on repeated incorrect pairing attempts.

The Cloudflare Worker and its Durable Object must remain available while transferring. On the local Node.js server, pairing information is kept in memory and is cleared when the server restarts.
