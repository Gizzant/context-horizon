#!/usr/bin/env node
/**
 * @file scripts/generate_pro_license.mjs
 * Offline Ed25519 keygen & license signer for Highbeam Pro (`@ctxtop/pro` / Polar.sh).
 *
 * Usage:
 *   node scripts/generate_pro_license.mjs --email dev@example.com --tier pro --days 365
 */

import { generateProKeyPair, signProLicensePayload, verifyProLicenseKey } from '../src/core/pro_license.mjs';

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const email = getArg('--email', 'founder@ctxtop.dev');
const tier = getArg('--tier', 'pro');
const days = Number(getArg('--days', '365'));
const seats = Number(getArg('--seats', '1'));

const { publicKeyPem, privateKeyPem } = generateProKeyPair();
const expiresAt = days > 0 ? new Date(Date.now() + days * 86400 * 1000).toISOString() : null;

const licenseKey = signProLicensePayload(
  {
    tier,
    email,
    seats,
    expiresAt,
    source: 'polar.sh'
  },
  privateKeyPem
);

const check = verifyProLicenseKey(licenseKey, { publicKeyPem });

if (args.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        ok: check.valid,
        licenseKey,
        payload: check.payload,
        publicKeyPem
      },
      null,
      2
    )
  );
} else {
  console.log(`✓ Generated & verified offline Ed25519 Pro license key (${tier}, ${days}d):`);
  console.log(`  Key   : ${licenseKey}`);
  console.log(`  Valid : ${check.valid}`);
}
