# `@ctxtop/pro` Production Ed25519 Key Rotation & Polar.sh Signing Runbook

## 1. Zero-Network Offline Architecture
`@ctxtop/pro` licenses use offline `CTXP1.<payloadB64Url>.<sigB64Url>` Ed25519 tokens verified locally via Node's built-in `node:crypto` module (`verifyProLicenseKey()` in `src/core/pro_license.mjs`). The client IDE/CLI makes **zero** outbound network calls.

## 2. Generate Production Keypair
Run an offline one-liner using `generateProKeyPair()` on a secure local workstation:
```bash
node -e "import('./src/core/pro_license.mjs').then(m => { const kp = m.generateProKeyPair(); console.log(kp.publicKeyPem); console.log(kp.privateKeyPem); })"
```

## 3. Bind Cloudflare Worker Secrets (Polar.sh Webhook)
Store the PKCS#8 private key and Polar.sh webhook HMAC secret in Cloudflare Worker encrypted secrets:
```bash
wrangler secret put CTXTOP_ED25519_PRIVATE_KEY_PEM
wrangler secret put CTXTOP_POLAR_WEBHOOK_SECRET
```
Never commit `CTXTOP_ED25519_PRIVATE_KEY_PEM` to Git or npm tarballs.

## 4. Embed the SPKI Public Key
1. Update `DEFAULT_PRO_PUBLIC_KEY_PEM` in `src/core/pro_license.mjs` with the corresponding SPKI PEM public key before tagging a release.
2. There is intentionally no environment-variable override (such as `CTXTOP_ED25519_PUBLIC_KEY_PEM`): replacing the trust root from the shell would let anyone sign their own Pro license. Staged key-rotation tests pass `{ publicKeyPem }` to `verifyProLicenseKey()` directly.

## 5. Key Rotation Checklist
1. Generate a new keypair and deploy `CTXTOP_ED25519_PRIVATE_KEY_PEM` to the signing worker only after shipping the matching `DEFAULT_PRO_PUBLIC_KEY_PEM` in `ctxtop`.
2. Verify signature round-trip locally using `signProLicensePayload()` -> `verifyProLicenseKey()`.
3. Confirm tampered and expired payloads return `INVALID_SIGNATURE` and `LICENSE_EXPIRED`.

## 6. Deploy Polar.sh Webhook Worker to Cloudflare Workers
The worker verifies the Polar webhook, signs the key, and **emails it to the buyer** (the key is never returned in the HTTP response). It needs a KV namespace for retry de-duplication and the real LTD sold counter, plus an email sender (Resend by default):
```bash
cd packages/pro
npx wrangler kv namespace create LICENSE_KV      # paste the id into wrangler.toml
npx wrangler secret put CTXTOP_ED25519_PRIVATE_KEY_PEM < "$HOME/.ctxtop/keys/highbeam_pro_ed25519.pem"
npx wrangler secret put CTXTOP_POLAR_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put CTXTOP_EMAIL_FROM        # e.g. Highbeam <licenses@your-verified-domain>
npx wrangler deploy
```
Behavior: a replayed/retried order id returns `{duplicate:true}` and sends nothing; if the email fails the worker returns `500` and records nothing, so Polar's retry delivers the key; LTD sales increment `ltd:sold_count` in KV and the 201st sale returns `409 LTD_CAP_200_EXCEEDED`. Before launch, do one real test purchase end to end and confirm the email arrives.

### Live Polar.sh SKU Mapping (`POLAR_LIVE_SKU_CATALOG`)
| SKU | Price | Billing Interval | Tier & Seats | Expiry / Cap |
| :--- | :--- | :--- | :--- | :--- |
| `pro_monthly` | `$15/mo` | Monthly | `pro`, `1` seat | `32` days |
| `pro_annual` | `$149/yr` | Annual | `pro`, `1` seat | `366` days |
| `pro_ltd` | `$199` | One-time | `ltd`, `1` seat | Lifetime (`null`), `200` cap (`409 LTD_CAP_200_EXCEEDED` above cap) |
| `team_starter` | `$299/yr` | Annual | `team`, `5` seats | `366` days |
| `team_seat_monthly` | `$39/seat/mo` | Monthly (`3900` cents/seat) | `team`, `quantity` seats | `32` days (`366` days if annual) |
