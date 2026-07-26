import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_QRENCODE = "/opt/homebrew/bin/qrencode";
const MAX_LINK_BYTES = 4096;

function validateQrSvg(svg: string): string {
  const lines = svg.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let roots = 0;
  let rects = 0;
  for (const line of lines) {
    if (/^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>$/.test(line)) continue;
    if (/^<!-- Created with qrencode [0-9.]+ \(https:\/\/fukuchi\.org\/works\/qrencode\/index\.html\) -->$/.test(line)) continue;
    if (/^<svg width="[0-9.]+cm" height="[0-9.]+cm" viewBox="0 0 [0-9]+ [0-9]+" preserveAspectRatio="none" version="1\.1" xmlns="http:\/\/www\.w3\.org\/2000\/svg">$/.test(line)) {
      roots += 1;
      continue;
    }
    if (line === '<g id="QRcode">' || /^<g id="Pattern" transform="translate\([0-9]+,[0-9]+\)">$/.test(line)
      || line === "</g>" || line === "</svg>") continue;
    if (/^<rect x="[0-9]+" y="[0-9]+" width="[0-9]+" height="[0-9]+" fill="#(?:000000|ffffff)"\/>$/.test(line)) {
      rects += 1;
      continue;
    }
    throw new Error("qrencode returned SVG outside the inert geometry allowlist");
  }
  if (roots !== 1 || rects < 1 || lines.at(-1) !== "</svg>") throw new Error("qrencode returned invalid SVG geometry");
  return svg;
}

/**
 * Render a handoff QR entirely on the local workstation. No token or URL is
 * sent to an external image service. qrencode's SVG output contains geometry,
 * not a plaintext copy of the bearer fragment.
 */
export async function renderQrSvg(value: string, binary = process.env.FLOYD_QRENCODE_BIN ?? DEFAULT_QRENCODE): Promise<string> {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_LINK_BYTES) {
    throw Object.assign(new Error("QR payload must be between 1 and 4096 bytes"), { statusCode: 400 });
  }
  try {
    const { stdout } = await execFileAsync(binary, ["-t", "SVG", "-l", "Q", "-m", "2", "-o", "-", value], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return validateQrSvg(stdout);
  } catch (error) {
    throw Object.assign(new Error(`local QR rendering failed: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 503 });
  }
}
