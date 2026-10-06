import webmcpUrl from '@jason.today/webmcp/src/webmcp.js?url';
import type {} from './webmcp-types';

let scriptPromise: Promise<void> | null = null;
let libraryLoaded = false;

function appendScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}.`));
    document.head.appendChild(script);
  });
}

async function loadWebMCP(): Promise<void> {
  if (!libraryLoaded) {
    await appendScript(webmcpUrl);
    libraryLoaded = true;
  }
  await appendScript('/webmcp-adapter.js');
  if (!window.WebMCP) throw new Error('WebMCP did not initialize.');
}

export function loadScript(): Promise<void> {
  if (window.WebMCP) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = loadWebMCP().catch(error => {
      scriptPromise = null;
      throw error;
    });
  }
  return scriptPromise;
}
