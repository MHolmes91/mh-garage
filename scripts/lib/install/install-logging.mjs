import readline from 'node:readline/promises';

export class GracefulExit extends Error {
  constructor() {
    super('Installer exited at a manual checkpoint.');
  }
}

export function log(stdout, message) {
  stdout.write(`\n==> ${message}\n`);
}

export function note(stdout, message) {
  stdout.write(` -> ${message}\n`);
}

export async function promptForValueInteractive({ prompt, defaultValue = '', secret = false, stdin = process.stdin, stdout = process.stdout }) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await rl.question(`${prompt}${suffix}: `, { hideEchoBack: secret });
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

export async function pauseOrExitAtCheckpoint({ message, mode, stdin = process.stdin, stdout = process.stdout }) {
  stdout.write(`\n${message}\n`);
  if (mode === 'pause') {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    try {
      await rl.question('Press Enter once this is done to continue. ');
      return;
    } finally {
      rl.close();
    }
  }

  stdout.write('Exiting now. Rerun the script after finishing that step.\n');
  throw new GracefulExit();
}

export function writeInstallSummary(stdout, env, tokenFile) {
  log(stdout, 'Done');
  note(stdout, 'Dokploy panel bootstrap URL: http://127.0.0.1:3000');
  note(stdout, `Dokploy URL: ${env.DOKPLOY_URL}`);
  note(stdout, `zrok controller URL: https://${env.ZROK_DOMAIN}`);
  note(stdout, `Example share URL pattern: https://<share>.${env.ZROK_DOMAIN}`);
  if (env.ZROK_ACCOUNT_TOKEN) {
    note(stdout, `zrok account token file: ${tokenFile}`);
  }
  stdout.write('\nNext client-side commands:\n');
  stdout.write(`  zrok config set apiEndpoint https://${env.ZROK_DOMAIN}\n`);
  stdout.write('  zrok enable <ACCOUNT_TOKEN>\n');
}
