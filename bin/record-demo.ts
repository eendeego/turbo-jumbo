/**
 * Records the product demo video, beat for beat per docs/demo-script.md
 * (which stays the source of truth for WHAT is shown — keep the two in
 * sync). Prints a per-beat timestamp table at the end for
 * docs/demo-script-timestamps.md, then the webm path; feed that to
 * bin/demo-postprod.sh to accelerate the waits and get a GitHub-ready mp4.
 *
 * Run against an isolated dev server — never a server someone is using —
 * started with the .envrc environment loaded so the hf CLI gets HF_TOKEN
 * and Xet acceleration, and with the dev-tools bubble hidden:
 *
 *   direnv exec . bash -c \
 *     'NEXT_DEV_INDICATORS=0 NEXT_DIST_DIR=.next-verify bunx next dev --port 3998'
 *   bun bin/record-demo.ts
 *
 * Pre-flight (per the demo script's ground rules) is automatic: routes are
 * warm-compiled, the remote peer must be reachable, leftovers of the demo
 * model from a botched take are deleted, and the mmproj file is removed so
 * beat 10's audit finds its Incomplete verdict. Everything the recording
 * mutates is undone on camera, except the mmproj repair — that's the point.
 */

export {}; // top-level await needs module scope

const BASE = process.env.DEMO_URL ?? 'http://localhost:3998';
const OUT_DIR = process.env.DEMO_OUT_DIR ?? 'demo-out';
const LONG = 8 * 60 * 1000; // transfers: generous, network/disk bound

// The models the storyline uses (docs/demo-script.md).
const DEMO_REPO = 'unsloth/gemma-3-270m-it-GGUF';
const DEMO_FILE = 'gemma-3-270m-it-UD-IQ2_M.gguf';
const DEMO_PATH = `${DEMO_REPO}/${DEMO_FILE}`;
const DEMO_ROW = 'gemma-3-270m'; // row text unique to the demo model
const EXPAND_MODEL = 'gemma-4-26B-A4B-it-GGUF'; // beat 3: multi-quant model
const AUDIT_MODEL = 'Qwen3.6-35B-A3B-MTP'; // beat 10: model missing its mmproj
const AUDIT_MMPROJ = `unsloth/Qwen3.6-35B-A3B-MTP-GGUF/mmproj-F16.gguf`;

// playwright-core straight from bun's cache — nothing is installed in this
// repo. chromium.launch() finds the matching cached browser build.
const PLAYWRIGHT_CORE =
  '/home/luisa/.bun/install/cache/playwright-core@1.61.1@@@1/index.mjs';
// @ts-expect-error playwright-core is not a dependency of this repo; it
// resolves only if installed elsewhere, with the bun cache as the fallback.
const {chromium} = await import('playwright-core').catch(
  () => import(PLAYWRIGHT_CORE),
);

// ————— Pre-flight —————

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res;
};
const del = (path: string, files: string[]) =>
  fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({files}),
  });

const up = await fetch(`${BASE}/`)
  .then((r) => r.ok)
  .catch(() => false);
if (!up) {
  console.error(`No server at ${BASE} — start the isolated instance first:
  direnv exec . bash -c 'NEXT_DEV_INDICATORS=0 NEXT_DIST_DIR=.next-verify bunx next dev --port 3998'`);
  process.exit(1);
}

const {peers} = (await (await api('/api/v1/peers')).json()) as {
  peers: Array<{name: string; isLocal: boolean}>;
};
const remotePeer = peers.find((p) => !p.isLocal);
const localPeer = peers.find((p) => p.isLocal);
if (!remotePeer || !localPeer)
  throw new Error('need a local and a remote peer');
const peerApi = (name: string, rest: string) =>
  `/api/v1/peers/${encodeURIComponent(name)}/${rest}`;

const peerUp = await fetch(`${BASE}${peerApi(remotePeer.name, 'models')}`)
  .then((r) => r.ok)
  .catch(() => false);
if (!peerUp) {
  console.error(
    `${remotePeer.name} is unreachable — the demo copies to it (ground rules: record with both peers up).`,
  );
  process.exit(1);
}

// Warm-compile every route the demo visits, or dev-mode compiles freeze
// mid-video.
for (const p of ['/', '/cold-storage', '/download/hf', '/download/lemonade']) {
  await api(p);
}
await api(`/${localPeer.name.toLowerCase()}`);

// Leftovers of the demo model (from an interrupted take) spoil the download
// and copy beats — clear them everywhere, like the demo itself would have.
const has = async (path: string) =>
  (await (await api(path)).text()).includes(DEMO_ROW);
if (await has('/api/v1/local-models')) {
  console.log(`pre-flight: deleting leftover ${DEMO_ROW} from local storage`);
  await del('/api/v1/local-models', [DEMO_PATH]);
}
if (await has('/api/v1/cold-storage')) {
  console.log(`pre-flight: deleting leftover ${DEMO_ROW} from cold storage`);
  await del('/api/v1/cold-storage', [DEMO_PATH]);
}
if (await has(peerApi(remotePeer.name, 'models'))) {
  console.log(
    `pre-flight: deleting leftover ${DEMO_ROW} from ${remotePeer.name}`,
  );
  await del(peerApi(remotePeer.name, 'models'), [DEMO_PATH]);
}

// Beat 10 needs the audit to find the model Incomplete: remove the mmproj
// the previous take re-downloaded (the beat repairs it again on camera).
if ((await (await api('/api/v1/local-models')).text()).includes('mmproj-F16')) {
  console.log('pre-flight: deleting the mmproj so the audit finds a gap');
  await del('/api/v1/local-models', [AUDIT_MMPROJ]);
}

// ————— Recording —————

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: {width: 1440, height: 900},
  colorScheme: 'dark',
  recordVideo: {dir: OUT_DIR, size: {width: 1440, height: 900}},
});
context.setDefaultTimeout(15000);

// Visible fake cursor: headless video has no OS pointer, so without it the
// interactions are unfollowable.
await context.addInitScript(() => {
  const ensure = () => {
    if (document.getElementById('--demo-cursor')) return;
    const d = document.createElement('div');
    d.id = '--demo-cursor';
    Object.assign(d.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '22px',
      height: '22px',
      borderRadius: '50%',
      border: '2.5px solid rgba(255, 170, 0, 0.95)',
      background: 'rgba(255, 170, 0, 0.25)',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-50%, -50%)',
      transition: 'width 80ms, height 80ms',
    });
    document.body.appendChild(d);
  };
  document.addEventListener('DOMContentLoaded', ensure);
  document.addEventListener(
    'mousemove',
    (e) => {
      ensure();
      const d = document.getElementById('--demo-cursor');
      if (!d) return;
      d.style.left = e.clientX + 'px';
      d.style.top = e.clientY + 'px';
    },
    true,
  );
  document.addEventListener(
    'mousedown',
    () => {
      const d = document.getElementById('--demo-cursor');
      if (!d) return;
      d.style.width = '14px';
      d.style.height = '14px';
      setTimeout(() => {
        d.style.width = '22px';
        d.style.height = '22px';
      }, 180);
    },
    true,
  );
});

const page = await context.newPage();
const pause = (ms: number) => page.waitForTimeout(ms);

// Glide to a locator's center in steps: instant jumps miss hover handlers,
// and look wrong on video anyway.
async function glideTo(target: ReturnType<typeof page.locator>) {
  const box = await target.boundingBox();
  if (!box) throw new Error('no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 25,
  });
}
async function glideClick(target: ReturnType<typeof page.locator>) {
  await glideTo(target);
  await pause(350);
  await target.click();
}

// Astryx tabs are <button class="astryx-tab">, not role=tab.
const tab = (text: string | RegExp) =>
  page.locator('nav .astryx-tab', {hasText: text}).first();

// The download progress dialog's footer button (a text button — not the ✕
// of a dialog beneath, whose aria-label is also "Close"). Reads Cancel
// while running, Close when done. Matches "Redownloading…" too.
const progressClose = () =>
  page
    .getByRole('dialog')
    .filter({hasText: /downloading/i})
    .locator('button.astryx-button')
    .filter({hasText: /^Close$/});

// The footer Copy button label cycles Copy to… / Checking… / Copying…
const copyBtn = () =>
  page.getByRole('button', {name: /^Copy(ing| to)…|^Checking…/}).first();

const demoRow = () => page.locator('tr', {hasText: DEMO_ROW}).first();
const demoCheck = () => demoRow().getByRole('checkbox').first();

const steps: Array<{label: string; at: number}> = [];
const step = (label: string) => {
  steps.push({label, at: Date.now()});
  console.log(new Date().toISOString(), 'STEP:', label);
};

try {
  step('beat 1: inventory at a glance');
  await page.goto(`${BASE}/`, {waitUntil: 'load'});
  await pause(3500);
  await page.mouse.move(720, 300, {steps: 15});
  await page.mouse.wheel(0, -10000); // table streams in pre-scrolled
  await pause(2500);

  step('beat 2: real list, scroll');
  await page.mouse.wheel(0, 600);
  await pause(1400);
  await page.mouse.wheel(0, -600);
  await pause(900);

  step('beat 3: expand a multi-quant model');
  const expander = page
    .locator('tr', {hasText: EXPAND_MODEL})
    .first()
    .getByRole('button')
    .first();
  await glideClick(expander);
  await pause(2500);
  await glideClick(expander);
  await pause(900);

  step('beat 4: disabled Copy tooltip');
  await glideTo(copyBtn());
  await pause(2400);

  step('beat 5: HF download start to finish');
  await glideClick(page.getByRole('button', {name: 'Add model'}));
  await pause(700);
  await glideClick(page.getByText('From Hugging Face', {exact: true}));
  await pause(1500);
  const urlInput = page.getByPlaceholder(/org\/repo/);
  await glideClick(urlInput);
  await urlInput.pressSequentially(DEMO_REPO, {delay: 55});
  await page
    .getByText(new RegExp(DEMO_FILE.replace('.', '\\.')))
    .first()
    .waitFor({timeout: 30000});
  await pause(800);
  await glideClick(page.getByRole('checkbox', {name: /UD-IQ2_M/}).first());
  await pause(1000);
  await glideClick(page.getByRole('button', {name: 'Download', exact: true}));
  step('  …waiting for download to finish');
  await progressClose().waitFor({timeout: LONG});
  await pause(1800);
  await glideClick(progressClose());
  await pause(1200);
  await page.keyboard.press('Escape'); // close the picker beneath
  await pause(1500);
  await page.reload({waitUntil: 'load'}); // the F5 a user would do
  await pause(3000);
  await page.mouse.wheel(0, -10000);
  await pause(1200);
  step('  …confirming the new row');
  await demoRow().waitFor({timeout: 75000});
  await pause(1200);

  step('beat 6: copy to peer + cold storage');
  await glideClick(demoCheck());
  await pause(1200);
  await glideClick(copyBtn());
  await pause(1500);
  // The copy modal is role=alertdialog, and Astryx CheckboxInputs with
  // visible labels expose no accessible name — locate by adjacent text.
  const copyDlg = page.getByRole('alertdialog');
  await glideClick(
    copyDlg
      .locator(`input[type=checkbox]:near(:text("${remotePeer.name}"))`)
      .first(),
  );
  await pause(600);
  await glideClick(
    copyDlg.locator('input[type=checkbox]:near(:text("Cold storage"))').first(),
  );
  await pause(900);
  await glideClick(copyDlg.getByRole('button', {name: 'Copy', exact: true}));
  step('  …waiting for copy to finish');
  await page
    .getByRole('button', {name: 'Copying…'})
    .waitFor({timeout: 15000})
    .catch(() => {});
  await page
    .getByRole('button', {name: 'Copying…'})
    .waitFor({state: 'hidden', timeout: LONG});
  await demoRow().getByText('Complete').first().waitFor({timeout: 90000});
  await pause(2500);
  await glideClick(demoCheck()); // untick
  await pause(800);

  step('beat 7: audit on the peer');
  await glideClick(tab(remotePeer.name));
  await pause(2500);
  await demoRow().waitFor({timeout: 75000});
  await glideClick(demoCheck());
  await pause(900);
  await glideClick(page.getByRole('button', {name: 'Audit', exact: true}));
  step('  …waiting for audit to finish');
  await page
    .getByRole('button', {name: 'Auditing…'})
    .waitFor({timeout: 30000})
    .catch(() => {});
  await page
    .getByRole('button', {name: 'Audit', exact: true})
    .waitFor({timeout: LONG});
  await pause(3000);
  await glideClick(tab('Cold Storage'));
  await pause(2500);
  await glideClick(tab('All'));
  await pause(1500);
  await page.mouse.wheel(0, -10000);
  await pause(800);

  step('beat 8: delete everywhere');
  await demoRow().waitFor({timeout: 75000});
  await glideClick(demoCheck());
  await pause(1000);
  await glideClick(page.getByRole('button', {name: 'Delete…'}));
  await pause(2000);
  await glideClick(page.getByRole('button', {name: 'Delete', exact: true}));
  await pause(2000);
  await glideClick(page.getByRole('button', {name: 'Confirm delete'}));
  step('  …waiting for delete to finish');
  await page
    .getByText(DEMO_ROW)
    .first()
    .waitFor({state: 'hidden', timeout: LONG})
    .catch(() => {});
  await pause(2500);

  step('beat 9: Lemonade download and delete');
  await glideClick(page.getByRole('button', {name: 'Add model'}));
  await pause(700);
  await glideClick(page.getByText('From Lemonade', {exact: true}));
  await pause(2000);
  await glideClick(
    page.locator('input[type=checkbox]:near(:text("Suggested only"))').first(),
  );
  await pause(900);
  const filter = page.getByPlaceholder(/Filter by name/);
  await glideClick(filter);
  await filter.pressSequentially(DEMO_ROW, {delay: 60});
  await pause(1500);
  // Catalog rows have no checkbox — clicking the row selects it.
  await glideClick(page.getByText(new RegExp(`${DEMO_REPO}:`)).first());
  await pause(1000);
  await glideClick(
    page.getByRole('button', {name: 'Download', exact: true}).first(),
  );
  step('  …waiting for lemonade download to finish');
  await progressClose().waitFor({timeout: LONG});
  await pause(1800);
  await glideClick(progressClose());
  await pause(1200);
  await page.keyboard.press('Escape'); // leave the Lemonade browser
  await pause(1500);
  await page.mouse.wheel(0, -10000);
  await pause(1000);
  step('  …waiting for the lemonade row (30s table poll)');
  await demoRow().waitFor({timeout: 75000});
  await pause(1000);
  await glideClick(demoCheck());
  await pause(1000);
  await glideClick(page.getByRole('button', {name: 'Delete…'}));
  await pause(1800);
  await glideClick(page.getByRole('button', {name: 'Delete', exact: true}));
  await pause(1500);
  await glideClick(page.getByRole('button', {name: 'Confirm delete'}));
  await page
    .getByText(DEMO_ROW)
    .first()
    .waitFor({state: 'hidden', timeout: LONG})
    .catch(() => {});
  await pause(2000);

  step('beat 10: audit finds a problem, Download mmproj');
  await glideClick(tab(`${localPeer.name} (local)`));
  await pause(2500);
  const auditRow = page.locator('tr', {hasText: AUDIT_MODEL}).first();
  const auditCheck = auditRow.getByRole('checkbox').first();
  await auditCheck.scrollIntoViewIfNeeded();
  await pause(800);
  await glideClick(auditCheck);
  await pause(900);
  await glideClick(page.getByRole('button', {name: 'Audit', exact: true}));
  step('  …waiting for the big audit (hashes the weights)');
  await page
    .getByRole('button', {name: 'Auditing…'})
    .waitFor({timeout: 30000})
    .catch(() => {});
  await page
    .getByRole('button', {name: 'Audit', exact: true})
    .waitFor({timeout: 20 * 60 * 1000});
  await pause(2000);
  const incomplete = auditRow.getByText('Incomplete').first();
  await incomplete.scrollIntoViewIfNeeded();
  await glideTo(incomplete);
  await pause(1500); // hovercard opens
  await glideClick(page.getByRole('button', {name: 'Download mmproj'}));
  step('  …waiting for the mmproj redownload to finish');
  await progressClose().waitFor({timeout: LONG});
  await pause(1800);
  await glideClick(progressClose());
  await pause(1200);
  await glideClick(auditCheck); // untick
  await pause(600);

  step('beat 11: rest');
  await glideClick(tab('All'));
  await pause(1500);
  await page.mouse.move(720, 60, {steps: 15});
  await pause(2500);

  step('done');
} catch (e) {
  console.error('FAILED:', e);
  await page.screenshot({path: `${OUT_DIR}/failure.png`}).catch(() => {});
  process.exitCode = 1;
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  if (steps.length > 1) {
    // Video time ≈ time since the beat-1 step — paste into
    // docs/demo-script-timestamps.md after a good take.
    console.log('\nBeat timestamps (video-relative):');
    const t0 = steps[0].at;
    for (const s of steps) {
      const t = Math.max(0, Math.round((s.at - t0) / 1000));
      const mmss = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      console.log(`  ${mmss.padStart(5)}  ${s.label}`);
    }
  }
  if (video) console.log('\nVIDEO:', await video.path());
}
