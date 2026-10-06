import { afterEach, beforeEach } from 'vitest';
import { installAssistantBrowser } from './AppAssistantPanel.test.helpers';

export function installWorkspaceBrowser() {
  installAssistantBrowser();
  const rects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  const bounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  beforeEach(() => {
    const measured = function(this: Range) { return new DOMRect(0, 0, this.toString().length * 7, 14); };
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function(this: Range) { return [measured.call(this)]; } });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: measured });
  });
  afterEach(() => {
    if (rects) Object.defineProperty(Range.prototype, 'getClientRects', rects);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
    if (bounds) Object.defineProperty(Range.prototype, 'getBoundingClientRect', bounds);
    else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  });
}

export function inputFile(content: string, name: string) {
  const file = new File([content], name, { type: 'text/markdown' });
  // jsdom's File implements FileReader, but not the browser's Blob.text API.
  Object.defineProperty(file, 'text', { value: () => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  }) });
  return file;
}
