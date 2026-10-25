import { MercadoPagoConfig } from '../types';
import { supabase } from '../lib/supabase';

export interface ServerPaymentStatusResponse {
  configured: boolean;
  is_connected: boolean;
  environment: 'sandbox' | 'production';
  effective_environment: 'sandbox' | 'production';
  environment_warning: string | null;
  public_key: string;
  pix_enabled: boolean;
  pix_instant_enabled: boolean;
  credit_card_enabled: boolean;
  boleto_enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface SavePaymentSettingsPayload {
  environment: 'sandbox' | 'production';
  public_key: string;
  pix_enabled: boolean;
  pix_instant_enabled: boolean;
  credit_card_enabled: boolean;
  boleto_enabled: boolean;
}

export function mapServerResponseToMercadoPagoConfig(
  data: Partial<ServerPaymentStatusResponse>,
  fallback?: MercadoPagoConfig
): MercadoPagoConfig {
  return {
    public_key: typeof data.public_key === 'string' ? data.public_key : (fallback?.public_key ?? ''),
    // Segredos privados nunca trafegam pelo frontend
    access_token: '',
    webhook_secret: '',
    environment:
      data.environment === 'production' || data.environment === 'sandbox'
        ? data.environment
        : (fallback?.environment ?? 'sandbox'),
    is_connected: Boolean(data.configured ?? data.is_connected ?? fallback?.is_connected ?? false),
    pix_enabled: typeof data.pix_enabled === 'boolean' ? data.pix_enabled : (fallback?.pix_enabled ?? true),
    pix_instant_enabled:
      typeof data.pix_instant_enabled === 'boolean'
        ? data.pix_instant_enabled
        : (fallback?.pix_instant_enabled ?? true),
    credit_card_enabled: false,
    boleto_enabled: false,
  };
}

export async function fetchPaymentSettings(signal?: AbortSignal): Promise<ServerPaymentStatusResponse> {
  const response = await fetch('/api/payments/config', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.error || 'Não foi possível carregar as configurações de pagamento do servidor.');
  }

  return {
    configured: Boolean(data.configured),
    is_connected: Boolean(data.is_connected ?? data.configured),
    environment: data.environment === 'production' ? 'production' : 'sandbox',
    effective_environment: data.effective_environment === 'production' ? 'production' : 'sandbox',
    environment_warning: data.environment_warning || null,
    public_key: typeof data.public_key === 'string' ? data.public_key : '',
    pix_enabled: typeof data.pix_enabled === 'boolean' ? data.pix_enabled : true,
    pix_instant_enabled: typeof data.pix_instant_enabled === 'boolean' ? data.pix_instant_enabled : true,
    credit_card_enabled: false,
    boleto_enabled: false,
    updated_at: data.updated_at || null,
    updated_by: data.updated_by || null,
  };
}

export async function savePaymentSettings(
  config: SavePaymentSettingsPayload
): Promise<{ message: string; status: ServerPaymentStatusResponse; config: MercadoPagoConfig }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Sessão administrativa expirada ou não autenticada. Faça login novamente.');
  }

  // Envia estritamente campos não sensíveis ao backend; cartão e boleto permanecem bloqueados
  const sanitizedPayload: SavePaymentSettingsPayload = {
    environment: config.environment === 'production' ? 'production' : 'sandbox',
    public_key: (config.public_key || '').trim(),
    pix_enabled: Boolean(config.pix_enabled),
    pix_instant_enabled: Boolean(config.pix_instant_enabled ?? config.pix_enabled),
    credit_card_enabled: false,
    boleto_enabled: false,
  };

  const response = await fetch('/api/admin/payments/config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(sanitizedPayload),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success || !data?.config) {
    throw new Error(
      data?.error || `Falha ao salvar configurações de pagamento no servidor (HTTP ${response.status}).`
    );
  }

  const serverConfig: ServerPaymentStatusResponse = data.config;
  return {
    message: data.message || 'Configurações de pagamento salvas com sucesso no servidor.',
    status: serverConfig,
    config: mapServerResponseToMercadoPagoConfig(serverConfig),
  };
}
