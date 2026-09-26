/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Build-time constants injected by vite.config.mts
declare const __BUILD_TIME__: string;
declare const __GIT_HASH__: string;

// Web Speech API (vendor-prefixed)
interface Window {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webkitSpeechRecognition: any;
}