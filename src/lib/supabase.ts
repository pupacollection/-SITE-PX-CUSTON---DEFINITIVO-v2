import { createClient, Session, User } from '@supabase/supabase-js';
import { UserProfile, UserRole } from '../types';

// Environment variables for Supabase integration
const supabaseUrl =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  'https://jivviwvpjxzhbpbmqmxm.supabase.co';

const supabaseAnonKey =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_7WZVS9yF_pXqv5PPTPq1Kw_gIL7mvgy';

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
    supabaseAnonKey &&
    !supabaseUrl.includes('placeholder') &&
    !supabaseAnonKey.includes('dummy')
);

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  },
});

/**
 * Retorna o perfil completo do usuário autenticado no Supabase.
 * Consulta a tabela public.profiles; caso a tabela esteja sendo inicializada,
 * extrai os dados seguros dos metadados da sessão Auth.
 */
export async function getCurrentUserProfile(user: User): Promise<UserProfile> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*, vehicles(*)')
      .eq('id', user.id)
      .maybeSingle();

    if (data && !error) {
      return {
        id: data.id,
        email: data.email,
        full_name: data.full_name || 'Usuário PX',
        phone: data.phone || '',
        avatar_url: data.avatar_url,
        cpf: data.cpf,
        role: data.role as UserRole,
        is_verified: data.is_verified || false,
        created_at: data.created_at,
        vehicles: data.vehicles || [],
      };
    }
  } catch (err) {
    console.warn('[PX CUSTON] Perfil não encontrado no banco, utilizando dados de Auth:', err);
  }

  // Fallback seguro a partir de auth.users metadata
  const meta = user.user_metadata || {};
  return {
    id: user.id,
    email: user.email || '',
    full_name: meta.full_name || user.email?.split('@')[0] || 'Usuário PX',
    phone: meta.phone || '',
    role: (meta.role as UserRole) || 'USER',
    is_verified: Boolean(user.email_confirmed_at),
    created_at: user.created_at,
    vehicles: [],
  };
}

/**
 * Cadastro oficial de novo usuário no Supabase Auth
 */
export async function signUpUser(email: string, password: string, fullName: string, phone: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        phone: phone,
        // Role nunca é aceito como ADMIN pelo trigger do banco
        role: 'USER',
      },
    },
  });

  if (error) throw error;
  return data;
}

/**
 * Login com email e senha
 */
export async function signInUser(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw error;
  return data;
}

/**
 * Logout seguro
 */
export async function signOutUser() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * Solicitação de recuperação de senha
 */
export async function resetPasswordForEmail(email: string) {
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/#reset-password`,
  });

  if (error) throw error;
  return data;
}

/**
 * Inicialização segura do primeiro SUPER_ADMIN através da API autoritativa do servidor
 */
export async function requestFirstSuperAdminPromotion(email: string, secretKey: string) {
  const res = await fetch('/api/admin/init-super-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      setup_secret: secretKey,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Falha ao processar inicialização do SUPER_ADMIN.');
  }

  return data;
}
