#!/usr/bin/env node
/**
 * @file scripts/generate_pro_license.mjs
 * Persistent Ed25519 keygen & license signer for Highbeam Pro (`@ctxtop/pro` / Polar.sh).
 *
 * Usage:
 *   node scripts/generate_pro_license.mjs --keygen --out-private ~/.ctxtop/keys/highbeam_pro_ed25519.pem --json
 *   node scripts/generate_pro_license.mjs --private-key-file ~/.ctxtop/keys/highbeam_pro_ed25519.pem --email dev@example.com --tier pro --days 365
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateProKeyPair, signProLicensePayload, verifyProLicenseKey } from '../src/core/pro_license.mjs';

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

if (args.includes('--keygen')) {
  const outPrivate = getArg('--out-private', '');
  const { publicKeyPem, privateKeyPem } = generateProKeyPair();
  let resolvedOut = null;
  if (outPrivate) {
    resolvedOut = path.resolve(outPrivate);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, `${privateKeyPem.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(resolvedOut, 0o600);
    } catch {
      // Windows ACL fallback handled cleanly
    }
  }
  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          privateKeyPath: resolvedOut,
          publicKeyPem
        },
        null,
        2
      )
    );
  } else {
    console.log('✓ Generated fresh production Ed25519 keypair:');
    if (resolvedOut) console.log(`  Private key saved (0600): ${resolvedOut}`);
    console.log('  Wire this SPKI public key into DEFAULT_PRO_PUBLIC_KEY_PEM (src/core/pro_license.mjs):');
    console.log(publicKeyPem);
  }
  process.exit(0);
}

const email = getArg('--email', 'founder@ctxtop.dev');
const tier = getArg('--tier', 'pro');
const days = Number(getArg('--days', '365'));
const seats = Number(getArg('--seats', '1'));
const privateKeyFile = getArg('--private-key-file', '');

let privateKeyPem = '';
let publicKeyPem = '';
let keySource = 'ephemeral';

if (privateKeyFile) {
  privateKeyPem = fs.readFileSync(path.resolve(privateKeyFile), 'utf8').trim();
  publicKeyPem = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).trim();
  keySource = 'file';
} else if (process.env.CTXTOP_ED25519_PRIVATE_KEY_PEM) {
  privateKeyPem = String(process.env.CTXTOP_ED25519_PRIVATE_KEY_PEM).replace(/\\n/g, '\n').trim();
  publicKeyPem = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).trim();
  keySource = 'env';
} else {
  const generated = generateProKeyPair();
  privateKeyPem = generated.privateKeyPem;
  publicKeyPem = generated.publicKeyPem;
}

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
        keySource,
        licenseKey,
        payload: check.payload,
        publicKeyPem
      },
      null,
      2
    )
  );
} else {
  console.log(`✓ Generated & verified Ed25519 Pro license key (${tier}, ${days}d, source=${keySource}):`);
  console.log(`  Key   : ${licenseKey}`);
  console.log(`  Valid : ${check.valid}`);
}
