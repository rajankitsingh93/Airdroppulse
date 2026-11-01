# Airdroppulse

Airdroppulse is a no-sign-in way to send files and text between devices on the same local network. The computer running the app receives and saves every item in `received`, organized by date.

## Run it

1. Install [Node.js](https://nodejs.org/) if it is not already installed.
2. Open a terminal in this folder and run `npm install`.
3. Run `npm start`.
4. On this computer, open `http://localhost:3000`.
5. To connect a phone, keep both devices on the same Wi-Fi. Find this computer's local IPv4 address with `ipconfig`, then open `http://<computer-local-IP>:3000` on the phone.
6. Create a drop on one device and enter the six-digit code on the other.

The app listens on the local network so your phone can reach it. If Windows Firewall prompts you, allow access on **Private networks only**. Do not expose this app or its port to the public internet. The pairing code is a temporary shared code, not an account or a CAPTCHA.

## Included

- Temporary six-digit pairing codes, valid for one hour.
- Two connected devices can send files, photos, videos, and text notes.
- Incoming items are saved to `received/YYYY-MM-DD/`.
- Drag-and-drop, multi-file selection, copy-code button, transfer activity, and a responsive animated interface.
- Per-item size limit of 250 MB and a limit on repeated incorrect pairing attempts.

The computer running the app must remain on while transferring. Pairing information is kept in memory and is cleared when the app stops.
