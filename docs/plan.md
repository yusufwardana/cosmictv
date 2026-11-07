# COSMIC TV implementation plan

**Goal:** Serve an automatically refreshed M3U and JSON API from a standalone local web application.
**Spec:** D:/Tools/DopamineTV/web/docs/design.md
**Stack:** Node.js 22+, built-in HTTP/fetch/crypto/fs, HTML/CSS/JavaScript.

- [x] Write D:/Tools/DopamineTV/web/test/service.test.mjs; run npm test and confirm missing service failure.
- [x] Implement src/playlist.mjs (validation/conversion), src/service.mjs (sign/fetch/cache), src/http.mjs (routes), server.mjs (configuration/startup/scheduler).
- [x] Run focused tests; fix failures and review error/cache/auth boundaries.
- [x] Implement public/index.html, public/style.css and public/app.js with responsive dashboard, filters, endpoint controls, refresh state and errors.
- [x] Create package.json, .env.example, .gitignore, Dockerfile, .dockerignore, start.ps1 and README.md. Generate local .env from confirmed APK request configuration without printing credentials.
- [x] Run npm test and syntax checks. Start with start.ps1; verify live upstream 200, M3U entries, cached API, status and dashboard. Review all created files and record any deployment limitations.

## Verification — 2026-11-07, Asia/Jakarta

VERIFIED for local operation. `npm test`: 17 tests passed, 0 failed. `npm run check`: exit 0. Live refresh returned valid data: 196 channels, 281 sources and 281 M3U entries. GET dashboard, channels, playlist and status returned HTTP 200. Browser confirmed the dashboard, search, a mixed DRM filter and the LAN playlist URL. Cache reload after restarting the server was exercised. `.env` special-character parsing was corrected by quoting the secret. Explicit source `drmConfig: null` overrides the channel DRM default and has a regression test.

The user selected local/LAN hosting. Server binds 0.0.0.0:8787; primary LAN IPv4 is 10.10.12.50. Elevated firewall setup reports success for TCP 8787 / LocalSubnet; application works through its LAN IP on the host. No second physical device was available for testing. Automatic updates are scheduled every 900 seconds while the Node process runs. No public domain was deployed, no Windows boot task installed, and Docker deployment was documented but not run. Individual media playback was not tested.

All files reside under D:/Tools/DopamineTV/web; existing extracted artifacts in its parent remain available. Fixtures use artificial URLs and keys. No modifications or commits in the CosmicLink repository.
