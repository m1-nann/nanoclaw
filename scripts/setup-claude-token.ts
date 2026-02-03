/**
 * Setup Claude Code long-lived token for NanoClaw container
 * Run: bun scripts/setup-claude-token.ts
 * Or:  bun scripts/setup-claude-token.ts <token>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

const PROJECT_ROOT = join(import.meta.dir, '..');
const ENV_FILE = join(PROJECT_ROOT, '.env');

function saveToken(token: string) {
  let envContent = '';
  if (existsSync(ENV_FILE)) {
    envContent = readFileSync(ENV_FILE, 'utf-8');
    envContent = envContent
      .split('\n')
      .filter(line => !line.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))
      .join('\n');
    if (envContent && !envContent.endsWith('\n')) {
      envContent += '\n';
    }
  }

  envContent += `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
  writeFileSync(ENV_FILE, envContent);

  console.log('Token saved to .env');
  console.log('Restart NanoClaw to use the new token.');
}

async function promptForToken(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Paste your OAuth token: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  // Check if token passed as argument
  const argToken = process.argv[2];

  if (argToken) {
    saveToken(argToken);
    return;
  }

  console.log('NanoClaw Claude Token Setup');
  console.log('');
  console.log('Run this first to get your token:');
  console.log('  claude setup-token');
  console.log('');
  console.log('Then paste the token below, or run:');
  console.log('  bun run setup-token <token>');
  console.log('');

  const token = await promptForToken();

  if (!token) {
    console.error('No token provided');
    process.exit(1);
  }

  if (!token.startsWith('sk-ant-')) {
    console.error('Invalid token format (should start with sk-ant-)');
    process.exit(1);
  }

  saveToken(token);
}

main();
