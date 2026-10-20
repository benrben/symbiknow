import { sha256 } from "@noble/hashes/sha2.js";

self.onmessage = async ({ data }: MessageEvent<File>) => {
  try {
    const hash = sha256.create();
    for (let offset = 0; offset < data.size; offset += 1024 * 1024) {
      hash.update(
        new Uint8Array(
          await data.slice(offset, offset + 1024 * 1024).arrayBuffer(),
        ),
      );
    }
    const digest = Array.from(hash.digest(), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    self.postMessage({ digest });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
