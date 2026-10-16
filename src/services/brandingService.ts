import { supabase } from '../lib/supabase';
import { PwaBrandingConfig } from '../types';

export interface ProcessedIcons {
  icon_192: string;
  icon_512: string;
  icon_maskable: string;
  originalWidth: number;
  originalHeight: number;
}

/**
 * Valida o arquivo de imagem para ícone do PWA.
 * - Formato: PNG, JPEG ou WEBP
 * - Tamanho máximo: 2MB (2 * 1024 * 1024 bytes)
 */
export function validateIconFile(file: File): { valid: boolean; error?: string } {
  const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    return {
      valid: false,
      error: 'Formato inválido. Selecione uma imagem nos formatos PNG, JPEG ou WEBP.',
    };
  }

  const maxSize = 2 * 1024 * 1024; // 2MB
  if (file.size > maxSize) {
    const sizeInMb = (file.size / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `Arquivo muito grande (${sizeInMb}MB). O tamanho máximo permitido é de 2.00MB.`,
    };
  }

  return { valid: true };
}

/**
 * Carrega um arquivo de imagem em um elemento HTMLImageElement.
 */
function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Falha ao decodificar imagem para processamento.'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Falha ao ler arquivo do dispositivo.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Gera um ícone padrão quadrado redimensionado mantendo proporção e centralizado.
 */
function renderSquareIcon(img: HTMLImageElement, size: number, bgFill = '#000000'): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Contexto 2D do Canvas indisponível no navegador.');

  // Preencher fundo escuro oficial PX CUSTOM para consistência estética
  ctx.fillStyle = bgFill;
  ctx.fillRect(0, 0, size, size);

  // Calcular proporção mantendo aspecto (contain)
  const scale = Math.min(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (size - w) / 2;
  const y = (size - h) / 2;

  ctx.drawImage(img, x, y, w, h);
  return canvas.toDataURL('image/png');
}

/**
 * Gera o ícone maskable (adaptativo do Android) respeitando a Safe Zone da W3C.
 * A zona segura (safe zone) ocupa o círculo interno com 80% do diâmetro total.
 * O logo é escalado para 75% da área e centralizado com fundo escuro.
 */
function renderMaskableIcon(img: HTMLImageElement, size = 512, bgFill = '#000000'): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Contexto 2D do Canvas indisponível no navegador.');

  // Preencher fundo integral da área maskable
  ctx.fillStyle = bgFill;
  ctx.fillRect(0, 0, size, size);

  // Safe Zone: escala máxima de 75% para garantir margem de segurança contra corte circular do Android
  const safeAreaSize = size * 0.75; // 384px em tela de 512px
  const scale = Math.min(safeAreaSize / img.width, safeAreaSize / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (size - w) / 2;
  const y = (size - h) / 2;

  ctx.drawImage(img, x, y, w, h);
  return canvas.toDataURL('image/png');
}

/**
 * Processa a imagem enviada gerando simultaneamente:
 * - 192x192 (standard / any)
 * - 512x512 (splash / any)
 * - 512x512 (maskable / safe-zone 80%)
 */
export async function processPwaIcon(file: File, bgFill = '#000000'): Promise<ProcessedIcons> {
  const validation = validateIconFile(file);
  if (!validation.valid) {
    throw new Error(validation.error || 'Arquivo de imagem inválido.');
  }

  const img = await loadImageFromFile(file);

  const icon_192 = renderSquareIcon(img, 192, bgFill);
  const icon_512 = renderSquareIcon(img, 512, bgFill);
  const icon_maskable = renderMaskableIcon(img, 512, bgFill);

  return {
    icon_192,
    icon_512,
    icon_maskable,
    originalWidth: img.width,
    originalHeight: img.height,
  };
}

/**
 * Consulta a configuração pública ativa de branding/PWA no servidor.
 */
export async function getPwaBranding(): Promise<PwaBrandingConfig> {
  try {
    const res = await fetch('/api/branding');
    if (!res.ok) {
      throw new Error(`Falha ao obter configurações de branding: ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    console.warn('[Branding] Usando ícones padrão locais devido a falha na requisição:', err);
    return {
      is_custom: false,
      icon_192: '/px-logo-192.png',
      icon_512: '/px-logo-512.png',
      icon_maskable: '/px-logo-maskable-512.png',
    };
  }
}

/**
 * Salva os novos ícones processados no backend autoritativo.
 * Requer sessão ativa de ADMIN ou SUPER_ADMIN.
 */
export async function savePwaBranding(icons: {
  icon_192: string;
  icon_512: string;
  icon_maskable: string;
}): Promise<PwaBrandingConfig> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Sessão administrativa expirada ou não autenticada. Faça login novamente.');
  }

  const res = await fetch('/api/admin/pwa-icon', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      icon_192: icons.icon_192,
      icon_512: icons.icon_512,
      icon_maskable: icons.icon_maskable,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Falha ao salvar ícones PWA no servidor.');
  }

  return data.branding;
}

/**
 * Restaura os ícones do PWA para o logotipo oficial da PX CUSTON.
 */
export async function resetPwaBranding(): Promise<PwaBrandingConfig> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Sessão administrativa expirada ou não autenticada. Faça login novamente.');
  }

  const res = await fetch('/api/admin/pwa-icon/reset', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Falha ao restaurar ícones padrão no servidor.');
  }

  return data.branding;
}

/**
 * Aplica os ícones atualizados dinamicamente na página HTML ativa.
 * Atualiza <link rel="icon">, <link rel="apple-touch-icon"> e força atualização de cache.
 */
export function applyDynamicPwaIcons(branding: PwaBrandingConfig) {
  if (typeof document === 'undefined') return;

  const cacheBuster = branding.updated_at ? `?v=${new Date(branding.updated_at).getTime()}` : '';
  const targetIcon = branding.icon_192 ? `${branding.icon_192}${cacheBuster}` : '/px-logo-192.png';

  // Atualizar favicon do navegador
  let favicon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (favicon) {
    favicon.href = targetIcon;
  }

  // Atualizar Apple Touch Icon para iOS Safari
  let appleIcon = document.querySelector<HTMLLinkElement>("link[rel='apple-touch-icon']");
  if (appleIcon) {
    appleIcon.href = targetIcon;
  }

  // Atualizar o Manifesto Web dinâmico (cria se ainda não existir no DOM)
  let manifestLink = document.querySelector<HTMLLinkElement>("link[rel='manifest']");
  if (!manifestLink) {
    manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    document.head.appendChild(manifestLink);
  }
  manifestLink.href = `/manifest.webmanifest${cacheBuster}`;
}
