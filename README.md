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

### Public hosting on Render

1. Create a Render **Web Service** from the `main` branch of this repository. Use `npm ci` as the build command and `npm start` as the start command. Render provides HTTPS for the public site.
2. Attach a persistent disk of at least 1 GB mounted at `/var/data`.
3. Set `STORAGE_DIR` to `/var/data` and `MAX_STORAGE_BYTES` to `838860800` (800 MiB).
4. Keep the service to one instance: pairing codes and active transfers are held in server memory.
5. Use the public `onrender.com` URL on both devices. They can now be on different networks.

Render persistent disks require a paid web service. Check the current plan and disk price in Render before creating it. A free service has ephemeral storage and is not suitable for keeping uploaded files. No hosting service is created automatically by this repository.

Files are stored temporarily on the host and are not end-to-end encrypted. Anyone with the six-digit code can join that drop, so only share it with the intended receiver.

## Included

- Temporary six-digit pairing codes, valid for one hour.
- Two connected devices can send and download files, photos, videos, and text notes.
- Clear an individual transfer or clear all transfers immediately; clearing deletes the stored files for everyone in that drop.
- Transfers not cleared manually are automatically deleted after 24 hours.
- Recent files appear beside the connection panel so users can quickly see new drops.
- Drag-and-drop, multi-file selection, copy-code button, transfer activity, and a responsive animated interface.
- Per-item size limit of 250 MB, a 100-item limit per drop, total storage limit of 800 MB (configurable with `MAX_STORAGE_BYTES`), and a limit on repeated incorrect pairing attempts.

The server must remain online while transferring. Pairing information is kept in memory and is cleared when the app restarts.
