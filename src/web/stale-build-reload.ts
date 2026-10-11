/**
 * A tab left open across a deploy keeps running the old client: on 10 Oct
 * 2026 a phone tab showed "Just started" three hours after the build that
 * removed it went live. When the tab comes back into view, compare the main
 * bundle index.html names now with the one this page loaded, and reload if
 * they differ. Not while anything is typed: composer drafts are not saved,
 * so the reload waits for the next time the tab is shown with empty fields.
 */

const MAIN_BUNDLE = /\/assets\/main-[^"'\s]+\.js/;

function loadedBundle(): string | null {
  for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    const match = MAIN_BUNDLE.exec(new URL(script.src, location.href).pathname);
    if (match) return match[0];
  }
  return null;
}

function somethingTyped(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
    'textarea, input[type="text"], input:not([type]), [contenteditable="true"]',
  );
  return Array.from(fields).some((field) =>
    'value' in field ? field.value.trim() !== '' : (field.textContent ?? '').trim() !== '');
}

export function installStaleBuildReload(): void {
  const loaded = loadedBundle();
  // The dev server loads /src/main.tsx, which has no build to go stale.
  if (!loaded) return;
  let checking = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || checking) return;
    checking = true;
    void fetch('/', { cache: 'no-store' })
      .then((response) => (response.ok ? response.text() : ''))
      .then((html) => {
        const current = MAIN_BUNDLE.exec(html)?.[0];
        if (current && current !== loaded && !somethingTyped()) window.location.reload();
      }, () => {})
      .finally(() => { checking = false; });
  });
}
