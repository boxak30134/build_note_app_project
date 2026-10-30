/** BYOK API Key 로컬 암호화 저장 (Web Crypto AES-GCM, 추출 불가능한 마스터 키를 IndexedDB 에 보관) */
import { db } from './db';
import type { AiProviderId } from '../store/settingsStore';

async function masterKey(): Promise<CryptoKey> {
  const rec = await db.secrets.get('master-key');
  if (rec?.value instanceof CryptoKey) return rec.value;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await db.secrets.put({ id: 'master-key', value: key });
  return key;
}

interface Encrypted {
  iv: Uint8Array;
  data: ArrayBuffer;
}

export async function saveApiKey(provider: AiProviderId, apiKey: string): Promise<void> {
  const key = await masterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(apiKey));
  await db.secrets.put({ id: `ai:${provider}`, value: { iv, data } satisfies Encrypted });
}

export async function loadApiKey(provider: AiProviderId): Promise<string | null> {
  const rec = await db.secrets.get(`ai:${provider}`);
  if (!rec) return null;
  const { iv, data } = rec.value as Encrypted;
  try {
    const key = await masterKey();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function removeApiKey(provider: AiProviderId): Promise<void> {
  await db.secrets.delete(`ai:${provider}`);
}

export async function connectedProviders(): Promise<AiProviderId[]> {
  const all = await db.secrets.where('id').startsWith('ai:').primaryKeys();
  return all.map((k) => String(k).slice(3) as AiProviderId);
}
