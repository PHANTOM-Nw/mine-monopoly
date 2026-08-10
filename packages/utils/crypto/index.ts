const MAGIC = new Uint8Array([0x4d, 0x4d, 0x4d, 0x50]); // "MMMP"
const IV_LENGTH = 16;

/**
 * crypto.randomUUID 的安全替代。
 *
 * ⚠ crypto.randomUUID 只在 secure context 里存在（https、localhost、127.0.0.1）。
 * 用 http + 裸 IP 访问部署好的站点时它是 undefined，直接调会抛 TypeError。
 *
 * 这个坑特别难查：如果它发生在 pinia store 的 state() 里，pinia 会**先**把半成品
 * store 塞进 _s（源码里那句 "store the partial store now so the setup of stores can
 * instantiate each other"），然后才跑 setup()。setup() 抛异常后半成品留在缓存里，
 * 之后每次 useXxx() 都拿到一个没有 actions 的残缺 store，报错变成
 * "xxx(...).someAction is not a function"，跟真正的原因八竿子打不着。
 *
 * crypto.getRandomValues 没有 secure context 限制，用它兜底。
 */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

function getKeyBytes(key: string): Uint8Array {
  if (!key) throw new Error("加密密钥未配置，请检查 MAP_ENCRYPT_KEY 环境变量");
  const bytes = new TextEncoder().encode(key);
  if (bytes.length !== 16) throw new Error(`AES key must be 16 bytes, got ${bytes.length}`);
  return bytes;
}

async function importKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", getKeyBytes(key) as BufferSource, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(data: Uint8Array, key: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cryptoKey = await importKey(key);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, data as BufferSource);
  const result = new Uint8Array(4 + IV_LENGTH + encrypted.byteLength);
  result.set(MAGIC, 0);
  result.set(iv, 4);
  result.set(new Uint8Array(encrypted), 4 + IV_LENGTH);
  return result;
}

export function isProductFile(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x4d && data[3] === 0x50;
}

export async function decrypt(data: Uint8Array, key: string): Promise<Uint8Array> {
  if (!isProductFile(data)) throw new Error("Not a .mmmap file");
  const iv = data.slice(4, 4 + IV_LENGTH);
  const encrypted = data.slice(4 + IV_LENGTH);
  const cryptoKey = await importKey(key);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, encrypted as BufferSource);
    return new Uint8Array(decrypted);
  } catch {
    throw new Error("地图文件解密失败，可能是加密密钥不匹配");
  }
}