// A reader for the archives migrate.sh produces.
//
// Just enough tar to unpack one export bundle: ustar headers, the GNU long-name
// extension, and pax headers skipped. Written here rather than pulled in as a
// dependency because the archive format is fixed by our own script
// (`tar --format=ustar`), and a reader this small is cheaper to own than to
// audit. Everything is read into memory; a bundle is capped at 64 MB by the
// exporter, so that is fine.
//
// Runtime-neutral on purpose: no Buffer, no zlib. The caller gunzips (node's
// zlib in the CLI, DecompressionStream in the console), and this file is kept
// byte-identical between cli/src/migrate and dashboard/src/lib/migrate; a test
// on the dashboard side checks that.

export type TarEntry = {
  /** Path inside the archive, exactly as stored. */
  path: string;
  data: Uint8Array;
};

const BLOCK = 512;
const decoder = new TextDecoder();

function field(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const stop = offset + length;
  while (end < stop && block[end] !== 0) end++;
  return decoder.decode(block.subarray(offset, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const text = field(block, offset, length).trim();
  if (text === "") return 0;
  // GNU base-256 size encoding for files over 8 GB; irrelevant here, but do
  // not silently misread it as zero.
  if ((block[offset] ?? 0) & 0x80) {
    throw new Error("Unsupported tar size encoding.");
  }
  const value = parseInt(text, 8);
  if (Number.isNaN(value)) throw new Error("Malformed tar header.");
  return value;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/** Unpack an (already decompressed) tar into its regular files. Directories
 * and anything that is not a plain file are dropped. */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;
    offset += BLOCK;

    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error("Truncated tar archive.");
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      // GNU long name: the next entry's path is this entry's body.
      pendingLongName = decoder
        .decode(bytes.subarray(dataStart, dataEnd))
        .replace(/\0+$/, "");
      continue;
    }
    // Pax headers ('x', 'g') and everything that is not a plain file.
    if (type !== "0" && type !== "\0" && type !== "") continue;

    let path: string;
    if (pendingLongName !== null) {
      path = pendingLongName;
      pendingLongName = null;
    } else {
      path = field(header, 0, 100);
      // ustar splits a long path into prefix + name.
      const prefix = field(header, 257, 6).startsWith("ustar")
        ? field(header, 345, 155)
        : "";
      if (prefix) path = `${prefix}/${path}`;
    }
    entries.push({ path, data: bytes.slice(dataStart, dataEnd) });
  }
  return entries;
}
