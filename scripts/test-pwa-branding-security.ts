import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
// IMPORTAÇÃO DA FUNÇÃO REAL DE PRODUÇÃO
import { validateAndDecodePng } from '../src/lib/pngValidator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

async function runTestSuite() {
  console.log('=== SUÍTE DE TESTES RIGOROSA: SEGURANÇA, PNG REAL & PERSISTÊNCIA PWA ===\n');
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, extraInfo = '') {
    if (condition) {
      console.log(`[PASS] ${name} ${extraInfo}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name} ${extraInfo}`);
      failed++;
    }
  }

  // -------------------------------------------------------------
  // Bloco 1: Validador PNG Real da Aplicação (src/lib/pngValidator.ts)
  // -------------------------------------------------------------
  const real192 = fs.readFileSync(path.join(rootDir, 'public/px-logo-192.png'));
  const real512 = fs.readFileSync(path.join(rootDir, 'public/px-logo-512.png'));

  // Teste 1.1: PNG real 192x192 oficial aceito e descomprimido com exatidão de scanlines
  const valid192DataUrl = `data:image/png;base64,${real192.toString('base64')}`;
  const resValid192 = validateAndDecodePng(valid192DataUrl, 192, 192);
  assert(
    '1.1 Validador real aceita PNG oficial 192x192 com descompressão zlib exata',
    resValid192.valid === true && resValid192.width === 192 && resValid192.height === 192,
    resValid192.valid ? `Uncompressed: ${resValid192.uncompressedBytes}B` : resValid192.error
  );

  // Teste 1.2: PNG real 512x512 oficial aceito
  const valid512DataUrl = `data:image/png;base64,${real512.toString('base64')}`;
  const resValid512 = validateAndDecodePng(valid512DataUrl, 512, 512);
  assert(
    '1.2 Validador real aceita PNG oficial 512x512',
    resValid512.valid === true && resValid512.width === 512 && resValid512.height === 512,
    resValid512.valid ? `Uncompressed: ${resValid512.uncompressedBytes}B` : resValid512.error
  );

  // Teste 1.3: PNG truncado com cabeçalho e dimensões válidas (corta no meio do IDAT)
  // Possui os 8 bytes de assinatura + 25 bytes do IHDR (width=192, height=192), mas sem stream IDAT completo e sem IEND
  const truncatedBuffer = real192.slice(0, 48);
  const truncatedDataUrl = `data:image/png;base64,${truncatedBuffer.toString('base64')}`;
  const resTruncated = validateAndDecodePng(truncatedDataUrl, 192, 192);
  assert(
    '1.3 Rejeição de PNG truncado com assinatura e dimensões aparentemente válidas',
    resTruncated.valid === false && resTruncated.error.includes('truncado'),
    `Erro retornado: ${resTruncated.valid ? 'Nenhum' : resTruncated.error}`
  );

  // Teste 1.4: PNG com CRC32 corrompido em chunk
  const corruptedCrcBuffer = Buffer.from(real192);
  // Modificar um byte no chunk IHDR para invalidar o CRC32
  corruptedCrcBuffer[16] = corruptedCrcBuffer[16] ^ 0xff;
  const corruptedCrcDataUrl = `data:image/png;base64,${corruptedCrcBuffer.toString('base64')}`;
  const resCorruptedCrc = validateAndDecodePng(corruptedCrcDataUrl);
  assert(
    '1.4 Rejeição de PNG com CRC32 corrompido em chunk',
    resCorruptedCrc.valid === false && (resCorruptedCrc.error.includes('CRC32') || resCorruptedCrc.error.includes('incompatível')),
    `Erro retornado: ${resCorruptedCrc.valid ? 'Nenhum' : resCorruptedCrc.error}`
  );

  // Teste 1.5: Rejeição de arquivo não-PNG (HTML / Script / Texto)
  const fakeHtmlDataUrl = 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  const resFakeHtml = validateAndDecodePng(fakeHtmlDataUrl, 192, 192);
  assert(
    '1.5 Rejeição de payload não-PNG (HTML/Script)',
    resFakeHtml.valid === false && (resFakeHtml.error.includes('Tipo MIME') || resFakeHtml.error.includes('payload inválido')),
    `Erro retornado: ${resFakeHtml.valid ? 'Nenhum' : resFakeHtml.error}`
  );

  // Teste 1.6: Rejeição de imagem com dimensões incorretas para o slot solicitado
  // Passa PNG 512x512 para validação com expectedWidth=192
  const resWrongDim = validateAndDecodePng(valid512DataUrl, 192, 192);
  assert(
    '1.6 Rejeição de PNG com dimensões incompatíveis (512x512 enviado para slot 192x192)',
    resWrongDim.valid === false && resWrongDim.error.includes('Largura incompatível'),
    `Erro retornado: ${resWrongDim.valid ? 'Nenhum' : resWrongDim.error}`
  );

  // -------------------------------------------------------------
  // Bloco 2: Proteção de Endpoints e Autenticação no Servidor HTTP
  // -------------------------------------------------------------
  // Teste 2.1: Requisição sem token (401)
  try {
    const res = await fetch(`${BASE_URL}/api/admin/pwa-icon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon_192: valid192DataUrl }),
    });
    const data = await res.json();
    assert(
      '2.1 Endpoint POST /api/admin/pwa-icon recusa requisição anônima com 401',
      res.status === 401 && data.error.includes('Token de autenticação não fornecido'),
      `Status: ${res.status}, Mensagem: ${data.error}`
    );
  } catch (e: any) {
    assert('2.1 Requisição sem token', false, e.message);
  }

  // Teste 2.2: Requisição com token inválido/forjado (401)
  try {
    const res = await fetch(`${BASE_URL}/api/admin/pwa-icon`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer jwt_forjado_ou_invalido',
      },
      body: JSON.stringify({ icon_192: valid192DataUrl }),
    });
    const data = await res.json();
    assert(
      '2.2 Endpoint recusa token inválido/expirado com 401',
      res.status === 401 && data.error.includes('Sessão inválida ou expirada'),
      `Status: ${res.status}, Mensagem: ${data.error}`
    );
  } catch (e: any) {
    assert('2.2 Requisição com token inválido', false, e.message);
  }

  // Teste 2.3: Reset sem token (401)
  try {
    const res = await fetch(`${BASE_URL}/api/admin/pwa-icon/reset`, {
      method: 'POST',
    });
    const data = await res.json();
    assert(
      '2.3 Endpoint POST /api/admin/pwa-icon/reset recusa requisição anônima com 401',
      res.status === 401 && data.error.includes('Token de autenticação não fornecido'),
      `Status: ${res.status}`
    );
  } catch (e: any) {
    assert('2.3 Reset sem token', false, e.message);
  }

  // -------------------------------------------------------------
  // Bloco 3: Manifesto Dinâmico e Carregamento HTTP de Ícones
  // -------------------------------------------------------------
  // Teste 3.1: Manifesto servido com Content-Type apropriado e campos obrigatórios
  try {
    const res = await fetch(`${BASE_URL}/manifest.webmanifest`);
    const manifest = await res.json();
    const isJson = res.headers.get('content-type')?.includes('application/manifest+json');
    const hasIcons = Array.isArray(manifest.icons) && manifest.icons.length === 3;
    const iconsValid = manifest.icons.every((i: any) => i.src && i.sizes && i.type === 'image/png');

    assert(
      '3.1 GET /manifest.webmanifest entrega JSON com Content-Type application/manifest+json',
      res.status === 200 && isJson && hasIcons && iconsValid,
      `Status: ${res.status}, Content-Type: ${res.headers.get('content-type')}`
    );

    // Teste 3.2: Cada um dos ícones apontados pelo manifesto deve ser carregado com 200 OK image/png
    let allIconsLoaded = true;
    for (const icon of manifest.icons) {
      const iconUrl = `${BASE_URL}${icon.src}`;
      const resIcon = await fetch(iconUrl);
      const isPng = resIcon.headers.get('content-type')?.includes('image/png');
      if (resIcon.status !== 200 || !isPng) {
        allIconsLoaded = false;
        console.error(`Falha no ícone ${icon.src}: status ${resIcon.status}`);
      }
    }
    assert(
      '3.2 Todos os ícones referenciados no manifesto respondem 200 OK com Content-Type image/png',
      allIconsLoaded,
      `Verificados ${manifest.icons.length} ícones com sucesso`
    );
  } catch (e: any) {
    assert('3.1/3.2 Manifesto e ícones', false, e.message);
  }

  // -------------------------------------------------------------
  // Bloco 4: Consistência em Falha de Gravação, Rollback e Fallback
  // -------------------------------------------------------------
  const brandingJsonPath = path.resolve(rootDir, 'data/pwa-branding.json');
  const originalBrandingJson = fs.readFileSync(brandingJsonPath, 'utf-8');

  // Teste 4.1: Fallback se arquivos customizados estiverem ausentes no disco
  // Se o JSON apontar para arquivos inexistentes, o servidor reverte imediatamente para os ícones padrão oficiais
  try {
    fs.writeFileSync(
      brandingJsonPath,
      JSON.stringify({
        is_custom: true,
        icon_192: '/branding/inexistente_192.png',
        icon_512: '/branding/inexistente_512.png',
        icon_maskable: '/branding/inexistente_maskable.png',
      })
    );

    const res = await fetch(`${BASE_URL}/manifest.webmanifest`);
    const manifest = await res.json();
    const fallbackWorks = manifest.icons.every((i: any) => !i.src.includes('inexistente') && i.src.includes('px-logo'));

    assert(
      '4.1 Manifesto não aponta para arquivos inexistentes quando há inconsistência em disco',
      fallbackWorks,
      `Ícone servido no fallback: ${manifest.icons[0].src}`
    );
  } finally {
    fs.writeFileSync(brandingJsonPath, originalBrandingJson);
  }

  // Teste 4.2: Fallback se o JSON estiver corrompido com sintaxe malformada
  try {
    fs.writeFileSync(brandingJsonPath, '<<< SINTAXE_JSON_CORROMPIDA_SEM_FECHAR >>>');
    const res = await fetch(`${BASE_URL}/api/branding`);
    const branding = await res.json();

    assert(
      '4.2 Endpoint /api/branding sobrevive a arquivo JSON corrompido e entrega padrão oficial',
      res.status === 200 && branding.is_custom === false && branding.icon_192 === '/px-logo-192.png',
      `Retornou is_custom: ${branding.is_custom}, icon: ${branding.icon_192}`
    );
  } finally {
    fs.writeFileSync(brandingJsonPath, originalBrandingJson);
  }

  // Teste 4.3: Confirmação de integridade dos arquivos oficiais originais
  const official192Exists = fs.existsSync(path.join(rootDir, 'public/px-logo-192.png'));
  const official512Exists = fs.existsSync(path.join(rootDir, 'public/px-logo-512.png'));
  const officialMaskableExists = fs.existsSync(path.join(rootDir, 'public/px-logo-maskable-512.png'));
  assert(
    '4.3 Arquivos de ícones oficiais padrão preservados e intactos no diretório public/',
    official192Exists && official512Exists && officialMaskableExists,
    'px-logo-192.png, px-logo-512.png e px-logo-maskable-512.png verificados'
  );

  console.log(`\n=== SUÍTE CONCLUÍDA: ${passed} PASSADOS / ${failed} FALHAS ===\n`);
  if (failed > 0) process.exit(1);
}

runTestSuite().catch((err) => {
  console.error('Erro na execução da suíte:', err);
  process.exit(1);
});
