import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
  console.error('❌ Erro: SUPABASE_URL e SUPABASE_SECRET_KEY devem estar configurados no .env para executar este comando.');
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

  // 3. Atualizar metadata no auth
  await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: { ...user.user_metadata, role: 'SUPER_ADMIN' },
  });

  // 4. Atualizar em public.profiles
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ role: 'SUPER_ADMIN', updated_at: new Date().toISOString() })
    .eq('id', user.id);

  if (profileError) {
    console.warn('⚠️ Perfil público ainda não existe no banco (será sincronizado assim que a tabela for criada).');
  }

  console.log(`✅ SUCESSO: Usuário "${targetEmail}" (ID: ${user.id}) promovido com sucesso ao papel de primeiro SUPER_ADMIN oficial da PX CUSTON!`);
}

main().catch((err) => {
  console.error('❌ Falha inesperada:', err);
  process.exit(1);
});
