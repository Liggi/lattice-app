/**
 * Copies through a hidden textarea, which works on mobile Safari and over
 * plain http, where the clipboard API may not. Returns false when the browser
 * refused the copy, and puts focus back where it was.
 */
export function copyText(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '-9999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    return document.execCommand('copy');
  } catch (err) {
    console.error('Failed to copy:', err);
    return false;
  } finally {
    document.body.removeChild(textArea);
    previous?.focus({ preventScroll: true });
  }
}
