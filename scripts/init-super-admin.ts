import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

const supabaseSecretKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const isSecretKeyPlaceholder =
  !supabaseSecretKey ||
  supabaseSecretKey.includes('placeholder') ||
  supabaseSecretKey.includes('dummy') ||
  supabaseSecretKey.includes('sua_chave') ||
  supabaseSecretKey.length < 20;

if (!supabaseUrl || isSecretKeyPlaceholder) {
  console.error(
    '❌ Erro de Segurança: SUPABASE_URL e uma SUPABASE_SECRET_KEY válida devem estar configuradas no .env.'
  );
  console.error(
    'ℹ️ Utilize a chave secreta service_role do projeto Supabase. Nunca exponha essa chave no frontend.'
  );
  process.exit(1);
}

const targetEmail = process.argv[2]?.trim().toLowerCase();

if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
  console.error(
    '❌ Uso obrigatório: npx tsx scripts/init-super-admin.ts <email-do-usuario>'
  );
  console.error(
    'Exemplo: npx tsx scripts/init-super-admin.ts deividbmx779@gmail.com'
  );
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

async function main() {
  console.log(`🔍 Verificando status administrativo para: ${targetEmail}`);

  // 1. Verificar se já existe algum SUPER_ADMIN.
  const { data: existingAdmins, error: checkError } =
    await supabaseAdmin
      .from('profiles')
      .select('id, email, role')
      .eq('role', 'SUPER_ADMIN');

  if (checkError) {
    console.error(
      '❌ Erro ao verificar administradores existentes:',
      checkError.message
    );
    process.exit(1);
  }

  if (existingAdmins && existingAdmins.length > 0) {
    console.error(
      `🔒 Operação bloqueada: já existe um SUPER_ADMIN (${existingAdmins[0].email}).`
    );
    console.error(
      'Novas permissões devem ser geridas pelo painel PX CONTROL por um SUPER_ADMIN autorizado.'
    );
    process.exit(1);
  }

  // 2. Localizar o usuário no Supabase Auth.
  // A listagem é paginada; percorrer as páginas para não presumir
  // que o usuário esteja entre os primeiros cadastrados.
  let page = 1;
  const perPage = 100;
  let user: { id: string; email?: string; user_metadata?: Record<string, unknown> } | undefined;

  while (!user) {
    const { data: usersData, error: userError } =
      await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage,
      });

    if (userError) {
      console.error(
        '❌ Erro ao listar usuários no Supabase Auth:',
        userError.message
      );
      process.exit(1);
    }

    user = usersData.users.find(
      (u) => u.email?.trim().toLowerCase() === targetEmail
    );

    if (user || usersData.users.length < perPage) {
      break;
    }

    page += 1;
  }

  if (!user) {
    console.error(
      `❌ Usuário com o e-mail "${targetEmail}" não encontrado no Auth.`
    );
    console.error(
      'Confirme se o usuário realizou o cadastro inicial na plataforma PX CUSTON.'
    );
    process.exit(1);
  }

  // 3. Promover usando a função segura existente no banco.
  // A função valida service_role, impede uma segunda promoção inicial
  // e registra a operação na auditoria.
  const { data, error } = await supabaseAdmin.rpc(
    'promote_first_super_admin',
    { target_email: targetEmail }
  );

  if (error) {
    console.error(
      '❌ Falha ao promover SUPER_ADMIN:',
      error.message
    );
    process.exit(1);
  }

  // 4. Validar o retorno da função SQL.
  if (
    !data ||
    typeof data !== 'object' ||
    data.success !== true
  ) {
    console.error(
      '❌ A função do banco não confirmou a promoção:',
      data
    );
    process.exit(1);
  }

  // 5. Confirmar a alteração no perfil público.
  const { data: profile, error: verifyError } =
    await supabaseAdmin
      .from('profiles')
      .select('id, email, role')
      .eq('id', user.id)
      .maybeSingle();

  if (verifyError) {
    console.error(
      '❌ Erro ao verificar o perfil:',
      verifyError.message
    );
    process.exit(1);
  }

  if (
    !profile ||
    profile.role !== 'SUPER_ADMIN' ||
    profile.id !== user.id
  ) {
    console.error(
      '❌ A promoção não foi confirmada no perfil público.',
      profile
    );
    process.exit(1);
  }

  console.log(
    `✅ SUPER_ADMIN confirmado: ${profile.email} (ID: ${profile.id})`
  );
  console.log(
    '🔐 A promoção foi confirmada no perfil público do Supabase.'
  );
}

main().catch((err: unknown) => {
  const message =
    err instanceof Error ? err.message : String(err);

  console.error('❌ Falha inesperada:', message);
  process.exit(1);
});