# Actors Prompter

Actors Prompter is a React + Vite application for organizing dialogue prompts, recording lines, importing scripts, and rehearsing with Reader and Myself recordings.

## Start local development

From the project directory, run:

```powershell
npm run dev
```

Vite listens on `0.0.0.0:5173`, keeps the port fixed, and prints the computer's LAN URL. On the iPhone, open the URL printed by Vite, in the form `http://<computer-LAN-IP>:5173/`. Keep the computer and phone on the same Wi-Fi network. The LAN IP can change; use the current one printed by Vite.

Plain HTTP is useful for checking page layout and touch interaction, but it is not a secure context on an iPhone. Microphone recording, iOS speech recognition, AudioWorklet-based Reader Pitch, and Kokoro TTS require a trusted HTTPS origin. The app now defers loading its AudioWorklet library until Reader Pitch actually needs it, so missing APIs no longer crash the app during startup.

## Optional HTTPS for iPhone testing

Use `mkcert` to make a locally trusted certificate for the computer's current Wi-Fi IP. On Windows, install mkcert using its [official installation instructions](https://github.com/FiloSottile/mkcert#installation), then run:

```powershell
mkcert -install
New-Item -ItemType Directory -Force .certs | Out-Null
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi' -ErrorAction Stop |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1 -ExpandProperty IPAddress)
mkcert -cert-file .certs/dev-cert.pem -key-file .certs/dev-key.pem $lanIp localhost 127.0.0.1 ::1
```

If the network adapter is not named `Wi-Fi`, check `ipconfig` and set `$lanIp` to the computer's Wi-Fi IPv4 address. Repeat certificate generation if that IP changes.

Install the mkcert root certificate on the iPhone:

1. Run `mkcert -CAROOT` on the computer and transfer only `rootCA.pem` to the phone (for example, by email or iCloud Drive). **Never transfer `rootCA-key.pem`.**
2. Open the certificate on the iPhone and install the downloaded profile from **Settings → Profile Downloaded**.
3. Enable trust at **Settings → General → About → Certificate Trust Settings → Enable Full Trust for Root Certificates**.

Then start Vite in the same PowerShell window:

```powershell
$env:ACTORS_PROMPTER_HTTPS = '1'
npm run dev
```

Open the HTTPS LAN URL printed by Vite, in the form `https://<computer-LAN-IP>:5173/`. The Vite config reads `.certs/dev-cert.pem` and `.certs/dev-key.pem` only when HTTPS is explicitly enabled. This local certificate setup does not change the production build or Cloudflare headers.

If port `5173` is already occupied, Vite exits with a port-in-use error rather than silently choosing a different port. Stop the other server and rerun `npm run dev`.

## Local-network troubleshooting

- Allow Node.js through Windows Defender Firewall on **Private networks** when prompted. If Vite starts but the phone cannot connect, check **Windows Defender Firewall → Allow an app through firewall** and allow Node.js on the private profile. Do not turn the firewall off.
- Disconnect a VPN temporarily if it routes local traffic away from Wi-Fi, or verify the address belongs to the Wi-Fi adapter and not the VPN adapter.
- Make sure both devices use the same Wi-Fi network. Guest Wi-Fi and some router settings enable client isolation, which blocks devices from reaching one another; use the main network or disable client isolation for that network.
- If the page opens over HTTP but microphone, speech recognition, TTS, or Reader Pitch reports a security-context requirement, use the trusted HTTPS steps above.

## Browser capabilities

The app records secure-context and audio API availability in `window.__promptBrowserCapabilities` and in the on-screen error diagnostics. Unsupported microphone, speech-recognition, or Reader Pitch features report a specific error when invoked rather than preventing the page from loading. Speech recognition support can still vary by iOS/Safari version and language.

## Checks

```powershell
npm test
npm run lint
npm run build
```
