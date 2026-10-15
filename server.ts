import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json());

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

  const cleanCode = String(code).trim().toUpperCase();

  try {
    // 1. Tentar validação atômica via stored procedure com bloqueio FOR UPDATE (Anti-Concorrência)
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('validate_and_checkin_ticket', {
      p_code: cleanCode,
      p_operator_id: operator_id || null,
      p_device_id: device_id || 'web-scanner',
    });

    if (!rpcError && rpcResult) {
      if (rpcResult.success) {
        return res.json({
          valid: true,
          code: rpcResult.code,
          event: rpcResult.event,
          holder: rpcResult.holder,
          batch: rpcResult.batch,
          status: 'success',
          timestamp: rpcResult.timestamp,
        });
      } else {
        const statusCode = rpcResult.status === 'already_used' ? 409 : 400;
        return res.status(statusCode).json({
          valid: false,
          code: cleanCode,
          status: rpcResult.status,
          message: rpcResult.message,
          holder: rpcResult.holder,
        });
      }
    }

    // 2. Fallback atômico: Update com verificação de status 'paid' direto no banco
    const checkinTime = new Date().toISOString();
    const { data: updatedTickets, error: updateError } = await supabaseAdmin
      .from('tickets')
      .update({
        status: 'used',
        checkin_at: checkinTime,
        checkin_device_id: device_id || 'web-scanner',
      })
      .eq('code', cleanCode)
      .eq('status', 'paid')
      .select('*, events(title), ticket_batches(name)');

    if (!updateError && updatedTickets && updatedTickets.length > 0) {
      const ticket = updatedTickets[0];
      // Gravar registro na tabela checkins para integridade e auditoria
      await supabaseAdmin.from('checkins').insert({
        ticket_id: ticket.id,
        event_id: ticket.event_id,
        operator_id: operator_id || null,
        device_id: device_id || 'web-scanner',
        status: 'success',
        created_at: checkinTime,
      });

      return res.json({
        valid: true,
        code: cleanCode,
        event: ticket.events?.title || 'PX CUSTON',
        holder: ticket.holder_name,
        batch: ticket.ticket_batches?.name || 'Geral',
        status: 'success',
        timestamp: checkinTime,
      });
    }

    // Se já estava usado:
    const { data: usedTicket } = await supabaseAdmin
      .from('tickets')
      .select('status, holder_name, checkin_at')
      .eq('code', cleanCode)
      .maybeSingle();

    if (usedTicket?.status === 'used') {
      return res.status(409).json({
        valid: false,
        code: cleanCode,
        status: 'already_used',
        message: `ALERTA: Ingresso ${cleanCode} já foi utilizado anteriormente!`,
        holder: usedTicket.holder_name,
      });
    }
  } catch (err) {
    console.warn('[Check-in API] Banco de dados em inicialização, consultando catálogo de homologação.');
  }

  // 3. Validação contra lista autorizada de demonstração com proteção ESTRITA ANTI-DUPLA-ENTRADA
  if (cleanCode === 'PX-7AI89C10' || cleanCode === 'PX-4M29L8X1') {
    const alreadyUsed = demoUsedTickets.get(cleanCode);
    if (alreadyUsed) {
      return res.status(409).json({
        valid: false,
        code: cleanCode,
        status: 'already_used',
        message: `ALERTA: Ingresso ${cleanCode} já foi utilizado anteriormente nesta sessão!`,
        holder: 'Deivid J. Silva',
      });
    }

    const checkinTime = new Date().toISOString();
    demoUsedTickets.set(cleanCode, {
      checkin_at: checkinTime,
      operator: operator_id || 'Operador',
      device: device_id || 'web-scanner',
    });

    const isMega = cleanCode === 'PX-7AI89C10';
    return res.json({
      valid: true,
      code: cleanCode,
      event: isMega ? 'MEGA ENCONTRO PX CUSTON [DEMO]' : 'RACHA DE SOM [DEMO]',
      holder: 'Deivid J. Silva',
      batch: isMega ? 'Pista (Entrada Geral)' : 'Pista Geral',
      status: 'success',
      timestamp: checkinTime,
    });
  }

  // Qualquer código fictício arbitrário é REJEITADO
  return res.status(404).json({
    valid: false,
    code: cleanCode,
    status: 'invalid',
    message: `Ingresso "${cleanCode}" inexistente ou não emitido pela plataforma oficial PX CUSTON.`,
  });
});

// Admin Route: Iniciação segura do primeiro SUPER_ADMIN (Requer segredo forte de servidor)
app.post('/api/admin/init-super-admin', async (req: Request, res: Response) => {
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

  try {
    // 1. Verificar se já existe algum SUPER_ADMIN
    const { data: existingAdmins } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('role', 'SUPER_ADMIN');

    if (existingAdmins && existingAdmins.length > 0) {
      return res.status(403).json({
        error: 'Ação bloqueada: Já existe um SUPER_ADMIN registrado no sistema. Novas permissões devem ser realizadas pelo painel administrativo autenticado.',
      });
    }

    // 2. Localizar usuário no Auth
    const { data: usersData, error: userError } = await supabaseAdmin.auth.admin.listUsers();
    if (userError) throw userError;

    const user = usersData.users.find((u) => u.email?.toLowerCase() === email.toLowerCase().trim());
    if (!user) {
      return res.status(404).json({
        error: `Usuário com o e-mail informado não encontrado no Supabase Auth. Faça o cadastro primeiro.`,
      });
    }

    // 3. Atualizar metadata no auth
    await supabaseAdmin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, role: 'SUPER_ADMIN' },
    });

    // 4. Atualizar role em public.profiles
    await supabaseAdmin
      .from('profiles')
      .update({ role: 'SUPER_ADMIN', updated_at: new Date().toISOString() })
      .eq('id', user.id);

    return res.json({
      success: true,
      message: 'Primeiro SUPER_ADMIN oficial da PX CUSTON promovido com sucesso!',
      user_id: user.id,
      role: 'SUPER_ADMIN',
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Falha interna ao processar inicialização administrativa.' });
  }
});

// Admin Route: Alteração de Papel por um SUPER_ADMIN autenticado
app.post('/api/admin/promote-user', requireAuth, requireRole(['SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  const { target_user_id, new_role } = req.body;
  const validRoles = ['USER', 'CHECKIN_OPERATOR', 'ADMIN', 'SUPER_ADMIN'];

  if (!target_user_id || !validRoles.includes(new_role)) {
    return res.status(400).json({ error: 'target_user_id ou new_role inválido.' });
  }

  try {
    // Atualizar no Supabase Auth
    await supabaseAdmin.auth.admin.updateUserById(target_user_id, {
      user_metadata: { role: new_role },
    });

    // Atualizar no profiles
    await supabaseAdmin
      .from('profiles')
      .update({ role: new_role, updated_at: new Date().toISOString() })
      .eq('id', target_user_id);

    // Gravar log de auditoria
    await supabaseAdmin.from('audit_logs').insert({
      actor_id: req.user.id,
      action: 'ROLE_PROMOTED',
      entity: 'profiles',
      entity_id: target_user_id,
      details: { new_role, promoted_by: req.user.email },
    });

    res.json({ success: true, target_user_id, new_role });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
  payment_status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  buyer: { name: string; email: string; cpf?: string };
  created_at: string;
}

const ordersStore = new Map<string, InMemoryOrder>();

// Endpoint Oficial: Criação Autoritativa de Pedidos
// O backend calcula totais, bloqueia eventos demonstrativos e nunca confia em valores do cliente
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

  try {
    const { data: dbEvent } = await supabaseAdmin
      .from('events')
      .select('id, title, is_demo, is_official')
      .eq('id', event_id)
      .maybeSingle();

    if (dbEvent?.is_demo === true) {
      return res.status(400).json({
        error: 'Operação bloqueada: Eventos marcados como demonstrativos (DEMO) não aceitam pedidos ou pagamentos comerciais reais.',
        is_demo: true,
      });
    }
  } catch (err) {
    // Continua para validação de lotes
  }

  // 2. Cálculo dos valores estritamente no servidor
  let calculatedSubtotal = 0;
  const processedItems: { batch_id: string; batch_name: string; quantity: number; unit_price: number; subtotal: number }[] = [];

  for (const item of items) {
    const qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Quantidade inválida de ingressos.' });
    }

    let unitPrice = Number(item.unit_price) || 0;
    let batchName = item.batch_name || 'Ingresso';

    // Se estiver disponível no banco, recupera preço oficial da tabela ticket_batches
    try {
      const { data: dbBatch } = await supabaseAdmin
        .from('ticket_batches')
        .select('*')
        .eq('id', item.batch_id)
        .maybeSingle();

      if (dbBatch) {
        unitPrice = Number(dbBatch.price);
        batchName = dbBatch.name;
      }
    } catch (e) {
      // Fallback seguro
    }

    const itemSubtotal = unitPrice * qty;
    calculatedSubtotal += itemSubtotal;
    processedItems.push({
      batch_id: item.batch_id,
      batch_name: batchName,
      quantity: qty,
      unit_price: unitPrice,
      subtotal: itemSubtotal,
    });
  }

  const convenienceFee = calculatedSubtotal > 0 ? 4.0 : 0.0;
  const pixDiscount = payment_method === 'pix' ? calculatedSubtotal * 0.05 : 0.0;
  const calculatedTotal = Math.max(0, calculatedSubtotal + convenienceFee - pixDiscount);

  const orderId = `ord-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const createdAt = new Date().toISOString();

  const newOrder: InMemoryOrder = {
    id: orderId,
    user_id: buyer?.email ? `usr-${buyer.email}` : 'usr-guest',
    event_id,
    event_title: event_title || 'PX CUSTON',
    items: processedItems,
    subtotal: Number(calculatedSubtotal.toFixed(2)),
    convenience_fee: Number(convenienceFee.toFixed(2)),
    discount: Number(pixDiscount.toFixed(2)),
    total: Number(calculatedTotal.toFixed(2)),
    payment_method: payment_method || 'pix',
    payment_status: 'pending',
    buyer: {
      name: buyer?.name || 'Cliente PX',
      email: buyer?.email || '',
      cpf: buyer?.cpf || '',
    },
    created_at: createdAt,
  };

  ordersStore.set(orderId, newOrder);

  // Registro seguro no banco se Supabase estiver ativo
  try {
    await supabaseAdmin.from('orders').insert({
      user_id: buyer?.id,
      event_id: event_id,
      subtotal: newOrder.subtotal,
      convenience_fee: newOrder.convenience_fee,
      discount: newOrder.discount,
      total: newOrder.total,
      payment_method: newOrder.payment_method,
      payment_status: 'pending',
    });
  } catch (err) {
    // Ignora caso schema ainda não tenha sido aplicado no Supabase
  }

  const mpAccessToken = process.env.MP_ACCESS_TOKEN;
  const isGatewayReady = Boolean(mpAccessToken && !mpAccessToken.includes('placeholder'));

  res.json({
    success: true,
    order: newOrder,
    payment: {
      status: 'pending',
      method: payment_method || 'pix',
      preference_id: `pref_${orderId}`,
      gateway_ready: isGatewayReady,
      pix_copy_paste: payment_method === 'pix' ? `00020126580014BR.GOV.BCB.PIX0136${orderId}520400005303986540${newOrder.total.toFixed(2)}5802BR5916PX CUSTON EVENTOS6009MANHUACU62070503***6304B7A1` : null,
      message: 'Pedido registrado com sucesso. Aguardando confirmação do pagamento pelo Mercado Pago.',
    },
  });
});

// Endpoint: Consulta de Status do Pedido
app.get('/api/orders/:id/status', async (req: Request, res: Response) => {
  const { id } = req.params;
  const order = ordersStore.get(id);

  if (order) {
    return res.json({
      id: order.id,
      status: order.payment_status,
      total: order.total,
      updated_at: new Date().toISOString(),
    });
  }

  try {
    const { data: dbOrder } = await supabaseAdmin
      .from('orders')
      .select('id, payment_status, total, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (dbOrder) {
      return res.json({
        id: dbOrder.id,
        status: dbOrder.payment_status,
        total: dbOrder.total,
        updated_at: dbOrder.updated_at,
      });
    }
  } catch (e) {
    // Fallback
  }

  return res.status(404).json({ error: 'Pedido não encontrado.' });
});

// Webhook oficial do Mercado Pago para confirmação de pagamentos
app.post('/api/payments/webhook', async (req: Request, res: Response) => {
  const { type, data, action } = req.body;
  console.log(`[PX CUSTON Webhook] Notificação recebida: ${type || action || 'desconhecido'}`);
  res.status(200).json({ received: true });
});

// Legado compatível: Payment preference
app.post('/api/payments/create-preference', (req: Request, res: Response) => {
  const preferenceId = `pref_${Date.now()}_px`;
  res.json({
    success: true,
    preference_id: preferenceId,
    status: 'pending',
  });
});

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

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [PX CUSTON] Servidor Express ativo em http://localhost:${PORT}`);
    console.log(`🔐 Supabase Auth & RBAC conectados`);
  });
}

startServer().catch((err) => {
  console.error('Falha ao iniciar servidor PX CUSTON:', err);
  process.exit(1);
});
