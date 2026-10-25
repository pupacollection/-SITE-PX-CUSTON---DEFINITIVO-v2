import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveProjectRootDir(moduleDir: string = __dirname): string {
  if (
    path.basename(moduleDir) === 'lib' &&
    path.basename(path.dirname(moduleDir)) === 'src'
  ) {
    return path.resolve(moduleDir, '..', '..');
  }
  return path.resolve(moduleDir);
}

export const PROJECT_ROOT_DIR = resolveProjectRootDir(__dirname);

export function resolveDefaultPaymentSettingsPath(
  env?: NodeJS.ProcessEnv,
  moduleDir: string = __dirname
): string {
  const processEnv = env || process.env;
  const customPath = (processEnv.PX_PAYMENT_SETTINGS_PATH || '').trim();
  if (customPath) {
    return path.resolve(customPath);
  }
  return path.resolve(
    resolveProjectRootDir(moduleDir),
    'data',
    'payment-settings.json'
  );
}

export type PaymentEnvironment = 'sandbox' | 'production';

export interface PersistedPaymentSettings {
  environment: PaymentEnvironment;
  public_key: string;
  pix_enabled: boolean;
  pix_instant_enabled: boolean;
  credit_card_enabled: boolean;
  boleto_enabled: boolean;
  updated_at?: string;
  updated_by?: string;
  updated_by_role?: string;
}

export interface CanonicalPaymentConfigResponse {
  configured: boolean;
  is_connected: boolean;
  environment: PaymentEnvironment;
  effective_environment: PaymentEnvironment;
  environment_warning: string | null;
  public_key: string;
  pix_enabled: boolean;
  pix_instant_enabled: boolean;
  credit_card_enabled: boolean;
  boleto_enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface PaymentSettingsValidationResult {
  valid: boolean;
  statusCode: number;
  error?: string;
  code?: string;
  sanitized?: Omit<PersistedPaymentSettings, 'updated_at' | 'updated_by' | 'updated_by_role'>;
}

export const DEFAULT_PAYMENT_SETTINGS_PATH = resolveDefaultPaymentSettingsPath();

export const ALLOWED_PAYMENT_ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;

export function isServerAccessTokenConfigured(rawAccessToken?: string): boolean {
  if (!rawAccessToken || typeof rawAccessToken !== 'string') return false;
  const trimmed = rawAccessToken.trim();
  if (!trimmed) return false;
  if (trimmed.includes('placeholder') || trimmed.includes('****')) return false;
  return true;
}

export function isServerSupabaseSecretConfigured(env?: NodeJS.ProcessEnv): boolean {
  const processEnv = env || process.env;
  const rawSecret = (
    processEnv.SUPABASE_SECRET_KEY ||
    processEnv.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();
  if (!rawSecret) return false;
  if (
    rawSecret === 'dummy_secret_for_initialization' ||
    rawSecret.includes('placeholder') ||
    rawSecret.includes('your-')
  ) {
    return false;
  }
  return true;
}

export interface OperationalEnvironmentInfo {
  isCompiledBuild: boolean;
  isPublicOrProductionSecurityGate: boolean;
  isProductionSecurity: boolean;
  paymentStage: PaymentEnvironment;
  pxEnvironment: string;
}

/**
 * Diferencia de forma explícita e segura:
 * - Modo de execução/build (`NODE_ENV === 'production'` -> `isCompiledBuild`), que desativa middlewares de dev.
 * - Gate de segurança de deploy público/produção (`isPublicOrProductionSecurityGate` / `isProductionSecurity`), que mantém rotas de teste bloqueadas e exige `MP_WEBHOOK_SECRET`.
 * - Estágio operacional de pagamento (`paymentStage`: 'sandbox' quando `PX_ENVIRONMENT=sandbox|staging`, mesmo com `NODE_ENV=production`).
 */
export function resolveOperationalEnvironment(env?: NodeJS.ProcessEnv): OperationalEnvironmentInfo {
  const processEnv = env || process.env;
  const nodeEnv = String(processEnv.NODE_ENV || '').trim().toLowerCase();
  const pxEnv = String(processEnv.PX_ENVIRONMENT || '').trim().toLowerCase();

  const isCompiledBuild = nodeEnv === 'production';
  const isPublicOrProductionSecurityGate = pxEnv === 'production' || nodeEnv === 'production';

  let paymentStage: PaymentEnvironment = 'sandbox';
  if (pxEnv === 'sandbox' || pxEnv === 'staging' || pxEnv === 'development' || pxEnv === 'test') {
    paymentStage = 'sandbox';
  } else if (pxEnv === 'production' || nodeEnv === 'production') {
    paymentStage = 'production';
  }

  return {
    isCompiledBuild,
    isPublicOrProductionSecurityGate,
    isProductionSecurity: isPublicOrProductionSecurityGate,
    paymentStage,
    pxEnvironment: pxEnv || nodeEnv || 'development',
  };
}

export function getDefaultPaymentSettings(env?: NodeJS.ProcessEnv): PersistedPaymentSettings {
  const processEnv = env || process.env;
  const opEnv = resolveOperationalEnvironment(processEnv);
  const defaultPublicKey = (processEnv.MP_PUBLIC_KEY || processEnv.VITE_MP_PUBLIC_KEY || '').trim();

  return {
    environment: opEnv.paymentStage,
    public_key: defaultPublicKey,
    pix_enabled: true,
    pix_instant_enabled: true,
    credit_card_enabled: false,
    boleto_enabled: false,
  };
}

/**
 * Valida estritamente o payload administrativo de configuração do Mercado Pago.
 * - Rejeita tipos inválidos.
 * - Rejeita qualquer tentativa de enviar segredos privados (access_token, webhook_secret, etc.).
 * - Valida formato de public_key quando informada.
 * - Rejeita tentativa de habilitar credit_card_enabled ou boleto_enabled enquanto não implementados.
 * - Exige que pix_enabled permaneça habilitado.
 */
export function validatePaymentSettingsPayload(
  payload: unknown,
  serverSecrets?: { mpAccessToken?: string; mpWebhookSecret?: string; normalizeLegacyUnimplementedMethods?: boolean }
): PaymentSettingsValidationResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Payload de configuração de pagamento inválido ou malformado.',
      code: 'INVALID_PAYLOAD',
    };
  }

  const body = payload as Record<string, unknown>;

  // 1. Bloqueio estrito contra envio/persistência de credenciais secretas
  const forbiddenSecretFields = [
    'access_token',
    'webhook_secret',
    'mp_access_token',
    'mp_webhook_secret',
    'client_secret',
    'mp_client_secret',
  ];

  for (const field of forbiddenSecretFields) {
    const val = body[field];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return {
        valid: false,
        statusCode: 400,
        error:
          'Operação bloqueada por segurança: Credenciais privadas (MP_ACCESS_TOKEN / MP_WEBHOOK_SECRET) nunca devem ser enviadas pelo frontend nem salvas nas configurações.',
        code: 'SECRET_IN_PAYLOAD_FORBIDDEN',
      };
    }
  }

  // 2. Validar environment ('sandbox' | 'production')
  const environment = body.environment;
  if (environment !== 'sandbox' && environment !== 'production') {
    return {
      valid: false,
      statusCode: 400,
      error: 'Ambiente inválido. Os valores permitidos são estritamente "sandbox" ou "production".',
      code: 'INVALID_ENVIRONMENT',
    };
  }

  // 3. Validar public_key
  if (typeof body.public_key !== 'string') {
    return {
      valid: false,
      statusCode: 400,
      error: 'O campo public_key deve ser uma string.',
      code: 'INVALID_PUBLIC_KEY_TYPE',
    };
  }

  const publicKey = body.public_key.trim();
  if (publicKey.length > 256) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Chave pública excede o tamanho máximo permitido (256 caracteres).',
      code: 'PUBLIC_KEY_TOO_LONG',
    };
  }

  // Verificar se o usuário colou acidentalmente o MP_ACCESS_TOKEN ou segredo no campo public_key
  const envAccessToken = (serverSecrets?.mpAccessToken ?? process.env.MP_ACCESS_TOKEN ?? '').trim();
  const envWebhookSecret = (serverSecrets?.mpWebhookSecret ?? process.env.MP_WEBHOOK_SECRET ?? '').trim();

  if (
    publicKey &&
    ((envAccessToken && publicKey === envAccessToken) ||
      (envWebhookSecret && publicKey === envWebhookSecret) ||
      publicKey.startsWith('sb_secret_') ||
      /secret/i.test(publicKey))
  ) {
    return {
      valid: false,
      statusCode: 400,
      error:
        'Valor rejeitado por segurança: O campo Chave Pública (Public Key) não pode conter um Access Token privado ou segredo de servidor.',
      code: 'SECRET_IN_PUBLIC_KEY_FORBIDDEN',
    };
  }

  if (publicKey !== '') {
    // Chaves públicas do Mercado Pago seguem o padrão APP_USR-... ou TEST-...
    const mpPublicKeyPattern = /^(APP_USR|TEST)-[a-zA-Z0-9-]{8,240}$/;
    if (!mpPublicKeyPattern.test(publicKey)) {
      return {
        valid: false,
        statusCode: 400,
        error:
          'Formato de Chave Pública (Public Key) inválido. Utilize uma chave pública oficial do Mercado Pago iniciada por "APP_USR-" ou "TEST-" (ou deixe em branco para usar a chave padrão do ambiente).',
        code: 'INVALID_PUBLIC_KEY_FORMAT',
      };
    }
  }

  // 4. Validar flags booleanas de métodos de pagamento
  if (
    typeof body.pix_enabled !== 'boolean' ||
    typeof body.credit_card_enabled !== 'boolean' ||
    typeof body.boleto_enabled !== 'boolean'
  ) {
    return {
      valid: false,
      statusCode: 400,
      error:
        'Os campos pix_enabled, credit_card_enabled e boleto_enabled devem ser estritamente booleanos (true/false).',
      code: 'INVALID_PAYMENT_METHODS_TYPE',
    };
  }

  const pixEnabled = body.pix_enabled;
  const rawCreditCardEnabled = body.credit_card_enabled;
  const rawBoletoEnabled = body.boleto_enabled;

  // Bloquear habilitação acidental de Cartão ou Boleto por chamadas diretas à API administrativa
  if (!serverSecrets?.normalizeLegacyUnimplementedMethods && (rawCreditCardEnabled || rawBoletoEnabled)) {
    return {
      valid: false,
      statusCode: 400,
      error:
        'Operação bloqueada: Cartão de Crédito e Boleto Bancário ainda não possuem fluxo de cobrança homologado nesta fase e não podem ser habilitados.',
      code: 'PAYMENT_METHOD_NOT_IMPLEMENTED',
    };
  }

  const creditCardEnabled = false;
  const boletoEnabled = false;
  const pixInstantEnabled =
    typeof body.pix_instant_enabled === 'boolean' ? body.pix_instant_enabled : pixEnabled;

  if (!pixEnabled) {
    return {
      valid: false,
      statusCode: 400,
      error:
        'Configuração inválida: O método Pix deve permanecer habilitado enquanto Cartão de Crédito e Boleto estiverem indisponíveis.',
      code: 'NO_PAYMENT_METHOD_ENABLED',
    };
  }

  return {
    valid: true,
    statusCode: 200,
    sanitized: {
      environment,
      public_key: publicKey,
      pix_enabled: pixEnabled,
      pix_instant_enabled: pixInstantEnabled,
      credit_card_enabled: creditCardEnabled,
      boleto_enabled: boletoEnabled,
    },
  };
}

export type PaymentSettingsResolutionSource =
  | 'default_missing_file'
  | 'persisted_file'
  | 'persisted_durable_audit'
  | 'corrupted_or_unreadable'
  | 'durable_store_unavailable';

export interface PaymentSettingsInspectionResult {
  ok: boolean;
  source: PaymentSettingsResolutionSource;
  settings: PersistedPaymentSettings | null;
  statusCode: number;
  error?: string;
  code?: string;
}

/**
 * Inspeciona o arquivo de configurações de pagamento diferenciando estritamente:
 * 1. Arquivo ainda inexistente (ENOENT) -> ok: true, retorna padrões iniciais seguros.
 * 2. Arquivo existente e válido -> ok: true, retorna configurações persistidas (com métodos não implementados travados em false).
 * 3. Arquivo existente porém corrompido, ilegível ou inválido -> ok: false (fail-closed, HTTP 503),
 *    impedindo a reativação acidental de métodos de pagamento desativados pelo administrador.
 */
export function inspectPersistedPaymentSettings(
  filePath: string = DEFAULT_PAYMENT_SETTINGS_PATH,
  env?: NodeJS.ProcessEnv
): PaymentSettingsInspectionResult {
  const defaults = getDefaultPaymentSettings(env);

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return {
        ok: false,
        source: 'corrupted_or_unreadable',
        settings: null,
        statusCode: 503,
        error: 'Caminho de configurações de pagamento inválido no servidor (diretório encontrado no lugar do arquivo).',
        code: 'PAYMENT_SETTINGS_CORRUPTED',
      };
    }
  } catch (statErr: any) {
    if (statErr && statErr.code === 'ENOENT') {
      return {
        ok: true,
        source: 'default_missing_file',
        settings: defaults,
        statusCode: 200,
      };
    }
    console.error('[PaymentSettings] Erro de acesso ao verificar arquivo de configurações de pagamento:', statErr);
    return {
      ok: false,
      source: 'corrupted_or_unreadable',
      settings: null,
      statusCode: 503,
      error: 'Configurações de pagamento inacessíveis no servidor devido a falha de permissão ou leitura.',
      code: 'PAYMENT_SETTINGS_UNREADABLE',
    };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const validation = validatePaymentSettingsPayload(parsed, {
      mpAccessToken: (env || process.env).MP_ACCESS_TOKEN,
      mpWebhookSecret: (env || process.env).MP_WEBHOOK_SECRET,
      normalizeLegacyUnimplementedMethods: true,
    });

    if (!validation.valid || !validation.sanitized) {
      console.error(
        '[PaymentSettings] Arquivo data/payment-settings.json contém configuração inválida (fail-closed ativado):',
        validation.error
      );
      return {
        ok: false,
        source: 'corrupted_or_unreadable',
        settings: null,
        statusCode: 503,
        error:
          validation.error ||
          'Arquivo de configurações de pagamento contém dados inválidos no servidor.',
        code: 'PAYMENT_SETTINGS_CORRUPTED',
      };
    }

    return {
      ok: true,
      source: 'persisted_file',
      statusCode: 200,
      settings: {
        ...validation.sanitized,
        credit_card_enabled: false,
        boleto_enabled: false,
        public_key: validation.sanitized.public_key || defaults.public_key,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
        updated_by: typeof parsed.updated_by === 'string' ? parsed.updated_by : undefined,
        updated_by_role: typeof parsed.updated_by_role === 'string' ? parsed.updated_by_role : undefined,
      },
    };
  } catch (err) {
    console.error('[PaymentSettings] Arquivo data/payment-settings.json corrompido ou ilegível (fail-closed ativado):', err);
    return {
      ok: false,
      source: 'corrupted_or_unreadable',
      settings: null,
      statusCode: 503,
      error: 'Arquivo de configurações de pagamento corrompido ou ilegível no servidor.',
      code: 'PAYMENT_SETTINGS_CORRUPTED',
    };
  }
}

/**
 * Lê a configuração persistida em disco de forma estrita (fail-closed).
 * - Se o arquivo ainda não existir (ENOENT), retorna os padrões iniciais do ambiente.
 * - Se o arquivo existir e for válido, retorna a configuração persistida.
 * - Se o arquivo existir mas estiver corrompido, ilegível ou inválido, lança erro explícito
 *   para impedir o uso de configurações padrão não autorizadas.
 */
export function readPersistedPaymentSettings(
  filePath: string = DEFAULT_PAYMENT_SETTINGS_PATH,
  env?: NodeJS.ProcessEnv
): PersistedPaymentSettings {
  const inspection = inspectPersistedPaymentSettings(filePath, env);
  if (!inspection.ok || !inspection.settings) {
    const err = new Error(
      inspection.error || 'Configurações de pagamento indisponíveis ou corrompidas no servidor.'
    );
    (err as any).code = inspection.code || 'PAYMENT_SETTINGS_CORRUPTED';
    (err as any).statusCode = inspection.statusCode || 503;
    throw err;
  }
  return inspection.settings;
}

/**
 * Grava atomicamente a configuração validada em disco (write-to-temp + renameSync).
 * Nunca grava segredos privados e remove o arquivo temporário caso a substituição falhe.
 */
export function writePersistedPaymentSettings(
  settings: PersistedPaymentSettings,
  filePath: string = DEFAULT_PAYMENT_SETTINGS_PATH
): PersistedPaymentSettings {
  const validation = validatePaymentSettingsPayload(settings);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.error || 'Configuração inválida para gravação.');
  }

  const recordToPersist: PersistedPaymentSettings = {
    environment: validation.sanitized.environment,
    public_key: validation.sanitized.public_key,
    pix_enabled: validation.sanitized.pix_enabled,
    pix_instant_enabled: validation.sanitized.pix_instant_enabled,
    credit_card_enabled: false,
    boleto_enabled: false,
    updated_at: settings.updated_at || new Date().toISOString(),
    updated_by: settings.updated_by,
    updated_by_role: settings.updated_by_role,
  };

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempFilePath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tempFilePath, JSON.stringify(recordToPersist, null, 2), 'utf-8');
    fs.renameSync(tempFilePath, filePath);
  } catch (writeErr) {
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch {}
    throw writeErr;
  }

  return recordToPersist;
}

/**
 * Constrói a resposta canônica e segura de configuração de pagamentos.
 * Distingue explicitamente a preferência salva (environment) do modo operacional efetivo do backend (effective_environment)
 * considerando MP_ACCESS_TOKEN e PX_ENVIRONMENT.
 */
export function buildCanonicalPaymentConfigResponse(
  persisted: PersistedPaymentSettings,
  env?: NodeJS.ProcessEnv
): CanonicalPaymentConfigResponse {
  const processEnv = env || process.env;
  const rawAccessToken = (processEnv.MP_ACCESS_TOKEN || '').trim();
  const configured = isServerAccessTokenConfigured(rawAccessToken);
  const isTestAccessToken = configured && rawAccessToken.startsWith('TEST-');
  const pxEnv = String(processEnv.PX_ENVIRONMENT || '').trim().toLowerCase();
  const isLockedSandboxStage = pxEnv === 'sandbox' || pxEnv === 'staging';

  const envPublicKey = (processEnv.MP_PUBLIC_KEY || processEnv.VITE_MP_PUBLIC_KEY || '').trim();
  const effectivePublicKey = persisted.public_key || envPublicKey;

  const effectiveEnvironment: PaymentEnvironment =
    configured &&
    persisted.environment === 'production' &&
    !isLockedSandboxStage &&
    !isTestAccessToken
      ? 'production'
      : 'sandbox';

  let environmentWarning: string | null = null;
  if (persisted.environment === 'production' && !configured) {
    environmentWarning =
      'Preferência administrativa definida para Produção Real, porém MP_ACCESS_TOKEN não está configurado nas variáveis de ambiente do servidor. O processamento efetivo permanece em Modo Homologação até a configuração da credencial no backend.';
  } else if (persisted.environment === 'production' && isLockedSandboxStage) {
    environmentWarning =
      'Preferência administrativa definida para Produção Real, porém PX_ENVIRONMENT no servidor está travado em modo Sandbox/Homologação. O processamento efetivo permanece em Sandbox.';
  } else if (persisted.environment === 'production' && isTestAccessToken) {
    environmentWarning =
      'Preferência administrativa definida para Produção Real, porém o MP_ACCESS_TOKEN configurado no servidor é uma credencial de teste (TEST-...). O processamento efetivo permanece em Sandbox.';
  }

  return {
    configured,
    is_connected: configured,
    environment: persisted.environment,
    effective_environment: effectiveEnvironment,
    environment_warning: environmentWarning,
    public_key: effectivePublicKey,
    pix_enabled: Boolean(persisted.pix_enabled),
    pix_instant_enabled: Boolean(persisted.pix_instant_enabled),
    credit_card_enabled: false,
    boleto_enabled: false,
    updated_at: persisted.updated_at || null,
    updated_by: persisted.updated_by || null,
  };
}

/**
 * Verifica se um método de pagamento solicitado no checkout está habilitado na configuração atual.
 */
export function isPaymentMethodAllowedByConfig(
  paymentMethod: string | undefined,
  config: Pick<PersistedPaymentSettings, 'pix_enabled' | 'credit_card_enabled' | 'boleto_enabled'>
): { allowed: boolean; error?: string } {
  const normalized = (paymentMethod || 'pix').trim().toLowerCase();

  if (normalized === 'pix') {
    if (!config.pix_enabled) {
      return {
        allowed: false,
        error: 'Operação bloqueada: O pagamento via Pix está temporariamente desabilitado nas configurações administrativas.',
      };
    }
    return { allowed: true };
  }

  if (normalized === 'credit_card') {
    if (!config.credit_card_enabled) {
      return {
        allowed: false,
        error: 'Operação bloqueada: O pagamento via Cartão de Crédito está temporariamente desabilitado nas configurações administrativas.',
      };
    }
    return { allowed: true };
  }

  if (normalized === 'boleto') {
    if (!config.boleto_enabled) {
      return {
        allowed: false,
        error: 'Operação bloqueada: O pagamento via Boleto Bancário está desabilitado nas configurações administrativas.',
      };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    error: `Método de pagamento inválido ("${normalized}"). Métodos suportados: pix, credit_card, boleto.`,
  };
}

export interface AuthoritativePaymentSettingsResolution {
  ok: boolean;
  source:
    | 'default_initial_state'
    | 'persisted_file'
    | 'supabase_audit_rehydrated'
    | 'corrupted_or_unreadable'
    | 'supabase_unavailable';
  settings: PersistedPaymentSettings | null;
  statusCode: number;
  error?: string;
  code?: string;
}

/**
 * Resolve de forma durável e fail-closed a configuração autoritativa do Mercado Pago:
 * 1. Verifica integridade do arquivo local data/payment-settings.json (se corrompido -> HTTP 503).
 * 2. Quando o armazenamento durável no Supabase (public.audit_logs) está ativo/injetado:
 *    - Consulta o último registro UPDATE_PAYMENT_SETTINGS (entity='payment_settings', entity_id='mercado_pago').
 *    - Se a consulta ao Supabase falhar -> HTTP 503 (PAYMENT_SETTINGS_UNAVAILABLE, fail-closed).
 *    - Se houver registro em audit_logs, valida new_config (se corrompido -> HTTP 503) e re-hidrata
 *      atomicamente o cache local caso o arquivo tenha sido removido em um novo deploy na Hostinger.
 *    - Se não houver registro em audit_logs nem arquivo corrompido -> estado inicial padrão seguro (HTTP 200).
 */
export async function resolveAuthoritativePaymentSettings(options?: {
  filePath?: string;
  supabaseClient?: any;
  env?: NodeJS.ProcessEnv;
  requireDurableSync?: boolean;
}): Promise<AuthoritativePaymentSettingsResolution> {
  const filePath = options?.filePath || DEFAULT_PAYMENT_SETTINGS_PATH;
  const env = options?.env || process.env;
  const supabaseClient = options?.supabaseClient;
  const requireDurableSync = Boolean(options?.requireDurableSync);

  const localInspection = inspectPersistedPaymentSettings(filePath, env);
  if (!localInspection.ok || !localInspection.settings) {
    return {
      ok: false,
      source: 'corrupted_or_unreadable',
      settings: null,
      statusCode: localInspection.statusCode || 503,
      error:
        localInspection.error ||
        'Configurações de pagamento indisponíveis ou corrompidas no servidor.',
      code: localInspection.code || 'PAYMENT_SETTINGS_CORRUPTED',
    };
  }

  if (supabaseClient || requireDurableSync) {
    if (!supabaseClient) {
      return {
        ok: false,
        source: 'supabase_unavailable',
        settings: null,
        statusCode: 503,
        error:
          'Armazenamento durável de configurações de pagamento indisponível no servidor (fail-closed ativado).',
        code: 'PAYMENT_SETTINGS_UNAVAILABLE',
      };
    }

    let rows: any[] | null = null;
    try {
      const queryBuilder = supabaseClient
        .from('audit_logs')
        .select('id, actor_id, action, entity, entity_id, details, created_at')
        .eq('action', 'UPDATE_PAYMENT_SETTINGS')
        .eq('entity', 'payment_settings')
        .eq('entity_id', 'mercado_pago');

      const queryResponse =
        typeof queryBuilder.order === 'function'
          ? await queryBuilder.order('created_at', { ascending: false }).limit(1)
          : await queryBuilder;

      if (queryResponse?.error) {
        console.error(
          '[PaymentSettings] Erro ao consultar configuração durável em public.audit_logs (fail-closed ativado):',
          queryResponse.error
        );
        return {
          ok: false,
          source: 'supabase_unavailable',
          settings: null,
          statusCode: 503,
          error:
            'Não foi possível verificar as configurações duráveis de pagamento no banco de dados (fail-closed ativado).',
          code: 'PAYMENT_SETTINGS_UNAVAILABLE',
        };
      }

      rows = Array.isArray(queryResponse?.data)
        ? queryResponse.data
        : queryResponse?.data
        ? [queryResponse.data]
        : [];
    } catch (dbErr) {
      console.error(
        '[PaymentSettings] Exceção ao consultar configuração durável em public.audit_logs (fail-closed ativado):',
        dbErr
      );
      return {
        ok: false,
        source: 'supabase_unavailable',
        settings: null,
        statusCode: 503,
        error:
          'Serviço de banco de dados temporariamente inacessível para validar as configurações de pagamento (fail-closed ativado).',
        code: 'PAYMENT_SETTINGS_UNAVAILABLE',
      };
    }

    if (rows && rows.length > 0) {
      const latestRecord = rows[0];
      const rawNewConfig = latestRecord?.details?.new_config;
      const validation = validatePaymentSettingsPayload(rawNewConfig, {
        mpAccessToken: env.MP_ACCESS_TOKEN,
        mpWebhookSecret: env.MP_WEBHOOK_SECRET,
        normalizeLegacyUnimplementedMethods: true,
      });

      if (!validation.valid || !validation.sanitized) {
        console.error(
          '[PaymentSettings] Registro durável em public.audit_logs contém configuração inválida (fail-closed ativado):',
          validation.error
        );
        return {
          ok: false,
          source: 'corrupted_or_unreadable',
          settings: null,
          statusCode: 503,
          error:
            validation.error ||
            'Registro durável de configurações de pagamento em public.audit_logs está inválido ou corrompido.',
          code: 'PAYMENT_SETTINGS_CORRUPTED',
        };
      }

      const defaults = getDefaultPaymentSettings(env);
      const durableUpdatedAt =
        (typeof latestRecord?.details?.updated_at === 'string' && latestRecord.details.updated_at) ||
        (typeof latestRecord?.created_at === 'string' && latestRecord.created_at) ||
        undefined;
      const durableUpdatedBy =
        (typeof latestRecord?.actor_id === 'string' && latestRecord.actor_id) || undefined;
      const durableUpdatedByRole =
        (typeof latestRecord?.details?.actor_role === 'string' && latestRecord.details.actor_role) ||
        undefined;

      const durableSettings: PersistedPaymentSettings = {
        ...validation.sanitized,
        credit_card_enabled: false,
        boleto_enabled: false,
        public_key: validation.sanitized.public_key || defaults.public_key,
        updated_at: durableUpdatedAt,
        updated_by: durableUpdatedBy,
        updated_by_role: durableUpdatedByRole,
      };

      const needsCacheSync =
        localInspection.source === 'default_missing_file' ||
        localInspection.settings.environment !== durableSettings.environment ||
        localInspection.settings.public_key !== durableSettings.public_key ||
        localInspection.settings.pix_enabled !== durableSettings.pix_enabled ||
        localInspection.settings.pix_instant_enabled !== durableSettings.pix_instant_enabled ||
        localInspection.settings.credit_card_enabled !== durableSettings.credit_card_enabled ||
        localInspection.settings.boleto_enabled !== durableSettings.boleto_enabled;

      if (needsCacheSync) {
        try {
          writePersistedPaymentSettings(
            {
              ...validation.sanitized,
              updated_at: durableUpdatedAt,
              updated_by: durableUpdatedBy,
              updated_by_role: durableUpdatedByRole,
            },
            filePath
          );
        } catch (syncErr) {
          console.warn(
            '[PaymentSettings] Aviso ao sincronizar cache local data/payment-settings.json a partir de audit_logs:',
            syncErr
          );
        }
      }

      return {
        ok: true,
        source:
          localInspection.source === 'default_missing_file'
            ? 'supabase_audit_rehydrated'
            : 'persisted_file',
        settings: durableSettings,
        statusCode: 200,
      };
    }

    if (localInspection.source === 'persisted_file') {
      return {
        ok: true,
        source: 'persisted_file',
        settings: localInspection.settings,
        statusCode: 200,
      };
    }

    return {
      ok: true,
      source: 'default_initial_state',
      settings: localInspection.settings,
      statusCode: 200,
    };
  }

  return {
    ok: true,
    source:
      localInspection.source === 'default_missing_file'
        ? 'default_initial_state'
        : 'persisted_file',
    settings: localInspection.settings,
    statusCode: 200,
  };
}

/**
 * Avalia de forma autoritativa e fail-closed se um pedido pode prosseguir no checkout (/api/orders/create).
 */
export async function evaluateCheckoutPaymentMethodGate(params: {
  paymentMethod?: string;
  filePath?: string;
  supabaseClient?: any;
  env?: NodeJS.ProcessEnv;
  requireDurableSync?: boolean;
}): Promise<{
  allowed: boolean;
  statusCode: number;
  error?: string;
  code?: string;
  settings?: PersistedPaymentSettings;
  source?: AuthoritativePaymentSettingsResolution['source'];
}> {
  const resolution = await resolveAuthoritativePaymentSettings({
    filePath: params.filePath,
    supabaseClient: params.supabaseClient,
    env: params.env,
    requireDurableSync: params.requireDurableSync,
  });

  if (!resolution.ok || !resolution.settings) {
    return {
      allowed: false,
      statusCode: resolution.statusCode || 503,
      error:
        'Serviço de checkout temporariamente indisponível: não foi possível verificar as configurações de pagamento com segurança. Nenhuma cobrança foi efetuada.',
      code: resolution.code || 'PAYMENT_SETTINGS_CORRUPTED',
      source: resolution.source,
    };
  }

  const allowance = isPaymentMethodAllowedByConfig(params.paymentMethod, resolution.settings);
  if (!allowance.allowed) {
    return {
      allowed: false,
      statusCode: 400,
      error: allowance.error,
      code: 'PAYMENT_METHOD_DISABLED',
      settings: resolution.settings,
      source: resolution.source,
    };
  }

  return {
    allowed: true,
    statusCode: 200,
    settings: resolution.settings,
    source: resolution.source,
  };
}

/**
 * Executa a atualização administrativa autenticada e autorizada (ADMIN / SUPER_ADMIN) das configurações
 * não sensíveis do Mercado Pago, com persistência atômica e registro obrigatório em public.audit_logs.
 */
export async function executeAuthenticatedPaymentSettingsUpdate(params: {
  authHeader?: string;
  payload: unknown;
  supabaseClient: any;
  filePath?: string;
  env?: NodeJS.ProcessEnv;
  rollbackOverride?: (
    filePath: string,
    hadExistingFile: boolean,
    previousRawBytes: string | null
  ) => void;
}): Promise<{ statusCode: number; payload: Record<string, any> }> {
  const {
    authHeader,
    payload,
    supabaseClient,
    filePath = DEFAULT_PAYMENT_SETTINGS_PATH,
    env,
    rollbackOverride,
  } = params;

  // 1. Verificar cabeçalho Bearer token
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      payload: {
        success: false,
        error: 'Token de autenticação não fornecido ou inválido.',
        code: 'UNAUTHORIZED',
      },
    };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return {
      statusCode: 401,
      payload: {
        success: false,
        error: 'Token de autenticação vazio.',
        code: 'UNAUTHORIZED',
      },
    };
  }

  // 2. Validar sessão no Supabase Auth e consultar papel real em public.profiles
  let authenticatedUserId: string;
  let verifiedRole: string;

  try {
    const { data: authData, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !authData?.user?.id) {
      return {
        statusCode: 401,
        payload: {
          success: false,
          error: 'Sessão inválida ou expirada no Supabase Auth.',
          code: 'UNAUTHORIZED',
        },
      };
    }

    authenticatedUserId = authData.user.id;

    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('id, role')
      .eq('id', authenticatedUserId)
      .maybeSingle();

    if (profileError) {
      return {
        statusCode: 503,
        payload: {
          success: false,
          error: 'Falha ao verificar permissões do administrador em public.profiles.',
          code: 'PROFILE_LOOKUP_FAILED',
        },
      };
    }

    verifiedRole = profile?.role || 'USER';
  } catch {
    return {
      statusCode: 500,
      payload: {
        success: false,
        error: 'Falha na verificação de identidade no servidor.',
        code: 'AUTH_CHECK_ERROR',
      },
    };
  }

  // 3. Enforce RBAC: Somente ADMIN e SUPER_ADMIN podem alterar configurações de pagamento
  if (!ALLOWED_PAYMENT_ADMIN_ROLES.includes(verifiedRole as any)) {
    return {
      statusCode: 403,
      payload: {
        success: false,
        error: `Acesso negado: Seu papel (${verifiedRole}) não possui permissão para alterar configurações de pagamento.`,
        code: 'FORBIDDEN_ROLE',
        requiredRoles: [...ALLOWED_PAYMENT_ADMIN_ROLES],
      },
    };
  }

  // 4. Validar payload e rejeitar qualquer segredo privado
  const validation = validatePaymentSettingsPayload(payload, {
    mpAccessToken: (env || process.env).MP_ACCESS_TOKEN,
    mpWebhookSecret: (env || process.env).MP_WEBHOOK_SECRET,
  });

  if (!validation.valid || !validation.sanitized) {
    return {
      statusCode: validation.statusCode,
      payload: {
        success: false,
        error: validation.error || 'Dados de configuração inválidos.',
        code: validation.code || 'VALIDATION_ERROR',
      },
    };
  }

  // 5. Capturar snapshot anterior para eventual reversão, persistir atomicamente e exigir audit_logs
  let hadExistingFile = false;
  let previousRawBytes: string | null = null;
  const previousInspection = inspectPersistedPaymentSettings(filePath, env);

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      hadExistingFile = true;
      previousRawBytes = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (snapshotErr) {
    console.error('[PaymentSettings] Falha ao capturar estado anterior do arquivo antes da atualização:', snapshotErr);
    return {
      statusCode: 500,
      payload: {
        success: false,
        error: 'Não foi possível preparar a atualização segura do arquivo de configurações.',
        code: 'SNAPSHOT_READ_FAILED',
      },
    };
  }

  let savedSettings: PersistedPaymentSettings;
  const nowIso = new Date().toISOString();

  try {
    savedSettings = writePersistedPaymentSettings(
      {
        ...validation.sanitized,
        updated_at: nowIso,
        updated_by: authenticatedUserId,
        updated_by_role: verifiedRole,
      },
      filePath
    );
  } catch (err: any) {
    console.error('[PaymentSettings] Erro ao persistir configurações de pagamento:', err);
    return {
      statusCode: 500,
      payload: {
        success: false,
        error: 'Falha ao persistir as configurações de pagamento no servidor. Nenhuma alteração foi confirmada.',
        code: 'PERSISTENCE_FAILED',
      },
    };
  }

  // 6. Registrar trilha de auditoria obrigatória em public.audit_logs e verificar explicitamente { error }
  let auditFailureMessage: string | null = null;
  try {
    const auditResponse = await supabaseClient.from('audit_logs').insert({
      actor_id: authenticatedUserId,
      action: 'UPDATE_PAYMENT_SETTINGS',
      entity: 'payment_settings',
      entity_id: 'mercado_pago',
      details: {
        previous_config:
          previousInspection.ok && previousInspection.settings
            ? {
                environment: previousInspection.settings.environment,
                public_key: previousInspection.settings.public_key,
                pix_enabled: previousInspection.settings.pix_enabled,
                pix_instant_enabled: previousInspection.settings.pix_instant_enabled,
                credit_card_enabled: previousInspection.settings.credit_card_enabled,
                boleto_enabled: previousInspection.settings.boleto_enabled,
              }
            : null,
        previous_state_source: previousInspection.source,
        new_config: {
          environment: savedSettings.environment,
          public_key: savedSettings.public_key,
          pix_enabled: savedSettings.pix_enabled,
          pix_instant_enabled: savedSettings.pix_instant_enabled,
          credit_card_enabled: savedSettings.credit_card_enabled,
          boleto_enabled: savedSettings.boleto_enabled,
        },
        actor_role: verifiedRole,
        updated_at: nowIso,
      },
    });

    if (auditResponse && auditResponse.error) {
      auditFailureMessage =
        auditResponse.error.message || 'Erro retornado pelo banco ao registrar audit_logs.';
    }
  } catch (auditErr: any) {
    auditFailureMessage = auditErr?.message || 'Exceção ao gravar trilha de auditoria em public.audit_logs.';
  }

  if (auditFailureMessage !== null) {
    console.error(
      '[PaymentSettings] Falha ao gravar auditoria obrigatória em public.audit_logs; iniciando reversão do arquivo:',
      auditFailureMessage
    );

    let rollbackSucceeded = false;
    try {
      if (typeof rollbackOverride === 'function') {
        rollbackOverride(filePath, hadExistingFile, previousRawBytes);
      } else if (hadExistingFile && previousRawBytes !== null) {
        const rollbackTemp = `${filePath}.rollback.${process.pid}.${Date.now()}`;
        try {
          fs.writeFileSync(rollbackTemp, previousRawBytes, 'utf-8');
          fs.renameSync(rollbackTemp, filePath);
        } catch (rbWriteErr) {
          try {
            if (fs.existsSync(rollbackTemp)) fs.unlinkSync(rollbackTemp);
          } catch {}
          throw rbWriteErr;
        }
      } else if (!hadExistingFile && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      rollbackSucceeded = true;
    } catch (rollbackErr) {
      console.error(
        '[PaymentSettings] ALERTA CRÍTICO: Falha ao reverter arquivo data/payment-settings.json após falha em audit_logs:',
        rollbackErr
      );
    }

    if (!rollbackSucceeded) {
      return {
        statusCode: 500,
        payload: {
          success: false,
          rolledBack: false,
          error:
            'Falha crítica: não foi possível registrar a trilha de auditoria em audit_logs e a reversão automática do arquivo de configuração também falhou.',
          code: 'AUDIT_LOG_AND_ROLLBACK_FAILED',
        },
      };
    }

    return {
      statusCode: 503,
      payload: {
        success: false,
        rolledBack: true,
        error:
          'Não foi possível registrar a trilha de auditoria obrigatória no banco de dados. A alteração de configuração foi revertida.',
        code: 'AUDIT_LOG_FAILED',
      },
    };
  }

  const canonicalConfig = buildCanonicalPaymentConfigResponse(savedSettings, env);

  return {
    statusCode: 200,
    payload: {
      success: true,
      message: 'Configurações de pagamento salvas com sucesso no servidor.',
      config: canonicalConfig,
    },
  };
}

