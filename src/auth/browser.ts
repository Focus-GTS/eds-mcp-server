/**
 * Cross-platform system-browser launcher.
 *
 * Opens a URL in the user's default browser using the platform's native
 * opener command. Deliberately never throws: if the opener fails (headless
 * environment, sandbox, missing command), it prints the URL so the user can
 * open it manually.
 *
 * Uses only `node:child_process` and `node:process` — no dependencies.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * Attempt to open `url` in the default system browser.
 *
 * @param url - The URL to open.
 * @returns `true` if the opener process was spawned, `false` otherwise. The
 *          URL is always printed to stderr so it can be opened manually.
 */
export function openBrowser(url: string): boolean {
  const { command, args } = resolveOpener(url);

  // Always show the URL so a headless / sandboxed user can open it by hand.
  process.stderr.write(`\nOpening browser to:\n  ${url}\n`);

  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      // `start` on Windows is a shell builtin, so it needs a shell.
      shell: process.platform === 'win32',
    });

    // Don't keep the event loop alive waiting on the browser process.
    child.on('error', () => {
      process.stderr.write(
        'Could not launch a browser automatically — please open the URL above manually.\n',
      );
    });
    child.unref();
    return true;
  } catch {
    process.stderr.write(
      'Could not launch a browser automatically — please open the URL above manually.\n',
    );
    return false;
  }
}

/** Resolve the platform-specific opener command and arguments. */
function resolveOpener(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // The empty "" is the window title argument required by `start`.
      return { command: 'start', args: ['""', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}
