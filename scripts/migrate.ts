import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL;

  if (!connectionString || connectionString.includes('placeholder') || connectionString.includes('sua_connection_string')) {
    console.error(
      '❌ [PX CUSTON Migrations] DATABASE_URL não configurada no ambiente (.env).'
    );
    console.error(
      'ℹ️ Para executar migrações programaticamente, defina DATABASE_URL no .env com a connection string PostgreSQL oficial do Supabase.'
    );
    console.error(
      'ℹ️ Alternativamente, você pode copiar e executar o arquivo /supabase/migrations/combined_migration.sql diretamente no SQL Editor do painel do Supabase.'
    );
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('🔌 Conectando ao PostgreSQL do Supabase...');
    await client.connect();
    console.log('✅ Conexão estabelecida com sucesso.');

    const migrationFile = path.resolve(__dirname, '../supabase/migrations/combined_migration.sql');
    if (!fs.existsSync(migrationFile)) {
      console.error(`❌ Arquivo de migração não encontrado em: ${migrationFile}`);
      process.exit(1);
    }

    const sql = fs.readFileSync(migrationFile, 'utf8');

    console.log('🚀 Executando migrações SQL consolidadas...');
    await client.query(sql);
    console.log('🎉 Migrações aplicadas com sucesso no Supabase!');
  } catch (err: any) {
    // Sanitizar mensagens para não expor senhas embutidas em URIs
    const sanitizedMsg = (err.message || '').replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
    console.error('❌ Erro ao executar migrações no banco:', sanitizedMsg);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
