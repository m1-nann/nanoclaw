/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';

const AUTH_DIR = './store/auth';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const logger = pino({
  level: 'warn', // Quiet logging - only show errors
});

async function authenticate(attempt = 1): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log('  To re-authenticate, delete the store/auth folder and run again.');
    process.exit(0);
  }

  if (attempt === 1) {
    console.log('Starting WhatsApp authentication...\n');
  } else {
    console.log(`\nRetrying connection (attempt ${attempt}/${MAX_RETRIES})...\n`);
  }

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const errorCode = (lastDisconnect?.error as any)?.output?.payload?.code;

      if (reason === DisconnectReason.loggedOut) {
        console.log('\n✗ Logged out. Delete store/auth and try again.');
        process.exit(1);
      }

      // Retry on transient errors (like stream error 515)
      if (attempt < MAX_RETRIES) {
        console.log(`\n⚠ Connection interrupted (code: ${errorCode || reason || 'unknown'})`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        authenticate(attempt + 1);
      } else {
        console.log('\n✗ Connection failed after multiple attempts.');
        console.log('  This may be a temporary WhatsApp server issue.');
        console.log('  Please wait a few minutes and try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log('  Credentials saved to store/auth/');
      console.log('  You can now start the NanoClaw service.\n');

      // Give it a moment to save credentials, then exit
      setTimeout(() => process.exit(0), 1000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
