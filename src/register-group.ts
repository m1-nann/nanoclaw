/**
 * Register Main Group Script
 *
 * Registers the main WhatsApp group for NanoClaw.
 * Run after authenticating with WhatsApp.
 *
 * Usage: bun src/register-group.ts
 *
 * The script will:
 * 1. Connect to WhatsApp
 * 2. Fetch all groups you're a member of
 * 3. Let you pick which one to use as the main group
 */

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const AUTH_DIR = './store/auth';
const DATA_DIR = './data';
const GROUPS_DIR = './groups';

const logger = pino({ level: 'warn' });

interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  type: 'system' | 'chat';
  added_at: string;
}

function loadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return defaultValue;
}

function saveJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  // Check if already authenticated
  if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    console.log('Not authenticated. Run `bun run auth` first.');
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  console.log('Connecting to WhatsApp...\n');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log('Logged out. Run `bun run auth` to re-authenticate.');
      } else {
        console.log('Connection closed unexpectedly.');
      }
      process.exit(1);
    }

    if (connection === 'open') {
      console.log('Connected!\n');

      try {
        // Fetch all groups
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.entries(groups)
          .filter(([jid]) => jid.endsWith('@g.us'))
          .map(([jid, meta]) => ({ jid, name: meta.subject || 'Unknown' }))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (groupList.length === 0) {
          console.log('No groups found. Join a WhatsApp group first.');
          process.exit(1);
        }

        console.log('Available groups:\n');
        groupList.forEach((g, i) => {
          console.log(`  ${i + 1}. ${g.name}`);
        });
        console.log();

        const choice = await prompt('Enter group number for MAIN group: ');
        const index = parseInt(choice, 10) - 1;

        if (isNaN(index) || index < 0 || index >= groupList.length) {
          console.log('Invalid choice.');
          process.exit(1);
        }

        const selected = groupList[index];

        // Register the group
        const registeredGroups = loadJson<Record<string, RegisteredGroup>>(
          path.join(DATA_DIR, 'registered_groups.json'),
          {}
        );

        registeredGroups[selected.jid] = {
          name: selected.name,
          folder: 'main',
          trigger: 'EI',
          type: 'system',
          added_at: new Date().toISOString(),
        };

        saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

        // Create group folder
        fs.mkdirSync(path.join(GROUPS_DIR, 'main', 'logs'), { recursive: true });

        console.log(`\n✓ Registered "${selected.name}" as main group`);
        console.log('  You can now start NanoClaw with: bun run dev\n');

        process.exit(0);
      } catch (err) {
        console.error('Error fetching groups:', err);
        process.exit(1);
      }
    }
  });
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
