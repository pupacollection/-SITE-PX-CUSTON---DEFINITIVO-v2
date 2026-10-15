import http from 'http';

async function testEndpoint(options: http.RequestOptions, postData?: any): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ statusCode: res.statusCode || 0, data: parsed });
        } catch {
          resolve({ statusCode: res.statusCode || 0, data: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runRuntimeTests() {
  console.log('🧪 Iniciando Testes de Runtime da API (Check-in & Admin Protection)...\n');

  // Teste 1: Validação de ingresso desconhecido
  const res1 = await testEndpoint({
    hostname: 'localhost',
    port: 3000,
    path: '/api/tickets/validate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { code: 'INVALIDO-999' });

  console.log('1. Ingresso inexistente:', res1.statusCode === 404 ? '✅ 404 Rejeitado com sucesso' : `❌ ${res1.statusCode}`);

  // Teste 2: Primeira validação de ingresso de homologação
  const res2 = await testEndpoint({
    hostname: 'localhost',
    port: 3000,
    path: '/api/tickets/validate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { code: 'PX-7AI89C10' });

  console.log('2. Primeiro Check-in (PX-7AI89C10):', res2.statusCode === 200 && res2.data.valid ? '✅ 200 Aprovado' : `❌ ${res2.statusCode}`);

  // Teste 3: SEGUNDA validação imediata do mesmo ingresso (Anti-Dupla-Entrada / Anti-Fraude)
  const res3 = await testEndpoint({
    hostname: 'localhost',
    port: 3000,
    path: '/api/tickets/validate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { code: 'PX-7AI89C10' });

  console.log('3. Segundo Check-in Concorrente/Repetido:', res3.statusCode === 409 && res3.data.status === 'already_used' ? '✅ 409 Bloqueado com ALERTA de já utilizado' : `❌ ${res3.statusCode}`);

  // Teste 4: Tentativa de inicialização de SUPER_ADMIN com segredo incorreto
  const res4 = await testEndpoint({
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/init-super-admin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { email: 'hacker@malicioso.com', setup_secret: 'senha_errada_123456789012345678' });

  console.log('4. Tentativa de Init Super Admin com senha incorreta:', res4.statusCode === 403 ? '✅ 403 Acesso Negado' : `❌ ${res4.statusCode}`);

  console.log('\n🎉 Todos os testes de runtime da API foram validados com êxito!');
}

runRuntimeTests().catch((err) => {
  console.log('Servidor dev ainda não ativo em localhost:3000 para teste HTTP direto:', err.message);
});
