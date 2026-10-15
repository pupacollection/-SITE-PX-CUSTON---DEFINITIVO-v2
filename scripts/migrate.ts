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

  if (!connectionString) {
    console.log(
      'ℹ️ [PX CUSTON Migrations] DATABASE_URL não informada no .env. As migrações estão prontas em /supabase/migrations/combined_migration.sql para execução direta no SQL Editor do Supabase.'
    );
    return;
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('🔌 Conectando ao PostgreSQL do Supabase...');
    await client.connect();
    console.log('✅ Conexão estabelecida.');

    const migrationFile = path.resolve(__dirname, '../supabase/migrations/combined_migration.sql');
    const sql = fs.readFileSync(migrationFile, 'utf8');

    console.log('🚀 Executando migrações SQL...');
    await client.query(sql);
    console.log('🎉 Migrações aplicadas com sucesso no Supabase!');
  } catch (err: any) {
    console.error('❌ Erro ao executar migrações:', err.message);
  } finally {
    await client.end();
  }
}

runMigrations();
