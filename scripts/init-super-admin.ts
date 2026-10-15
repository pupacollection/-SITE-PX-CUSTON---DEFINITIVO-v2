import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const isSecretKeyPlaceholder =
  !supabaseSecretKey ||
  supabaseSecretKey.includes('placeholder') ||
  supabaseSecretKey.includes('dummy') ||
  supabaseSecretKey.includes('sua_chave') ||
  supabaseSecretKey.length < 20;

if (!supabaseUrl || isSecretKeyPlaceholder) {
  console.error('❌ Erro de Segurança: SUPABASE_URL e uma SUPABASE_SECRET_KEY válida devem estar configuradas no .env para executar este comando.');
  console.error('ℹ️ A chave deve ser a service_role secret do projeto Supabase. Placeholders ou chaves de demonstração não são aceitos.');
  process.exit(1);
}

const targetEmail = process.argv[2];

if (!targetEmail || !targetEmail.includes('@')) {
  console.error('❌ Uso obrigatório: npx tsx scripts/init-super-admin.ts <email-do-usuario>');
  console.error('Exemplo: npx tsx scripts/init-super-admin.ts deividbmx779@gmail.com');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log(`🔍 Verificando status administrativo para: ${targetEmail}`);

  // 1. Verificar se já existe algum SUPER_ADMIN
  const { data: existingAdmins, error: checkError } = await supabaseAdmin
    .from('profiles')
    .select('id, email, role')
    .eq('role', 'SUPER_ADMIN');

  if (existingAdmins && existingAdmins.length > 0) {
    console.error(`🔒 Operação Bloqueada: Já existe um SUPER_ADMIN registrado no sistema (${existingAdmins[0].email}).`);
    console.error('Novas promoções devem ser realizadas através do painel PX CONTROL por um SUPER_ADMIN autenticado.');
    process.exit(1);
  }

  // 2. Localizar usuário no Auth
  const { data: usersData, error: userError } = await supabaseAdmin.auth.admin.listUsers();
  if (userError) {
    console.error('❌ Erro ao listar usuários no Supabase Auth:', userError.message);
    process.exit(1);
  }

  const user = usersData.users.find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase().trim());
  if (!user) {
    console.error(`❌ Usuário com o e-mail "${targetEmail}" não encontrado.`);
    console.error('Certifique-se de que o usuário realizou o cadastro inicial na plataforma PX CUSTON antes de promovê-lo.');
    process.exit(1);
  }

  // 3. Promover usando a função segura já existente no Supabase
const normalizedEmail = targetEmail.trim().toLowerCase();

const { data, error } = await supabaseAdmin.rpc(
  'promote_first_super_admin',
  { target_email: normalizedEmail }
);

if (error) {
  console.error('❌ Falha ao promover SUPER_ADMIN:', error.message);
  process.exit(1);
}

// 4. Confirmar o papel no perfil público
const { data: profile, error: verifyError } = await supabaseAdmin
  .from('profiles')
  .select('id, email, role')
  .eq('id', user.id)
  .maybeSingle();

if (verifyError) {
  console.error('❌ Erro ao verificar o perfil:', verifyError.message);
  process.exit(1);
}

if (profile?.role !== 'SUPER_ADMIN') {
  console.error(
    '❌ A promoção não foi confirmada. Retorno da função:',
    data
  );
  process.exit(1);
}

console.log(
  `✅ SUPER_ADMIN confirmado: ${profile.email} (ID: ${profile.id})`
);