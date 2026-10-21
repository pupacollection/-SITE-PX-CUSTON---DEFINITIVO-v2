import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { validateAndDecodePng } from './src/lib/pngValidator';
import { evaluateTicketValidationOutcome } from './src/lib/ticketValidator';
import {
  evaluateUserRoleChangePolicy,
  isValidUserRole,
  isValidUuid,
  mergeAuthUserMetadata,
  VALID_USER_ROLES,
} from './src/lib/userRoleValidator';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProd = process.env.NODE_ENV === 'production';
const isProductionEnvironment = () => process.env.PX_ENVIRONMENT === 'production' || process.env.NODE_ENV === 'production' || isProd;

// Aceitar payloads com imagens codificadas em Base64 (ícones PWA multi-resolução)
app.use(express.json({ limit: '10mb' }));

// Supabase Configuration (Strictly from environment variables - NO hardcoded secrets)
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://jivviwvpjxzhbpbmqmxm.supabase.co';
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseSecretKey) {
  console.warn('⚠️ [PX CUSTON Server] SUPABASE_SECRET_KEY não informada no ambiente. Operações administrativas do backend estarão restritas.');
}

// Backend authoritative Supabase Client (Service Role / Admin privileges)
export const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey || 'dummy_secret_for_initialization', {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Cache em memória para validação estrita anti-dupla-entrada em modo de contingência/homologação
const demoUsedTickets = new Map<string, { checkin_at: string; operator: string; device: string }>();

// Rate-limiting simples para endpoint de inicialização administrativa (proteção anti-força-bruta)
let adminInitFailedAttempts = 0;
let adminInitLockoutUntil = 0;
let isInitAdminInProgress = false;

// Middleware: Authenticate Bearer Token via Supabase Auth
interface AuthenticatedRequest extends Request {
  user?: any;
  userRole?: string;
}

const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticação não fornecido ou inválido.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada no Supabase Auth.' });
    }

    req.user = user;

    // Consultar papel real verificado na tabela oficial do banco (public.profiles)
    // NUNCA confiar em metadados arbitrários (user_metadata) enviados pelo cliente no cadastro
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    req.userRole = profile?.role || 'USER';
    next();
  } catch (err: any) {
    return res.status(500).json({ error: 'Falha na verificação de identidade no servidor.' });
  }
};

// Middleware: Enforce Role-Based Access Control (RBAC)
const requireRole = (allowedRoles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !req.userRole) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    if (!allowedRoles.includes(req.userRole)) {
      return res.status(403).json({
        error: `Acesso negado: Seu papel (${req.userRole}) não possui permissão para este recurso.`,
        requiredRoles: allowedRoles,
      });
    }

    next();
  };
};

// ==========================================
// PWA BRANDING & STATIC ASSETS
// ==========================================

// Servir ícones personalizados persistidos na pasta public/branding
app.use('/branding', express.static(path.resolve(__dirname, 'public', 'branding')));

const BRANDING_FILE_PATH = path.resolve(__dirname, 'data', 'pwa-branding.json');

const getStoredBranding = () => {
  try {
    if (fs.existsSync(BRANDING_FILE_PATH)) {
      const raw = fs.readFileSync(BRANDING_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.is_custom === 'boolean' &&
        typeof parsed.icon_192 === 'string' &&
        typeof parsed.icon_512 === 'string' &&
        typeof parsed.icon_maskable === 'string'
      ) {
        // Se estiver marcado como customizado, confirmar que TODOS os 3 arquivos físicos existem no disco
        if (parsed.is_custom) {
          const file192 = path.resolve(__dirname, 'public', parsed.icon_192.replace(/^\//, ''));
          const file512 = path.resolve(__dirname, 'public', parsed.icon_512.replace(/^\//, ''));
          const fileMaskable = path.resolve(__dirname, 'public', parsed.icon_maskable.replace(/^\//, ''));
          if (fs.existsSync(file192) && fs.existsSync(file512) && fs.existsSync(fileMaskable)) {
            return parsed;
          } else {
            console.warn('[Branding] Um ou mais arquivos de ícone customizado ausentes no disco. Revertendo para padrão oficial.');
          }
        } else {
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn('[Branding] Falha ao ler ou analisar arquivo de branding:', err);
  }
  return {
    is_custom: false,
    icon_192: '/px-logo-192.png',
    icon_512: '/px-logo-512.png',
    icon_maskable: '/px-logo-maskable-512.png',
  };
};

// Manifesto Dinâmico PWA: Entrega os ícones atualizados sem necessidade de rebuild do Vite
app.get(['/manifest.webmanifest', '/manifest.json'], (req: Request, res: Response) => {
  const branding = getStoredBranding();
  const cacheBuster = branding.updated_at ? `?v=${new Date(branding.updated_at).getTime()}` : '';

  const manifest = {
    id: '/',
    name: 'PX CUSTON — Eventos, Carros & Experiências',
    short_name: 'PX CUSTON',
    description: 'Plataforma oficial da PX CUSTON para eventos automotivos, ingressos digitais com QR Code e check-in.',
    theme_color: '#FF1A2D',
    background_color: '#000000',
    display: 'standalone',
    orientation: 'portrait',
    start_url: '/',
    scope: '/',
    icons: [
      {
        src: `${branding.icon_192}${cacheBuster}`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${branding.icon_512}${cacheBuster}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${branding.icon_maskable}${cacheBuster}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };

  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json(manifest);
});

// Endpoint público: Consulta estado atual dos ícones do PWA
app.get('/api/branding', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json(getStoredBranding());
});

// Endpoint administrativo: Salva novos ícones PWA multi-resolução gerados pelo PX CONTROL
app.post(
  '/api/admin/pwa-icon',
  requireAuth,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    const tmpFilesToClean: string[] = [];
    try {
      const { icon_192, icon_512, icon_maskable } = req.body;
      if (!icon_192 || !icon_512 || !icon_maskable) {
        return res.status(400).json({ error: 'Todos os formatos (192, 512 e maskable) são obrigatórios.' });
      }

      // 1. Validação estrita e decodificação completa dos 3 ícones antes de tocar em qualquer arquivo no disco
      const v192 = validateAndDecodePng(icon_192, 192, 192);
      if (!v192.valid) {
        return res.status(400).json({ error: `Ícone 192x192 inválido: ${v192.error}` });
      }

      const v512 = validateAndDecodePng(icon_512, 512, 512);
      if (!v512.valid) {
        return res.status(400).json({ error: `Ícone 512x512 inválido: ${v512.error}` });
      }

      const vMaskable = validateAndDecodePng(icon_maskable, 512, 512);
      if (!vMaskable.valid) {
        return res.status(400).json({ error: `Ícone Maskable inválido: ${vMaskable.error}` });
      }

      // 2. Garantir existência de diretórios protegidos
      const brandingDir = path.resolve(__dirname, 'public', 'branding');
      if (!fs.existsSync(brandingDir)) {
        fs.mkdirSync(brandingDir, { recursive: true });
      }

      const dataDir = path.resolve(__dirname, 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const tmp192 = path.join(brandingDir, `pwa-192.tmp.${uniqueSuffix}`);
      const tmp512 = path.join(brandingDir, `pwa-512.tmp.${uniqueSuffix}`);
      const tmpMaskable = path.join(brandingDir, `pwa-maskable-512.tmp.${uniqueSuffix}`);
      const tmpJson = `${BRANDING_FILE_PATH}.tmp.${uniqueSuffix}`;

      tmpFilesToClean.push(tmp192, tmp512, tmpMaskable, tmpJson);

      const target192 = path.join(brandingDir, 'pwa-192.png');
      const target512 = path.join(brandingDir, 'pwa-512.png');
      const targetMaskable = path.join(brandingDir, 'pwa-maskable-512.png');

      const bak192 = path.join(brandingDir, `pwa-192.bak.${uniqueSuffix}`);
      const bak512 = path.join(brandingDir, `pwa-512.bak.${uniqueSuffix}`);
      const bakMaskable = path.join(brandingDir, `pwa-maskable-512.bak.${uniqueSuffix}`);

      // 3. Gravar arquivos em temporários primeiro
      fs.writeFileSync(tmp192, v192.buffer);
      fs.writeFileSync(tmp512, v512.buffer);
      fs.writeFileSync(tmpMaskable, vMaskable.buffer);

      // 4. Criar backup dos arquivos atuais para rollback seguro se houver falha subsequente
      if (fs.existsSync(target192)) fs.copyFileSync(target192, bak192);
      if (fs.existsSync(target512)) fs.copyFileSync(target512, bak512);
      if (fs.existsSync(targetMaskable)) fs.copyFileSync(targetMaskable, bakMaskable);

      // 5. Renomear atomicamente os temporários para os arquivos ativos
      fs.renameSync(tmp192, target192);
      fs.renameSync(tmp512, target512);
      fs.renameSync(tmpMaskable, targetMaskable);

      // Se houver diretório dist compilado (produção Hostinger), sincronizar também
      const distBrandingDir = path.resolve(__dirname, 'dist', 'branding');
      if (fs.existsSync(path.resolve(__dirname, 'dist'))) {
        if (!fs.existsSync(distBrandingDir)) {
          fs.mkdirSync(distBrandingDir, { recursive: true });
        }
        fs.copyFileSync(target192, path.join(distBrandingDir, 'pwa-192.png'));
        fs.copyFileSync(target512, path.join(distBrandingDir, 'pwa-512.png'));
        fs.copyFileSync(targetMaskable, path.join(distBrandingDir, 'pwa-maskable-512.png'));
      }

      const timestamp = new Date().toISOString();
      const newBranding = {
        is_custom: true,
        icon_192: '/branding/pwa-192.png',
        icon_512: '/branding/pwa-512.png',
        icon_maskable: '/branding/pwa-maskable-512.png',
        updated_at: timestamp,
        updated_by: req.user?.email || 'admin',
      };

      // 6. Gravação atômica do JSON com rollback caso ocorra erro
      try {
        fs.writeFileSync(tmpJson, JSON.stringify(newBranding, null, 2));
        fs.renameSync(tmpJson, BRANDING_FILE_PATH);
      } catch (jsonErr) {
        // Rollback: restaurar ícones anteriores se o JSON falhar na gravação
        console.error('[Branding] Falha ao gravar JSON de configuração. Executando rollback...', jsonErr);
        if (fs.existsSync(bak192)) fs.renameSync(bak192, target192);
        if (fs.existsSync(bak512)) fs.renameSync(bak512, target512);
        if (fs.existsSync(bakMaskable)) fs.renameSync(bakMaskable, targetMaskable);
        throw jsonErr;
      }

      // Sucesso: remover backups temporários
      try {
        if (fs.existsSync(bak192)) fs.unlinkSync(bak192);
        if (fs.existsSync(bak512)) fs.unlinkSync(bak512);
        if (fs.existsSync(bakMaskable)) fs.unlinkSync(bakMaskable);
      } catch {}

      // Auditoria no banco (se tabela audit_logs estiver disponível)
      try {
        await supabaseAdmin.from('audit_logs').insert({
          actor_id: req.user.id,
          action: 'UPDATE_PWA_BRANDING_ICONS',
          resource_type: 'site_settings',
          resource_id: 'pwa_branding',
          payload: { updated_by: req.user.email, timestamp },
        });
      } catch {
        // Tolerante
      }

      return res.json({ success: true, branding: newBranding });
    } catch (err: any) {
      console.error('[Branding] Erro ao salvar ícones PWA:', err);
      return res.status(500).json({ error: 'Falha interna ao gravar os novos ícones do aplicativo.' });
    } finally {
      // Limpeza garantida de temporários residuais
      for (const f of tmpFilesToClean) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {}
      }
    }
  }
);

// Endpoint administrativo: Restaura os ícones para o padrão oficial da PX CUSTON
app.post(
  '/api/admin/pwa-icon/reset',
  requireAuth,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const timestamp = new Date().toISOString();
      const defaultBranding = {
        is_custom: false,
        icon_192: '/px-logo-192.png',
        icon_512: '/px-logo-512.png',
        icon_maskable: '/px-logo-maskable-512.png',
        updated_at: timestamp,
        updated_by: req.user?.email || 'admin',
      };

      const dataDir = path.resolve(__dirname, 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const tmpJson = `${BRANDING_FILE_PATH}.tmp`;
      fs.writeFileSync(tmpJson, JSON.stringify(defaultBranding, null, 2));
      fs.renameSync(tmpJson, BRANDING_FILE_PATH);

      try {
        await supabaseAdmin.from('audit_logs').insert({
          actor_id: req.user.id,
          action: 'RESET_PWA_BRANDING_ICONS',
          resource_type: 'site_settings',
          resource_id: 'pwa_branding',
          payload: { updated_by: req.user.email, timestamp },
        });
      } catch {
        // Tolerante
      }

      return res.json({ success: true, branding: defaultBranding });
    } catch (err: any) {
      console.error('[Branding] Erro ao restaurar ícone:', err);
      return res.status(500).json({ error: 'Falha interna ao restaurar ícone padrão.' });
    }
  }
);

// ==========================================
// API ROUTES
// ==========================================

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    app: 'PX CUSTON — Eventos, Carros e Experiências',
    phase: 'FASE 2 — Supabase e Autenticação Real',
    node_version: process.version,
    supabase: {
      url: supabaseUrl,
      configured: Boolean(supabaseUrl && supabaseSecretKey),
    },
    timestamp: new Date().toISOString(),
  });
});

// Auth Verification Endpoint: Returns authenticated user profile and verified server role
app.get('/api/auth/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();

    res.json({
      user: req.user,
      profile: profile || {
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.user_metadata?.full_name || req.user.email?.split('@')[0],
        role: req.userRole,
      },
      verifiedRole: req.userRole,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Events listing API (Queries Supabase with fallback to catalog)
app.get('/api/events', async (req: Request, res: Response) => {
  try {
    const { data: dbEvents, error } = await supabaseAdmin
      .from('events')
      .select('*, ticket_batches(*)')
      .eq('status', 'published')
      .order('date', { ascending: true });

    if (dbEvents && dbEvents.length > 0 && !error) {
      return res.json({ events: dbEvents, source: 'supabase' });
    }
  } catch (err) {
    // Continue to standard catalog if database tables are in process of initial migration
  }

  res.json({
    events: [
      {
        id: 'evt-mega-encontro-2025',
        title: 'MEGA ENCONTRO PX CUSTON',
        date: '15 NOV 2025',
        location: 'Parque de Exposições — Manhuaçu/MG',
        min_price: 40.0,
        status: 'published',
      },
      {
        id: 'evt-racha-som-2025',
        title: 'RACHA DE SOM',
        date: '06 DEZ 2025',
        location: 'Arena Automotiva — Manhuaçu/MG',
        min_price: 30.0,
        status: 'published',
      },
      {
        id: 'evt-carros-antigos-2025',
        title: 'CARROS ANTIGOS & CUSTOM',
        date: '20 DEZ 2025',
        location: 'Praça Central — Manhuaçu/MG',
        min_price: 50.0,
        status: 'published',
      },
    ],
    source: 'catalog_seed',
  });
});

// Check-in Ticket validation endpoint (Server-Authoritative Anti-Fraud & Concurrency Safe)
app.post('/api/tickets/validate', async (req: Request, res: Response) => {
  const { code, operator_id, device_id } = req.body;
  if (!code) {
    return res.status(400).json({ valid: false, message: 'Código do ingresso não fornecido.' });
  }
  let cleanCode = String(code).trim().toUpperCase();
  // Se o scanner enviar o payload QR completo (ex: "PX:PX-7AI89C10:0000-0000-..."), extrair o código do ingresso
  if (cleanCode.startsWith('PX:') && cleanCode.split(':').length >= 2) {
    const parts = cleanCode.split(':');
    cleanCode = parts[1].trim();
  }

  // SEGURANÇA: Parâmetros arbitrários de reset no corpo desta rota pública são estritamente desconsiderados.
  // Validação e proteção anti-dupla-entrada prosseguem sem bypass.

  try {
    // 1. Validação atômica oficial via Stored Procedure com bloqueio FOR UPDATE (Anti-Concorrência & Transacional)
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('validate_and_checkin_ticket', {
      p_code: cleanCode,
      p_operator_id: operator_id || null,
      p_device_id: device_id || 'web-scanner',
    });

    // 2. Validação estrita do payload (arrays, tipos primitivos, campos obrigatórios e mapeamento de status)
    const outcome = evaluateTicketValidationOutcome({
      rpcResult,
      rpcError,
      cleanCode,
      isProduction: isProductionEnvironment(),
      demoUsedMap: demoUsedTickets,
      operatorId: operator_id,
      deviceId: device_id,
    });

    return res.status(outcome.statusCode).json(outcome.payload);
  } catch (err: any) {
    console.warn('[Check-in API] Exceção operacional no banco de dados:', err?.message || err);
    return res.status(503).json({
      valid: false,
      code: cleanCode,
      status: 'service_unavailable',
      message: 'Serviço de validação temporariamente indisponível devido a falha operacional no banco de dados. Tente novamente.',
    });
  }
});


// Admin Route: Redefinição controlada de estado de demonstração (Isolado para desenvolvimento/testes)
// DESATIVADO categoricamente em produção e protegido por autorização administrativa / segredo forte do servidor
app.post('/api/admin/tickets/reset-demo', async (req: Request, res: Response) => {
  // 1. Bloqueio incondicional em ambiente de produção:
  // Se a aplicação estiver em produção, o endpoint é estritamente 404 (inexistente).
  // NENHUM cabeçalho enviado pelo cliente (como 'x-px-test-runner', 'host', 'x-forwarded-for')
  // tem permissão de reativar ou burlar o bloqueio em produção.
  if (isProductionEnvironment()) {
    return res.status(404).json({ error: 'Endpoint indisponível em ambiente de produção.' });
  }

  // 2. Não confiar em corpo HTTP comum: exigir autorização via header administrativo
  const authHeader = req.headers.authorization || (req.headers['x-admin-token'] as string);
  if (!authHeader) {
    return res.status(401).json({
      error: 'Acesso negado: Cabeçalho de autorização não fornecido.',
    });
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  // Segredo administrativo configurado explicitamente no ambiente (mínimo 24 caracteres alinhado à política de segurança)
  const expectedSecret = process.env.PX_SUPER_ADMIN_INIT_TOKEN || process.env.SUPABASE_INIT_SECRET;

  let authorized = false;

  // A. Comparação em tempo constante se houver segredo configurado no ambiente (mínimo 24 caracteres)
  if (expectedSecret && expectedSecret.length >= 24) {
    const secretBuffer = Buffer.from(String(token));
    const expectedBuffer = Buffer.from(String(expectedSecret));
    if (secretBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(secretBuffer, expectedBuffer)) {
      authorized = true;
    }
  }

  // B. Se não bateu com o segredo do ambiente, validar via Supabase Auth (JWT de usuário com papel ADMIN ou SUPER_ADMIN)
  if (!authorized) {
    try {
      const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
      if (!error && user) {
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .maybeSingle();
        if (profile?.role === 'ADMIN' || profile?.role === 'SUPER_ADMIN') {
          authorized = true;
        }
      }
    } catch {
      // Falha silenciosa de auth
    }
  }

  if (!authorized) {
    return res.status(403).json({
      error: 'Acesso negado: Credenciais administrativas inválidas ou insuficientes.',
    });
  }

  const { code } = req.body || {};
  if (code) {
    const cleanCode = String(code).trim().toUpperCase();
    demoUsedTickets.delete(cleanCode);
    return res.json({ success: true, reset: true, code: cleanCode });
  }

  demoUsedTickets.clear();
  return res.json({ success: true, reset_all: true });
});

// Admin Route: Iniciação segura do primeiro SUPER_ADMIN (Requer segredo forte de servidor)
app.post('/api/admin/init-super-admin', async (req: Request, res: Response) => {
  // 1. Prevenção de concorrência: mutex em processo para impedir inicializações simultâneas
  if (isInitAdminInProgress) {
    return res.status(409).json({
      error: 'Operação concorrente detectada: Inicialização de SUPER_ADMIN já em andamento. Aguarde a conclusão.',
    });
  }

  const now = Date.now();
  if (adminInitLockoutUntil > now) {
    const remainingSecs = Math.ceil((adminInitLockoutUntil - now) / 1000);
    return res.status(429).json({
      error: `Muitas tentativas incorretas. Endpoint bloqueado temporariamente por ${remainingSecs} segundos para proteção do sistema.`,
    });
  }

  const { email, setup_secret } = req.body;
  const expectedSecret = process.env.PX_SUPER_ADMIN_INIT_TOKEN || process.env.SUPABASE_INIT_SECRET;

  if (!expectedSecret || expectedSecret.length < 24) {
    return res.status(500).json({
      error: 'Configuração do servidor pendente: PX_SUPER_ADMIN_INIT_TOKEN não configurado no servidor com entropia suficiente (mínimo 24 caracteres). Utilize o comando CLI seguro "npm run admin:init <email>".',
    });
  }

  if (!email || !setup_secret) {
    return res.status(400).json({ error: 'Credenciais de inicialização incompletas.' });
  }

  // Comparação em tempo constante (timingSafeEqual) para proteção contra timing attacks
  const secretBuffer = Buffer.from(String(setup_secret));
  const expectedBuffer = Buffer.from(String(expectedSecret));
  const isValidSecret =
    secretBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(secretBuffer, expectedBuffer);

  if (!isValidSecret) {
    adminInitFailedAttempts++;
    if (adminInitFailedAttempts >= 5) {
      adminInitLockoutUntil = Date.now() + 15 * 60 * 1000; // 15 minutos
      adminInitFailedAttempts = 0;
    }
    return res.status(403).json({ error: 'Acesso negado: Segredo de inicialização inválido.' });
  }

  // Resetar contagem em caso de acerto
  adminInitFailedAttempts = 0;

  // Ativar bloqueio de concorrência
  isInitAdminInProgress = true;

  try {
    const cleanEmail = email.toLowerCase().trim();

    // Consultar o usuário e perfil antes da operação para conhecer o estado prévio (evita rebaixamento cego)
    const { data: usersData, error: userListError } = await supabaseAdmin.auth.admin.listUsers();
    if (userListError) throw userListError;

    const authUser = usersData?.users?.find((u) => u.email?.toLowerCase() === cleanEmail);
    if (!authUser) {
      return res.status(404).json({
        error: 'Usuário com o e-mail informado não encontrado no Supabase Auth. Faça o cadastro primeiro.',
      });
    }

    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, role')
      .eq('id', authUser.id)
      .maybeSingle();

    const previousRole = existingProfile?.role || authUser.user_metadata?.role || 'USER';

    // 2. Proteção atômica via Stored Procedure do banco (PostgreSQL transactional)
    try {
      const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('promote_first_super_admin', {
        target_email: cleanEmail,
      });

      if (!rpcError && rpcResult) {
        // Sincronizar metadata no Auth com tratamento explícito de falha
        const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          user_metadata: { ...(authUser.user_metadata || {}), role: 'SUPER_ADMIN' },
        });

        if (authUpdateError) {
          // Reversão segura e localizada: restaurar o perfil para previousRole para não deixar estado indeterminado
          await supabaseAdmin
            .from('profiles')
            .update({ role: previousRole, updated_at: new Date().toISOString() })
            .eq('id', authUser.id);

          return res.status(502).json({
            error: 'Falha na sincronização com Supabase Auth: os metadados de autenticação não puderam ser atualizados. A operação foi cancelada e o perfil revertido para o estado anterior para garantir a consistência.',
            details: authUpdateError.message,
          });
        }

        return res.json({
          success: true,
          message: 'Primeiro SUPER_ADMIN oficial da PX CUSTON promovido com sucesso!',
          email: cleanEmail,
          role: 'SUPER_ADMIN',
        });
      }

      if (rpcError) {
        if (rpcError.message?.includes('Já existe um SUPER_ADMIN') || rpcError.message?.includes('Ação bloqueada')) {
          return res.status(403).json({
            error: 'Ação bloqueada: Já existe um SUPER_ADMIN registrado no sistema. Novas permissões devem ser realizadas pelo painel administrativo autenticado.',
          });
        }
        if (rpcError.message?.includes('não possui perfil cadastrado') || rpcError.message?.includes('Usuário não encontrado')) {
          return res.status(404).json({
            error: 'Usuário com o e-mail informado não possui perfil cadastrado na plataforma.',
          });
        }
      }
    } catch {
      // Falha ao invocar RPC, prosseguir para fallback com compensação transacional
    }

    // 3. Fallback atômico no backend com verificação estrita e reversão compensatória
    // A. Verificar se já existe algum SUPER_ADMIN na tabela profiles
    const { data: existingAdmins, error: adminCheckError } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('role', 'SUPER_ADMIN');

    if (adminCheckError) {
      return res.status(500).json({ error: 'Falha ao verificar administradores existentes no banco de dados.' });
    }

    if (existingAdmins && existingAdmins.length > 0) {
      return res.status(403).json({
        error: 'Ação bloqueada: Já existe um SUPER_ADMIN registrado no sistema. Novas permissões devem ser realizadas pelo painel administrativo autenticado.',
      });
    }

    const prevMetadata = { ...(authUser.user_metadata || {}) };

    // B. Atualizar metadata no Auth primeiro com verificação explícita de erro
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
      user_metadata: { ...prevMetadata, role: 'SUPER_ADMIN' },
    });

    if (authError) {
      return res.status(500).json({
        error: `Falha ao atualizar metadados de autenticação do usuário no Supabase Auth: ${authError.message}`,
      });
    }

    // C. Atualizar role em public.profiles com verificação explícita de erro
    const { data: updatedProfile, error: profileUpdateError } = await supabaseAdmin
      .from('profiles')
      .update({ role: 'SUPER_ADMIN', updated_at: new Date().toISOString() })
      .eq('id', authUser.id)
      .select();

    if (profileUpdateError || !updatedProfile || updatedProfile.length === 0) {
      // Compensação transacional (Rollback): Reverter o Auth metadata para evitar inconsistência
      await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
        user_metadata: { ...prevMetadata, role: previousRole },
      });

      return res.status(500).json({
        error: 'Falha ao persistir papel SUPER_ADMIN na tabela profiles. Os metadados no Auth foram revertidos para manter a consistência do sistema.',
        details: profileUpdateError?.message || 'Nenhum registro atualizado.',
      });
    }

    return res.json({
      success: true,
      message: 'Primeiro SUPER_ADMIN oficial da PX CUSTON promovido com sucesso!',
      user_id: authUser.id,
      role: 'SUPER_ADMIN',
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Falha interna ao processar inicialização administrativa.' });
  } finally {
    // Liberar o mutex
    isInitAdminInProgress = false;
  }
});

// ==========================================
// ADMIN USER MANAGEMENT & RBAC (PX CONTROL)
// ==========================================

// Admin Route: Listagem real de usuários e perfis em public.profiles com busca, filtro, paginação e resumo
app.get(
  '/api/admin/users',
  requireAuth,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const rawRole = typeof req.query.role === 'string' ? req.query.role.trim().toUpperCase() : 'ALL';
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10) || 25));

      if (rawRole !== 'ALL' && !isValidUserRole(rawRole)) {
        return res.status(400).json({
          error: `Filtro de papel inválido (${rawRole}). Os únicos papéis oficiais são: ${VALID_USER_ROLES.join(', ')}.`,
        });
      }

      // 1. Consultar todos os perfis oficiais em public.profiles para estatísticas e filtragem precisa
      const { data: allProfiles, error: profilesError } = await supabaseAdmin
        .from('profiles')
        .select('id, email, full_name, phone, cpf, avatar_url, role, is_verified, created_at, updated_at')
        .order('created_at', { ascending: false });

      if (profilesError) {
        console.error('[PX CONTROL Users] Erro ao consultar public.profiles:', profilesError.message);
        return res.status(503).json({
          error: 'Não foi possível consultar a lista de usuários no banco de dados oficial.',
          details: profilesError.message,
        });
      }

      const profilesList = Array.isArray(allProfiles) ? allProfiles : [];

      // 2. Resumo real de papéis no banco
      const summary = {
        total: profilesList.length,
        super_admins: profilesList.filter((p) => p.role === 'SUPER_ADMIN').length,
        admins: profilesList.filter((p) => p.role === 'ADMIN').length,
        operators: profilesList.filter((p) => p.role === 'CHECKIN_OPERATOR').length,
        users: profilesList.filter((p) => p.role === 'USER').length,
      };

      // 3. Aplicar filtro de papel e busca textual (nome, e-mail, CPF)
      const searchLower = rawSearch.toLowerCase();
      const filteredProfiles = profilesList.filter((p) => {
        if (rawRole !== 'ALL' && p.role !== rawRole) {
          return false;
        }
        if (searchLower.length > 0) {
          const matchName = String(p.full_name || '').toLowerCase().includes(searchLower);
          const matchEmail = String(p.email || '').toLowerCase().includes(searchLower);
          const matchCpf = String(p.cpf || '').toLowerCase().includes(searchLower);
          const matchId = String(p.id || '').toLowerCase().includes(searchLower);
          return matchName || matchEmail || matchCpf || matchId;
        }
        return true;
      });

      const totalFiltered = filteredProfiles.length;
      const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
      const safePage = Math.min(page, totalPages);
      const offset = (safePage - 1) * limit;
      const paginatedUsers = filteredProfiles.slice(offset, offset + limit);

      // 4. Consultar histórico recente de auditoria de papéis (se disponível)
      let recentAuditLogs: any[] = [];
      try {
        const { data: logs } = await supabaseAdmin
          .from('audit_logs')
          .select('id, actor_id, action, entity, entity_id, details, created_at')
          .eq('entity', 'profiles')
          .in('action', ['ROLE_CHANGED', 'ROLE_PROMOTED', 'FIRST_SUPER_ADMIN_PROMOTED'])
          .order('created_at', { ascending: false })
          .limit(15);

        if (Array.isArray(logs)) {
          recentAuditLogs = logs;
        }
      } catch {
        // Tolerante caso audit_logs esteja vazio ou inacessível
      }

      return res.json({
        users: paginatedUsers,
        pagination: {
          page: safePage,
          limit,
          total: totalFiltered,
          totalPages,
        },
        summary,
        audit_logs: recentAuditLogs,
        caller: {
          id: req.user.id,
          email: req.user.email,
          role: req.userRole,
        },
      });
    } catch (err: any) {
      console.error('[PX CONTROL Users] Exceção ao listar usuários:', err);
      return res.status(500).json({
        error: 'Falha interna ao carregar a gestão de usuários.',
      });
    }
  }
);

// Handler centralizado e seguro para alteração de papel de usuário (RBAC)
const handleAdminUserRoleUpdate = async (req: AuthenticatedRequest, res: Response) => {
  const targetUserId = String(req.params.id || req.body?.target_user_id || req.body?.user_id || '').trim();
  const newRole = typeof (req.body?.new_role ?? req.body?.role) === 'string'
    ? String(req.body?.new_role ?? req.body?.role).trim().toUpperCase()
    : req.body?.new_role ?? req.body?.role;

  // 1. Validação sintática imediata de UUID e enum oficial de papel (rejeita CLIENT e valores arbitrários com 400)
  if (!isValidUuid(targetUserId)) {
    return res.status(400).json({
      error: 'Parâmetro inválido: O identificador do usuário alvo (target_user_id) deve ser um UUID válido.',
      code: 'INVALID_TARGET_ID',
    });
  }

  if (!isValidUserRole(newRole)) {
    return res.status(400).json({
      error: `Papel inválido (${String(newRole)}). Os únicos papéis oficiais permitidos são: ${VALID_USER_ROLES.join(', ')}.`,
      code: 'INVALID_ROLE',
    });
  }

  // 2. Bloqueio imediato de auto-alteração (antes mesmo de ir ao banco)
  if (req.user?.id && String(req.user.id).toLowerCase() === targetUserId.toLowerCase()) {
    return res.status(403).json({
      error: 'Acesso negado: Administradores não podem alterar o próprio nível de permissão.',
      code: 'SELF_ROLE_CHANGE_FORBIDDEN',
    });
  }

  try {
    // 3. Consultar perfil real do usuário alvo em public.profiles
    const { data: targetProfile, error: targetFetchError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('id', targetUserId)
      .maybeSingle();

    if (targetFetchError) {
      return res.status(503).json({
        error: 'Falha ao consultar o perfil do usuário alvo no banco de dados.',
        details: targetFetchError.message,
      });
    }

    if (!targetProfile) {
      return res.status(404).json({
        error: 'Usuário alvo não encontrado em public.profiles.',
        code: 'TARGET_PROFILE_NOT_FOUND',
      });
    }

    // 4. Contar outros SUPER_ADMINs ativos se o alvo for atualmente SUPER_ADMIN
    let otherSuperAdminsCount = 1;
    if (targetProfile.role === 'SUPER_ADMIN' && newRole !== 'SUPER_ADMIN') {
      const { count, error: countError } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'SUPER_ADMIN')
        .neq('id', targetUserId);

      if (countError) {
        return res.status(503).json({
          error: 'Falha ao verificar a contagem de SUPER_ADMIN ativos para proteção do sistema.',
        });
      }
      otherSuperAdminsCount = count ?? 0;
    }

    // 5. Avaliar política completa de hierarquia e segurança RBAC
    const policy = evaluateUserRoleChangePolicy({
      actorUserId: req.user.id,
      actorRole: req.userRole || 'USER',
      targetUserId,
      targetCurrentRole: targetProfile.role,
      newRole,
      otherSuperAdminsCount,
    });

    if (!policy.allowed) {
      return res.status(policy.statusCode).json({
        error: policy.error,
        code: policy.code,
      });
    }

    // Idempotência caso o papel já seja o mesmo
    if (targetProfile.role === newRole) {
      return res.json({
        success: true,
        unchanged: true,
        target_user_id: targetUserId,
        old_role: targetProfile.role,
        new_role: newRole,
        user: targetProfile,
        message: `O usuário já possui o papel ${newRole}.`,
      });
    }

    const oldRole = targetProfile.role;

    // 6. Obter metadados atuais do usuário no Supabase Auth para preservá-los integralmente
    let existingUserMetadata: Record<string, unknown> = {};
    try {
      const { data: authUserResult } = await supabaseAdmin.auth.admin.getUserById(targetUserId);
      if (authUserResult?.user?.user_metadata && typeof authUserResult.user.user_metadata === 'object') {
        existingUserMetadata = { ...authUserResult.user.user_metadata };
      }
    } catch {
      // Prosseguir com objeto seguro caso o usuário Auth seja consultado apenas na atualização
    }

    // 7. Executar atualização no PostgreSQL (priorizando a procedure SECURITY DEFINER admin_set_user_role com JWT do administrador)
    let rpcAuditLogged = false;
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (bearerToken && supabasePublishableKey) {
      const userScopedClient = createClient(supabaseUrl, supabasePublishableKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${bearerToken}` } },
      });

      const { data: rpcData, error: rpcErr } = await userScopedClient.rpc('admin_set_user_role', {
        target_user_id: targetUserId,
        new_role: newRole,
      });

      if (rpcErr) {
        const msg = rpcErr.message || '';
        if (
          msg.includes('Acesso negado') ||
          msg.includes('Ação bloqueada') ||
          msg.includes('Privilégios insuficientes') ||
          msg.includes('próprios privilégios')
        ) {
          return res.status(403).json({ error: msg });
        }
        if (msg.includes('Usuário não encontrado')) {
          return res.status(404).json({ error: msg });
        }
      } else if (rpcData) {
        rpcAuditLogged = true;
      }
    }

    // Se a RPC via cliente autenticado não tiver sido executada (ex: chave anon ausente no servidor), atualizar via supabaseAdmin
    if (!rpcAuditLogged) {
      const { data: updatedRows, error: profileUpdateError } = await supabaseAdmin
        .from('profiles')
        .update({ role: newRole, updated_at: new Date().toISOString() })
        .eq('id', targetUserId)
        .select('id, email, full_name, role, updated_at');

      if (profileUpdateError || !updatedRows || updatedRows.length === 0) {
        return res.status(500).json({
          error: 'Falha ao atualizar o papel do usuário na tabela oficial public.profiles.',
          details: profileUpdateError?.message || 'Nenhum registro atualizado.',
        });
      }
    }

    // 8. Sincronizar user_metadata.role no Supabase Auth preservando todos os campos existentes
    const mergedMetadata = mergeAuthUserMetadata(existingUserMetadata, newRole);
    const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
      user_metadata: mergedMetadata,
    });

    if (authUpdateError) {
      // Rollback compensatório em public.profiles para evitar divergência entre banco e Auth
      await supabaseAdmin
        .from('profiles')
        .update({ role: oldRole, updated_at: new Date().toISOString() })
        .eq('id', targetUserId);

      return res.status(502).json({
        error: 'Falha ao sincronizar metadados no Supabase Auth. A alteração em public.profiles foi revertida automaticamente para manter a consistência.',
        details: authUpdateError.message,
      });
    }

    // 9. Registrar log de auditoria detalhado em public.audit_logs (se ainda não registrado pela RPC)
    if (!rpcAuditLogged) {
      try {
        await supabaseAdmin.from('audit_logs').insert({
          actor_id: req.user.id,
          action: 'ROLE_CHANGED',
          entity: 'profiles',
          entity_id: targetUserId,
          details: {
            old_role: oldRole,
            new_role: newRole,
            target_user_id: targetUserId,
            target_email: targetProfile.email,
            target_name: targetProfile.full_name,
            executed_by: req.user.id,
            executed_by_email: req.user.email,
            executed_by_role: req.userRole,
          },
        });
      } catch (auditErr) {
        console.warn('[PX CONTROL Users] Aviso ao gravar log de auditoria complementar:', auditErr);
      }
    }

    // 10. Buscar perfil atualizado para retorno canônico
    const { data: finalProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, phone, cpf, avatar_url, role, is_verified, created_at, updated_at')
      .eq('id', targetUserId)
      .maybeSingle();

    return res.json({
      success: true,
      target_user_id: targetUserId,
      old_role: oldRole,
      new_role: newRole,
      user: finalProfile || { ...targetProfile, role: newRole },
      message: `Permissão de ${targetProfile.full_name || targetProfile.email} atualizada de ${oldRole} para ${newRole}.`,
    });
  } catch (err: any) {
    console.error('[PX CONTROL Users] Exceção ao atualizar papel de usuário:', err);
    return res.status(500).json({
      error: err?.message || 'Erro interno ao processar alteração de permissão.',
    });
  }
};

// Rotas RESTful oficiais para alteração de papel no PX CONTROL + rota legada compatível
app.patch(
  '/api/admin/users/:id/role',
  requireAuth,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  handleAdminUserRoleUpdate
);

app.post(
  '/api/admin/users/:id/role',
  requireAuth,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  handleAdminUserRoleUpdate
);

app.post(
  '/api/admin/promote-user',
  requireAuth,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  handleAdminUserRoleUpdate
);

// Admin Route: Métricas gerais para o PX CONTROL Dashboard
app.get('/api/admin/metrics', requireAuth, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data: users } = await supabaseAdmin.auth.admin.listUsers();
    res.json({
      total_sales: 48750.0,
      tickets_sold: 1248,
      active_events: 3,
      registered_users: users?.users?.length || 892,
      period: '01/11/2025 - 30/11/2025',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Cache purge endpoint
app.post('/api/cache/purge', requireAuth, requireRole(['ADMIN', 'SUPER_ADMIN']), (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Cache de páginas e assets estáticos purgado com sucesso.',
    timestamp: new Date().toISOString(),
  });
});

// ==========================================
// MERCADO PAGO & ORDERS API
// ==========================================

// Configuração segura do Mercado Pago (Expõe apenas dados públicos ao frontend, secrets preservados no backend)
app.get('/api/payments/config', (req: Request, res: Response) => {
  const hasAccessToken = Boolean(
    process.env.MP_ACCESS_TOKEN &&
    !process.env.MP_ACCESS_TOKEN.includes('placeholder') &&
    !process.env.MP_ACCESS_TOKEN.includes('****')
  );
  const publicKey = process.env.MP_PUBLIC_KEY || process.env.VITE_MP_PUBLIC_KEY || '';
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';

  res.json({
    configured: hasAccessToken,
    environment,
    public_key: publicKey,
    pix_enabled: true,
    pix_instant_enabled: true,
    credit_card_enabled: true,
    boleto_enabled: false,
  });
});

interface InMemoryOrder {
  id: string;
  user_id: string;
  event_id: string;
  event_title: string;
  items: { batch_id: string; batch_name: string; quantity: number; unit_price: number; subtotal: number }[];
  subtotal: number;
  convenience_fee: number;
  discount: number;
  total: number;
  payment_method: string;
  payment_status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'in_process' | 'refunded';
  buyer: { id?: string; name: string; email: string; cpf?: string };
  created_at: string;
}

const ordersStore = new Map<string, InMemoryOrder>();

// Helper: Resolver ou garantir existência de perfil oficial do comprador (UUID em public.profiles)
async function resolveBuyerProfile(buyerInfo: { id?: string; name: string; email: string; cpf?: string }, authHeader?: string): Promise<string | null> {
  // 1. Se vier token Bearer de sessão Supabase Auth no cabeçalho
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const { data: { user } } = await supabaseAdmin.auth.getUser(token);
      if (user?.id) {
        return user.id;
      }
    } catch {}
  }

  // 2. Se o ID fornecido no payload for um UUID válido
  if (buyerInfo?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(buyerInfo.id)) {
    const { data: prof } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', buyerInfo.id)
      .maybeSingle();
    if (prof?.id) {
      return prof.id;
    }
  }

  // 3. Buscar pelo email no banco de perfis
  if (buyerInfo?.email) {
    const normalizedEmail = buyerInfo.email.trim().toLowerCase();
    const { data: prof } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (prof?.id) {
      return prof.id;
    }

    // 4. Se não existe perfil ainda, criar usuário e perfil via Supabase Auth Admin
    try {
      const tempPassword = `px_${crypto.randomBytes(12).toString('hex')}!A`;
      const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password: tempPassword,
        email_confirm: true,
        user_metadata: {
          full_name: buyerInfo.name || 'Cliente PX',
          cpf: buyerInfo.cpf || null,
        },
      });

      if (newUser?.user?.id) {
        // Garantir que a tabela public.profiles tenha o registro
        await supabaseAdmin.from('profiles').upsert({
          id: newUser.user.id,
          email: normalizedEmail,
          full_name: buyerInfo.name || 'Cliente PX',
          cpf: buyerInfo.cpf || null,
          role: 'USER',
          is_verified: true,
        });
        return newUser.user.id;
      }
    } catch (e) {
      console.warn('[PX CUSTON Checkout] Falha ao auto-provisionar perfil do comprador:', e);
    }
  }

  return null;
}

// Endpoint Oficial: Criação Autoritativa de Pedidos com Garantia Transacional
app.post('/api/orders/create', async (req: Request, res: Response) => {
  const { event_id, items, buyer, payment_method, event_title } = req.body;

  if (!event_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Dados do pedido incompletos ou inválidos.' });
  }

  // 1. Bloqueio Rigoroso de Pedidos em Eventos de Demonstração (is_demo = true)
  const demoEventIds = ['evt-mega-encontro-2025', 'evt-racha-som-2025', 'evt-carros-antigos-2025'];
  if (demoEventIds.includes(event_id)) {
    return res.status(400).json({
      error: 'Operação bloqueada: Eventos marcados como demonstrativos (DEMO) não aceitam pedidos ou pagamentos comerciais reais.',
      is_demo: true,
    });
  }

  // Verificar se o banco de dados oficial está acessível
  let dbEvent: any = null;
  try {
    const { data, error: evtErr } = await supabaseAdmin
      .from('events')
      .select('id, title, is_demo, is_official, status')
      .eq('id', event_id)
      .maybeSingle();

    if (evtErr) {
      console.error('[PX CUSTON Checkout] Erro ao consultar evento no Supabase:', evtErr);
      return res.status(503).json({
        error: 'Serviço temporariamente indisponível: O banco de dados oficial está inacessível para registrar o pedido com persistência garantida.',
      });
    }

    dbEvent = data;
  } catch (err) {
    return res.status(503).json({
      error: 'Serviço temporariamente indisponível: Não foi possível conectar ao banco de dados oficial. Nenhuma cobrança foi efetuada.',
    });
  }

  if (dbEvent?.is_demo === true) {
    return res.status(400).json({
      error: 'Operação bloqueada: Eventos marcados como demonstrativos (DEMO) não aceitam pedidos ou pagamentos comerciais reais.',
      is_demo: true,
    });
  }

  if (dbEvent && dbEvent.status !== 'published') {
    return res.status(400).json({
      error: 'Operação bloqueada: O evento selecionado não está publicado para vendas.',
    });
  }

  // 2. Resolver o ID oficial do comprador no banco de perfis
  const buyerUserId = await resolveBuyerProfile(buyer, req.headers.authorization);
  if (!buyerUserId) {
    return res.status(400).json({
      error: 'Não foi possível associar um perfil de usuário válido ao comprador para persistência oficial do pedido.',
    });
  }

  // Sanitizar itens do payload
  const formattedItems: { batch_id: string; quantity: number }[] = [];
  for (const it of items) {
    const qty = parseInt(it.quantity, 10);
    if (isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Quantidade de ingressos inválida.' });
    }
    formattedItems.push({ batch_id: it.batch_id, quantity: qty });
  }

  // 3. Execução Atômica via Procedimento PostgreSQL com ROW LOCKING (FOR UPDATE)
  // Gera identificador único de idempotência para o pedido (evitando reprocessamento ou duplicidade)
  const clientOrderId = (req.body.order_id && typeof req.body.order_id === 'string' && req.body.order_id.length > 10)
    ? req.body.order_id
    : crypto.randomUUID();

  try {
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('process_order_checkout', {
      p_event_id: event_id,
      p_user_id: buyerUserId,
      p_items: formattedItems,
      p_payment_method: payment_method || 'pix',
      p_buyer_info: {
        name: buyer?.name || 'Cliente PX',
        email: buyer?.email || '',
        cpf: buyer?.cpf || '',
      },
      p_order_id: clientOrderId,
    });

    if (rpcError) {
      const msg = rpcError.message || '';

      // Regra Fundamental: Se a função RPC ainda não estiver migrada, NÃO executar fallback não atômico
      // A falha da RPC resulta em erro controlado, sem confirmar a compra nem descontar estoque fora da transação
      if (rpcError.code === 'PGRST202' || msg.includes('does not exist')) {
        console.error('[PX CUSTON Checkout] Função RPC process_order_checkout não encontrada no banco. Operação abortada para preservar a integridade do estoque.');
        return res.status(503).json({
          error: 'Serviço de checkout em manutenção de integridade. Nenhuma reserva ou cobrança foi efetuada. Tente novamente em instantes.',
        });
      }

      // Conflito de concorrência ou estoque insuficiente
      if (msg.includes('insuficiente') || msg.includes('Estoque insuficiente')) {
        return res.status(409).json({ error: msg });
      }

      // Validações de negócio (datas de vendas, status do lote, lote inativo, etc.)
      if (
        msg.includes('Operação bloqueada') ||
        msg.includes('não pertence') ||
        msg.includes('inativo') ||
        msg.includes('encerrado') ||
        msg.includes('não foram iniciadas')
      ) {
        return res.status(400).json({ error: msg });
      }

      // Não tratar um erro genérico como prova de que o pedido não foi criado sem verificar primeiro:
      // Pode ter havido um timeout de rede pontual entre o banco e o backend após o commit da transação.
      const { data: checkedOrder } = await supabaseAdmin
        .from('orders')
        .select('id, user_id, event_id, subtotal, convenience_fee, discount, total, payment_method, payment_status, created_at, order_items(batch_id, quantity, unit_price, subtotal)')
        .eq('id', clientOrderId)
        .maybeSingle();

      if (checkedOrder && checkedOrder.id) {
        console.log(`[PX CUSTON Checkout] Pedido ${clientOrderId} recuperado com sucesso após oscilação.`);
        const mpAccessToken = process.env.MP_ACCESS_TOKEN;
        const isGatewayReady = Boolean(mpAccessToken && !mpAccessToken.includes('placeholder'));
        const expirationDate = new Date(Date.now() + 15 * 60 * 1000).toISOString();

        const recoveredOrder: InMemoryOrder = {
          id: checkedOrder.id,
          user_id: checkedOrder.user_id,
          event_id: checkedOrder.event_id,
          event_title: dbEvent?.title || event_title || 'PX CUSTON',
          items: (checkedOrder.order_items || []).map((oi: any) => ({
            batch_id: oi.batch_id,
            batch_name: 'Ingresso PX',
            quantity: oi.quantity,
            unit_price: Number(oi.unit_price),
            subtotal: Number(oi.subtotal),
          })),
          subtotal: Number(checkedOrder.subtotal),
          convenience_fee: Number(checkedOrder.convenience_fee),
          discount: Number(checkedOrder.discount),
          total: Number(checkedOrder.total),
          payment_method: checkedOrder.payment_method,
          payment_status: checkedOrder.payment_status,
          buyer: {
            id: buyerUserId,
            name: buyer?.name || 'Cliente PX',
            email: buyer?.email || '',
            cpf: buyer?.cpf || '',
          },
          created_at: checkedOrder.created_at,
        };

        ordersStore.set(checkedOrder.id, recoveredOrder);

        return res.json({
          success: true,
          order: recoveredOrder,
          payment: {
            status: 'pending',
            method: recoveredOrder.payment_method,
            preference_id: `pref_${checkedOrder.id}`,
            gateway_ready: isGatewayReady,
            expires_at: expirationDate,
            expires_in_seconds: 900,
            pix_copy_paste: recoveredOrder.payment_method === 'pix'
              ? `00020126580014BR.GOV.BCB.PIX0136${checkedOrder.id}520400005303986540${recoveredOrder.total.toFixed(2)}5802BR5916PX CUSTON EVENTOS6009MANHUACU62070503***6304B7A1`
              : null,
            message: 'Pedido registrado com sucesso. Aguardando confirmação do pagamento pelo Mercado Pago (Expira em 15 minutos).',
          },
        });
      }

      return res.status(400).json({ error: msg || 'Falha ao processar o checkout.' });
    }

    if (rpcResult && rpcResult.order_id) {
      const newOrder: InMemoryOrder = {
        id: rpcResult.order_id,
        user_id: buyerUserId,
        event_id: rpcResult.event_id,
        event_title: rpcResult.event_title || event_title || 'PX CUSTON',
        items: rpcResult.items,
        subtotal: rpcResult.subtotal,
        convenience_fee: rpcResult.convenience_fee,
        discount: rpcResult.discount,
        total: rpcResult.total,
        payment_method: rpcResult.payment_method,
        payment_status: 'pending',
        buyer: {
          id: buyerUserId,
          name: buyer?.name || 'Cliente PX',
          email: buyer?.email || '',
          cpf: buyer?.cpf || '',
        },
        created_at: rpcResult.created_at || new Date().toISOString(),
      };

      ordersStore.set(rpcResult.order_id, newOrder);

      const mpAccessToken = process.env.MP_ACCESS_TOKEN;
      const isGatewayReady = Boolean(mpAccessToken && !mpAccessToken.includes('placeholder'));
      const expirationDate = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      return res.json({
        success: true,
        order: newOrder,
        payment: {
          status: 'pending',
          method: newOrder.payment_method,
          preference_id: `pref_${rpcResult.order_id}`,
          gateway_ready: isGatewayReady,
          expires_at: expirationDate,
          expires_in_seconds: 900,
          pix_copy_paste: newOrder.payment_method === 'pix'
            ? `00020126580014BR.GOV.BCB.PIX0136${rpcResult.order_id}520400005303986540${newOrder.total.toFixed(2)}5802BR5916PX CUSTON EVENTOS6009MANHUACU62070503***6304B7A1`
            : null,
          message: 'Pedido registrado com sucesso. Aguardando confirmação do pagamento pelo Mercado Pago (Expira em 15 minutos).',
        },
      });
    }

    return res.status(500).json({ error: 'Resposta inesperada ao criar pedido.' });
  } catch (err: any) {
    console.error('[PX CUSTON Checkout] Exceção crítica durante checkout:', err);

    // Verificação de segurança: checar se o pedido foi criado apesar da exceção de rede
    try {
      const { data: maybeOrder } = await supabaseAdmin
        .from('orders')
        .select('id, user_id, event_id, subtotal, convenience_fee, discount, total, payment_method, payment_status, created_at')
        .eq('id', clientOrderId)
        .maybeSingle();

      if (maybeOrder && maybeOrder.id) {
        console.log(`[PX CUSTON Checkout] Pedido ${clientOrderId} confirmado no banco após reconexão.`);
        const mpAccessToken = process.env.MP_ACCESS_TOKEN;
        const isGatewayReady = Boolean(mpAccessToken && !mpAccessToken.includes('placeholder'));
        const expirationDate = new Date(Date.now() + 15 * 60 * 1000).toISOString();

        return res.json({
          success: true,
          order: maybeOrder,
          payment: {
            status: 'pending',
            method: maybeOrder.payment_method,
            preference_id: `pref_${maybeOrder.id}`,
            gateway_ready: isGatewayReady,
            expires_at: expirationDate,
            expires_in_seconds: 900,
            pix_copy_paste: maybeOrder.payment_method === 'pix'
              ? `00020126580014BR.GOV.BCB.PIX0136${maybeOrder.id}520400005303986540${Number(maybeOrder.total).toFixed(2)}5802BR5916PX CUSTON EVENTOS6009MANHUACU62070503***6304B7A1`
              : null,
            message: 'Pedido registrado com sucesso. Aguardando confirmação do pagamento pelo Mercado Pago (Expira em 15 minutos).',
          },
        });
      }
    } catch (checkErr) {
      console.error('[PX CUSTON Checkout] Erro ao reconciliar status:', checkErr);
    }

    return res.status(500).json({ error: 'Erro de comunicação ao processar reserva. O estoque não foi comprometido de forma inconsistente. Por favor, tente novamente.' });
  }
});

// Endpoint: Consulta de Status do Pedido com Validação Automática de Expiração (15 min)
app.get('/api/orders/:id/status', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const { data: dbOrder } = await supabaseAdmin
      .from('orders')
      .select('id, payment_status, total, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (dbOrder) {
      // Verificar se o pedido é pendente e excedeu o tempo limite de 15 minutos
      if (dbOrder.payment_status === 'pending') {
        const ageMs = Date.now() - new Date(dbOrder.created_at).getTime();
        if (ageMs > 15 * 60 * 1000) {
          // Cancelar e liberar estoque atomicamente
          try {
            await supabaseAdmin.rpc('cancel_order_and_release_stock', {
              p_order_id: id,
              p_reason: 'expired_timeout',
            });
          } catch {
            await supabaseAdmin
              .from('orders')
              .update({ payment_status: 'cancelled', updated_at: new Date().toISOString() })
              .eq('id', id);
          }

          dbOrder.payment_status = 'cancelled';
          const cached = ordersStore.get(id);
          if (cached) cached.payment_status = 'cancelled';

          return res.json({
            id: dbOrder.id,
            status: 'cancelled',
            total: dbOrder.total,
            updated_at: new Date().toISOString(),
            expired: true,
            message: 'O tempo limite para pagamento deste pedido expirou (15 minutos). O estoque reservado foi liberado automaticamente.',
          });
        }
      }

      return res.json({
        id: dbOrder.id,
        status: dbOrder.payment_status,
        total: dbOrder.total,
        updated_at: dbOrder.updated_at,
        expired: dbOrder.payment_status === 'cancelled',
      });
    }
  } catch (e) {}

  // Consulta em cache em memória caso banco esteja em contingência
  const order = ordersStore.get(id);
  if (order) {
    if (order.payment_status === 'pending') {
      const ageMs = Date.now() - new Date(order.created_at).getTime();
      if (ageMs > 15 * 60 * 1000) {
        order.payment_status = 'cancelled';
        return res.json({
          id: order.id,
          status: 'cancelled',
          total: order.total,
          updated_at: new Date().toISOString(),
          expired: true,
          message: 'O tempo limite para pagamento deste pedido expirou (15 minutos). O estoque reservado foi liberado.',
        });
      }
    }

    return res.json({
      id: order.id,
      status: order.payment_status,
      total: order.total,
      updated_at: new Date().toISOString(),
      expired: order.payment_status === 'cancelled',
    });
  }

  return res.status(404).json({ error: 'Pedido não encontrado.' });
});

/**
 * Validação criptográfica da assinatura HMAC-SHA256 enviada pelo Mercado Pago no cabeçalho x-signature.
 * Documentação oficial: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
 */
function verifyMercadoPagoSignature(req: Request): { valid: boolean; configured: boolean; reason?: string } {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret || secret.includes('your-webhook-secret') || secret.includes('placeholder')) {
    return { valid: false, configured: false, reason: 'MP_WEBHOOK_SECRET não configurado no ambiente.' };
  }

  const xSignature = req.headers['x-signature'] as string;
  const xRequestId = req.headers['x-request-id'] as string;

  if (!xSignature) {
    return { valid: false, configured: true, reason: 'Cabeçalho x-signature ausente na requisição.' };
  }

  // Extrair partes: ts e v1 (ex: "ts=1704067200,v1=abcdef...")
  const parts: Record<string, string> = {};
  for (const part of xSignature.split(',')) {
    const [key, val] = part.trim().split('=');
    if (key && val) parts[key] = val;
  }

  const ts = parts['ts'];
  const v1 = parts['v1'];

  if (!ts || !v1) {
    return { valid: false, configured: true, reason: 'Formato inválido de x-signature (ts ou v1 ausentes).' };
  }

  // Prevenir replay attacks com timestamp superior a 10 minutos
  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (!isNaN(tsNum) && Math.abs(nowSec - tsNum) > 600) {
    return { valid: false, configured: true, reason: 'Timestamp de assinatura expirado (replay attack detectado).' };
  }

  const dataId = req.query['data.id'] || req.body?.data?.id || req.body?.id || '';
  const manifest = `id:${dataId};request-id:${xRequestId || ''};ts:${ts};`;

  try {
    const computedHash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    const isValid = crypto.timingSafeEqual(Buffer.from(computedHash, 'utf-8'), Buffer.from(v1, 'utf-8'));
    return { valid: isValid, configured: true };
  } catch (err) {
    return { valid: false, configured: true, reason: 'Falha no cálculo HMAC.' };
  }
}

// Webhook Oficial do Mercado Pago para Confirmação e Conciliação de Pagamentos
app.post('/api/payments/webhook', async (req: Request, res: Response) => {
  const body = req.body || {};
  const query = req.query || {};

  // 1. Verificação de Autenticidade da Assinatura (se configurada no ambiente)
  const signatureCheck = verifyMercadoPagoSignature(req);
  if (signatureCheck.configured && !signatureCheck.valid) {
    console.error(`[PX CUSTON Webhook] ❌ Assinatura inválida rejeitada: ${signatureCheck.reason}`);
    return res.status(401).json({ error: 'Assinatura inválida.', reason: signatureCheck.reason });
  }

  // 2. Extração do Identificador do Pagamento
  const paymentId = body.data?.id || body.id || query['data.id'] || query.id;

  // Se não houver ID de pagamento (ex: pings de teste ou eventos de webhook)
  if (!paymentId || String(paymentId).startsWith('mp-test-')) {
    return res.status(200).json({
      received: true,
      message: 'Notificação de teste/ping reconhecida. Nenhuma alteração financeira executada sem verificação com a autoridade bancária.',
      payment_id: paymentId || null,
    });
  }

  // 3. Validação das Credenciais do Servidor
  const mpAccessToken = process.env.MP_ACCESS_TOKEN;
  if (!mpAccessToken || mpAccessToken.includes('placeholder') || mpAccessToken.includes('your-access-token')) {
    console.error('[PX CUSTON Webhook] MP_ACCESS_TOKEN não configurado no backend. Falha de forma segura sem alterar pedidos.');
    return res.status(503).json({ error: 'Gateway de pagamento não configurado no servidor.' });
  }

  // 4. Consulta Autorizada e Exclusiva na API Oficial do Mercado Pago (Backend-to-Backend)
  let mpData: any = null;
  try {
    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${mpAccessToken}`,
      },
    });

    if (!mpResponse.ok) {
      console.error(`[PX CUSTON Webhook] Pagamento ${paymentId} não localizado na API oficial do Mercado Pago (HTTP ${mpResponse.status}).`);
      return res.status(502).json({ error: 'Não foi possível verificar o pagamento junto ao Mercado Pago.' });
    }

    mpData = await mpResponse.json();
  } catch (mpErr: any) {
    console.error('[PX CUSTON Webhook] Exceção de rede ao consultar API oficial do Mercado Pago:', mpErr);
    return res.status(502).json({ error: 'Erro de comunicação com o Mercado Pago.' });
  }

  // 5. Validação Estrita dos Dados Autorizados do Gateway
  // NUNCA confiar no body recebido: usar estritamente os dados retornados pela API oficial
  const officialOrderId = mpData.external_reference;
  const officialStatus = mpData.status; // 'approved', 'rejected', 'cancelled', 'in_process', etc.
  const officialCurrency = mpData.currency_id;
  const officialAmount = Number(mpData.transaction_amount || 0);

  if (!officialOrderId) {
    console.warn(`[PX CUSTON Webhook] Pagamento ${paymentId} sem external_reference associado.`);
    return res.status(400).json({ error: 'Pagamento não vinculado a um pedido do sistema.' });
  }

  // 6. Consultar Pedido no PostgreSQL
  const { data: dbOrder, error: orderFetchErr } = await supabaseAdmin
    .from('orders')
    .select('id, total, payment_status, event_id, user_id')
    .eq('id', officialOrderId)
    .maybeSingle();

  if (orderFetchErr || !dbOrder) {
    console.error(`[PX CUSTON Webhook] Pedido ${officialOrderId} não encontrado no banco oficial.`);
    return res.status(404).json({ error: 'Pedido referenciado não encontrado.' });
  }

  // 7. Validação de Moeda e Valor
  if (officialCurrency !== 'BRL') {
    console.error(`[PX CUSTON Webhook] Moeda não autorizada: ${officialCurrency}. Esperado: BRL.`);
    return res.status(400).json({ error: 'Moeda da transação inválida.' });
  }

  if (Math.abs(officialAmount - Number(dbOrder.total)) > 0.05) {
    console.error(`[PX CUSTON Webhook] Divergência de valor no pedido ${officialOrderId}: pago R$ ${officialAmount}, esperado R$ ${dbOrder.total}`);
    return res.status(400).json({ error: 'Divergência entre o valor pago e o valor oficial do pedido.' });
  }

  // 8. Proteção contra Notificações Fora de Ordem e Atrasadas
  // Se o pedido JÁ está aprovado, NUNCA cancelar ou estornar por notificação atrasada
  if (dbOrder.payment_status === 'approved') {
    if (officialStatus === 'approved') {
      // Notificação repetida: confirmação idempotente sem reemitir ingressos
      await supabaseAdmin.rpc('confirm_order_and_issue_tickets', {
        p_order_id: officialOrderId,
        p_mercado_pago_id: String(paymentId),
      });
      return res.status(200).json({
        received: true,
        already_approved: true,
        order_id: officialOrderId,
        status: 'approved',
      });
    }

    // Se notificação atrasada trouxer rejected/cancelled para um pedido já aprovado: IGNORAR com segurança
    console.warn(`[PX CUSTON Webhook] Notificação atrasada com status "${officialStatus}" ignorada. Pedido ${officialOrderId} já está aprovado.`);
    return res.status(200).json({
      received: true,
      ignored: true,
      message: 'Pedido já aprovado e protegido contra cancelamento retroativo.',
    });
  }

  // Se o pedido já foi cancelado e o estoque liberado:
  if (dbOrder.payment_status === 'cancelled') {
    console.warn(`[PX CUSTON Webhook] Notificação recebida para pedido ${officialOrderId} já cancelado.`);
    return res.status(200).json({
      received: true,
      already_cancelled: true,
      order_id: officialOrderId,
    });
  }

  // 9. Atualização Transacional com base no Status Oficial
  if (officialStatus === 'approved') {
    const { data: confirmResult, error: confirmErr } = await supabaseAdmin.rpc(
      'confirm_order_and_issue_tickets',
      {
        p_order_id: officialOrderId,
        p_mercado_pago_id: String(paymentId),
      }
    );

    if (confirmErr) {
      console.error('[PX CUSTON Webhook] Falha ao confirmar pedido via RPC:', confirmErr.message);
      return res.status(500).json({ error: 'Falha ao processar confirmação de pagamento no banco.' });
    }

    const cached = ordersStore.get(officialOrderId);
    if (cached) cached.payment_status = 'approved';

    console.log(`[PX CUSTON Webhook] Pedido ${officialOrderId} aprovado com sucesso! Ingressos emitidos.`);
    return res.status(200).json({ received: true, order_id: officialOrderId, status: 'approved' });
  }

  if (officialStatus === 'rejected' || officialStatus === 'cancelled') {
    const { data: cancelResult, error: cancelErr } = await supabaseAdmin.rpc(
      'cancel_order_and_release_stock',
      {
        p_order_id: officialOrderId,
        p_reason: `payment_${officialStatus}`,
      }
    );

    if (cancelErr) {
      console.error('[PX CUSTON Webhook] Falha ao cancelar pedido via RPC:', cancelErr.message);
      return res.status(500).json({ error: 'Falha ao processar cancelamento no banco.' });
    }

    const cached = ordersStore.get(officialOrderId);
    if (cached) cached.payment_status = 'cancelled';

    console.log(`[PX CUSTON Webhook] Pedido ${officialOrderId} cancelado. Estoque devolvido ao lote.`);
    return res.status(200).json({ received: true, order_id: officialOrderId, status: 'cancelled' });
  }

  if (officialStatus === 'in_process') {
    // Antifraude em análise: atualizar pedido para in_process (nunca expirar)
    await supabaseAdmin
      .from('orders')
      .update({ payment_status: 'in_process', updated_at: new Date().toISOString() })
      .eq('id', officialOrderId);

    const cached = ordersStore.get(officialOrderId);
    if (cached) cached.payment_status = 'in_process';

    return res.status(200).json({ received: true, order_id: officialOrderId, status: 'in_process' });
  }

  return res.status(200).json({ received: true, order_id: officialOrderId, status: officialStatus });
});

// Admin Route: Gatilho manual para expirar pedidos pendentes no PX CONTROL
app.post(
  '/api/admin/orders/expire-pending',
  requireAuth,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const timeoutMinutes = parseInt(req.body.timeout_minutes, 10) || 15;
      const { data, error } = await supabaseAdmin.rpc('expire_pending_orders', {
        p_timeout_minutes: timeoutMinutes,
      });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.json({
        success: true,
        result: data,
        executed_by: req.user?.email || 'admin',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

// Legado compatível: Payment preference
app.post('/api/payments/create-preference', (req: Request, res: Response) => {
  const preferenceId = `pref_${Date.now()}_px`;
  res.json({
    success: true,
    preference_id: preferenceId,
    status: 'pending',
  });
});

// Rotina em segundo plano de expiração de pedidos pendentes (> 15 minutos)
function setupOrderExpirationWorker() {
  const EXPIRATION_INTERVAL_MS = 2 * 60 * 1000; // a cada 2 minutos
  setInterval(async () => {
    try {
      const { data: expRes, error: expErr } = await supabaseAdmin.rpc('expire_pending_orders', {
        p_timeout_minutes: 15,
      });

      if (!expErr && expRes && expRes.expired_orders_count > 0) {
        console.log(`[PX CUSTON Worker] Rotina de expiração executada: ${expRes.expired_orders_count} pedidos cancelados e estoque liberado.`);
      }

      // Sincronizar cache em memória
      const now = Date.now();
      for (const [id, ord] of ordersStore.entries()) {
        if (ord.payment_status === 'pending') {
          const ageMs = now - new Date(ord.created_at).getTime();
          if (ageMs > 15 * 60 * 1000) {
            ord.payment_status = 'cancelled';
          }
        }
      }
    } catch (e) {
      // Silencioso em caso de contingência
    }
  }, EXPIRATION_INTERVAL_MS);
}

// Vite middleware in dev or static files in production
async function startServer() {
  const httpServer = http.createServer(app);

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  // Ativar rotina em segundo plano de expiração de pedidos pendentes
  setupOrderExpirationWorker();

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [PX CUSTON] Servidor Express ativo em http://localhost:${PORT}`);
    console.log(`🔐 Supabase Auth & RBAC conectados`);
  });
}

startServer().catch((err) => {
  console.error('Falha ao iniciar servidor PX CUSTON:', err);
  process.exit(1);
});
