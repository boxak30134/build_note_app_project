/** BYOK API Key 로컬 암호화 저장 (Web Crypto AES-GCM, 추출 불가능한 마스터 키를 IndexedDB 에 보관) */
import { db } from './db';
import type { AiProviderId } from '../store/settingsStore';
import { sanitizeEnvApiKey } from '../core/android/androidDeployment';

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
  try {
    const key = await masterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(apiKey));
    await db.secrets.put({ id: `ai:${provider}`, value: { iv, data } satisfies Encrypted });
  } catch {
    try {
      localStorage.setItem(`eduink_key_${provider}`, apiKey);
    } catch {
      // ignore
    }
  }
}

export function getEnvGeminiKey(): string | null {
  try {
    return sanitizeEnvApiKey(import.meta.env?.VITE_GEMINI_API_KEY, import.meta.env);
  } catch {
    // ignore
  }
  return null;
}

export async function loadApiKey(provider: AiProviderId): Promise<string | null> {
  try {
    const rec = await db.secrets.get(`ai:${provider}`);
    if (rec) {
      const { iv, data } = rec.value as Encrypted;
      const key = await masterKey();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data);
      const decoded = new TextDecoder().decode(plain).trim();
      if (decoded) return decoded;
    }
  } catch {
    // IndexedDB 또는 WebCrypto 비활성 환경에서는 환경변수 폴백으로 진행
  }
  try {
    const local = localStorage.getItem(`eduink_key_${provider}`)?.trim();
    if (local) return local;
  } catch {
    // ignore
  }
  if (provider === 'google') {
    return getEnvGeminiKey();
  }
  return null;
}

export async function removeApiKey(provider: AiProviderId): Promise<void> {
  try {
    await db.secrets.delete(`ai:${provider}`);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(`eduink_key_${provider}`);
  } catch {
    // ignore
  }
}

export async function connectedProviders(): Promise<AiProviderId[]> {
  let list: AiProviderId[] = [];
  try {
    const all = await db.secrets.where('id').startsWith('ai:').primaryKeys();
    list = all.map((k) => String(k).slice(3) as AiProviderId);
  } catch {
    list = [];
  }
  if (getEnvGeminiKey() && !list.includes('google')) {
    list = ['google', ...list];
  }
  return list;
}

/** Google Cloud Translation API 전용 Key 관리 (Google Gemini AI Key와 완전 분리 영속화) */
export async function saveTranslateApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  try {
    const key = await masterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(trimmed));
    await db.secrets.put({ id: 'translate:google', value: { iv, data } satisfies Encrypted });
  } catch {
    try {
      localStorage.setItem('eduink_key_translate_google', trimmed);
    } catch {
      // ignore
    }
  }
}

export function getEnvGoogleTranslateKey(): string | null {
  try {
    const raw = import.meta.env?.VITE_GOOGLE_TRANSLATE_API_KEY;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  } catch {
    // ignore
  }
  return null;
}

export async function loadTranslateApiKey(): Promise<string | null> {
  try {
    const rec = await db.secrets.get('translate:google');
    if (rec) {
      const { iv, data } = rec.value as Encrypted;
      const key = await masterKey();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data);
      const decoded = new TextDecoder().decode(plain).trim();
      if (decoded) return decoded;
    }
  } catch {
    // ignore
  }
  try {
    const local = localStorage.getItem('eduink_key_translate_google')?.trim();
    if (local) return local;
  } catch {
    // ignore
  }
  // 절대 Google Gemini 키(VITE_GEMINI_API_KEY)를 반환하지 않고 전용 번역 환경변수만 확인
  return getEnvGoogleTranslateKey();
}

export async function removeTranslateApiKey(): Promise<void> {
  try {
    await db.secrets.delete('translate:google');
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem('eduink_key_translate_google');
  } catch {
    // ignore
  }
}

export interface DriveOAuthToken {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  email?: string;
  name?: string;
  scope?: string;
}

const DRIVE_TOKEN_ID = 'oauth:google-drive';
const DRIVE_TOKEN_FALLBACK_KEY = 'eduink_oauth_google_drive';

export async function saveDriveToken(token: DriveOAuthToken): Promise<void> {
  const raw = JSON.stringify(token);
  try {
    const key = await masterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(raw));
    await db.secrets.put({ id: DRIVE_TOKEN_ID, value: { iv, data } satisfies Encrypted });
  } catch {
    try {
      localStorage.setItem(DRIVE_TOKEN_FALLBACK_KEY, raw);
    } catch {
      // ignore
    }
  }
}

export async function loadDriveToken(): Promise<DriveOAuthToken | null> {
  try {
    const rec = await db.secrets.get(DRIVE_TOKEN_ID);
    if (rec) {
      const { iv, data } = rec.value as Encrypted;
      const key = await masterKey();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data);
      const decoded = JSON.parse(new TextDecoder().decode(plain)) as DriveOAuthToken;
      if (decoded?.accessToken) return decoded;
    }
  } catch {
    // ignore
  }
  try {
    const raw = localStorage.getItem(DRIVE_TOKEN_FALLBACK_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DriveOAuthToken;
      if (parsed?.accessToken) return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function removeDriveToken(): Promise<void> {
  try {
    await db.secrets.delete(DRIVE_TOKEN_ID);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(DRIVE_TOKEN_FALLBACK_KEY);
  } catch {
    // ignore
  }
}
