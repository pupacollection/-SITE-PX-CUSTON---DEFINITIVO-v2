import React, { useState, useEffect, useRef } from 'react';
import { MercadoPagoConfig, ActiveScreen } from '../types';
import {
  CreditCard,
  Key,
  ShieldCheck,
  Save,
  CheckCircle2,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  Mail,
  Bell,
  Smartphone,
  Shield,
  Wrench,
  Lock,
  Palette,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { AdminBrandingManager } from '../components/admin/AdminBrandingManager';
import {
  fetchPaymentSettings,
  savePaymentSettings,
  mapServerResponseToMercadoPagoConfig,
  ServerPaymentStatusResponse,
} from '../services/paymentSettingsService';

interface PaymentSettingsViewProps {
  initialConfig: MercadoPagoConfig;
  onSave: (config: MercadoPagoConfig) => void;
  onNavigate: (screen: ActiveScreen) => void;
}

export const PaymentSettingsView: React.FC<PaymentSettingsViewProps> = ({
  initialConfig,
  onSave,
  onNavigate,
}) => {
  const [settingsTab, setSettingsTab] = useState<'payments' | 'notifications' | 'branding'>('payments');
  const [config, setConfig] = useState<MercadoPagoConfig>(initialConfig);
  const [isLoadingConfig, setIsLoadingConfig] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingNotice, setSavingNotice] = useState<boolean>(false);
  const [notifSavingNotice, setNotifSavingNotice] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerPaymentStatusResponse | null>(null);

  const isMountedRef = useRef<boolean>(true);
  const saveNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Notification configuration states with persistent storage (local browser preferences)
  const [notifWebhooksEnabled, setNotifWebhooksEnabled] = useState(() => {
    const saved = localStorage.getItem('px_notif_webhooks');
    return saved !== null ? saved === 'true' : true;
  });
  const [notifEmailConfirmation, setNotifEmailConfirmation] = useState(() => {
    const saved = localStorage.getItem('px_notif_email');
    return saved !== null ? saved === 'true' : true;
  });
  const [notifPushCheckin, setNotifPushCheckin] = useState(() => {
    const saved = localStorage.getItem('px_notif_push');
    return saved !== null ? saved === 'true' : true;
  });
  const [notifAdminAlerts, setNotifAdminAlerts] = useState(() => {
    const saved = localStorage.getItem('px_notif_admin_alerts');
    return saved !== null ? saved === 'true' : true;
  });

  const handleSaveNotifPreferences = () => {
    try {
      localStorage.setItem('px_notif_webhooks', String(notifWebhooksEnabled));
      localStorage.setItem('px_notif_email', String(notifEmailConfirmation));
      localStorage.setItem('px_notif_push', String(notifPushCheckin));
      localStorage.setItem('px_notif_admin_alerts', String(notifAdminAlerts));
    } catch {
      // ignore
    }
    setNotifSavingNotice(true);
    if (notifNoticeTimeoutRef.current) clearTimeout(notifNoticeTimeoutRef.current);
    notifNoticeTimeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) setNotifSavingNotice(false);
    }, 3000);
  };

  useEffect(() => {
    isMountedRef.current = true;
    const abortController = new AbortController();

    setIsLoadingConfig(true);
    setLoadError(null);

    fetchPaymentSettings(abortController.signal)
      .then((data) => {
        if (!isMountedRef.current) return;
        setServerStatus(data);
        const mapped = mapServerResponseToMercadoPagoConfig(data, initialConfig);
        setConfig(mapped);
        onSave(mapped);
      })
      .catch((err: any) => {
        if (err?.name === 'AbortError' || !isMountedRef.current) return;
        console.warn('[PX CUSTON] Erro ao carregar configurações de pagamento do servidor:', err);
        setLoadError(err?.message || 'Não foi possível sincronizar as configurações de pagamento com o servidor.');
      })
      .finally(() => {
        if (isMountedRef.current) {
          setIsLoadingConfig(false);
        }
      });

    return () => {
      isMountedRef.current = false;
      abortController.abort();
      if (saveNoticeTimeoutRef.current) clearTimeout(saveNoticeTimeoutRef.current);
      if (notifNoticeTimeoutRef.current) clearTimeout(notifNoticeTimeoutRef.current);
    };
  }, []);

  const handleTestConnection = async () => {
    setTestResult('Verificando status das credenciais no servidor...');
    try {
      const data = await fetchPaymentSettings();
      if (!isMountedRef.current) return;
      setServerStatus(data);
      if (data.configured) {
        setTestResult(
          `✓ Conexão operacional! MP_ACCESS_TOKEN configurado no servidor (Ambiente efetivo: ${
            data.effective_environment === 'production' ? 'Produção Real' : 'Sandbox'
          }).`
        );
      } else {
        setTestResult(
          'ℹ️ Modo Homologação ativo. MP_ACCESS_TOKEN ausente nas variáveis de ambiente do servidor Hostinger. Configure MP_ACCESS_TOKEN no .env do servidor para transações reais.'
        );
      }
    } catch (e: any) {
      if (!isMountedRef.current) return;
      setTestResult('❌ Falha ao verificar conexão com o backend: ' + (e?.message || 'Erro de rede'));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving || isLoadingConfig) return;

    setSaveError(null);
    setSavingNotice(false);

    if (!config.pix_enabled) {
      setSaveError('O método Pix Imediato deve permanecer habilitado enquanto Cartão e Boleto estiverem em homologação.');
      return;
    }

    setIsSaving(true);

    try {
      const result = await savePaymentSettings({
        environment: config.environment,
        public_key: config.public_key,
        pix_enabled: config.pix_enabled,
        pix_instant_enabled: config.pix_enabled,
        credit_card_enabled: false,
        boleto_enabled: false,
      });

      if (!isMountedRef.current) return;

      setLoadError(null);
      setSaveError(null);
      setServerStatus(result.status);
      setConfig(result.config);
      onSave(result.config);
      setSavingNotice(true);

      if (saveNoticeTimeoutRef.current) clearTimeout(saveNoticeTimeoutRef.current);
      saveNoticeTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          setSavingNotice(false);
        }
      }, 4000);
    } catch (err: any) {
      if (!isMountedRef.current) return;
      setSaveError(err?.message || 'Falha ao salvar as configurações de pagamento no servidor.');
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#000000] text-white py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Top Breadcrumb & Title */}
        <div className="flex items-center justify-between border-b border-[#1c1c1c] pb-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('admin_dashboard')}
              className="p-2 bg-[#121212] hover:bg-[#1a1a1a] border border-[#262626] rounded-xl text-zinc-300 hover:text-white transition"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-xl font-black uppercase tracking-tight text-white font-heading">
                Configurações do Sistema
              </h1>
              <p className="text-xs text-zinc-400">
                Gestão autoritativa de pagamentos Mercado Pago, credenciais e canais de notificação
              </p>
            </div>
          </div>

          <span className="text-xs font-mono font-bold bg-[#141414] text-[#FF1A2D] border border-[#2a2a2a] px-3 py-1.5 rounded-lg hidden sm:block">
            PX CONTROL v2.0
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
          {/* Left Settings Sidebar */}
          <div className="md:col-span-3 space-y-1 bg-[#121212] border border-[#222] p-3 rounded-2xl text-xs h-fit">
            <button
              onClick={() => setSettingsTab('payments')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-bold flex items-center gap-3 transition ${
                settingsTab === 'payments'
                  ? 'bg-[#FF1A2D] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <CreditCard className="w-4 h-4" />
              <span>Pagamentos (Mercado Pago)</span>
            </button>

            <button
              onClick={() => setSettingsTab('notifications')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 transition ${
                settingsTab === 'notifications'
                  ? 'bg-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <Bell className="w-4 h-4" />
              <span>Notificações (Preferências Locais)</span>
            </button>

            <button
              onClick={() => setSettingsTab('branding')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 transition ${
                settingsTab === 'branding'
                  ? 'bg-[#FF1A2D] text-white font-bold shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                  : 'text-zinc-400 hover:text-white hover:bg-[#181818]'
              }`}
            >
              <Palette className="w-4 h-4" />
              <span>Identidade & Ícone PWA</span>
            </button>

            <button
              onClick={() => onNavigate('admin_cache')}
              className="w-full text-left px-3.5 py-2.5 rounded-xl font-medium flex items-center gap-3 text-zinc-400 hover:text-white hover:bg-[#181818]"
            >
              <Wrench className="w-4 h-4" />
              <span>Manutenções & Cache</span>
            </button>
          </div>

          {/* Right Configuration Panel */}
          <div className="md:col-span-9 bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-8 space-y-6">
            {/* ABA 1: CONFIGURAÇÕES DE PAGAMENTO MERCADO PAGO */}
            {settingsTab === 'payments' && (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#222] pb-5">
                  <div>
                    <h2 className="text-xl font-black uppercase tracking-tight text-white font-heading">
                      Mercado Pago — Integração Oficial
                    </h2>
                    <p className="text-xs text-zinc-400 mt-1">
                      Processamento transparente via Pix imediato e Cartão de Crédito.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {serverStatus?.configured ? (
                      <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-3 py-1.5 rounded-full">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>
                          Servidor Conectado ({serverStatus.effective_environment === 'production' ? 'Produção' : 'Sandbox'})
                        </span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs font-bold text-amber-400 bg-amber-950/40 border border-amber-500/30 px-3 py-1.5 rounded-full">
                        <AlertTriangle className="w-4 h-4" /> Modo Homologação (Sem MP_ACCESS_TOKEN)
                      </span>
                    )}
                  </div>
                </div>

                {/* Banner de Segurança Autorizada */}
                <div className="bg-[#181818] border border-[#262626] rounded-2xl p-4 flex items-start gap-3 text-xs text-zinc-300">
                  <Lock className="w-5 h-5 text-[#FF1A2D] shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-white uppercase text-[11px] tracking-wider">
                      Arquitetura de Segurança de Produção
                    </p>
                    <p className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">
                      Credenciais sensíveis (<code>MP_ACCESS_TOKEN</code> e <code>MP_WEBHOOK_SECRET</code>) nunca são expostas ao frontend. Elas residem exclusivamente no backend Node.js / Express e variáveis de ambiente da Hostinger.
                    </p>
                  </div>
                </div>

                {/* Estado de carregamento inicial */}
                {isLoadingConfig && (
                  <div className="bg-[#181818] border border-[#262626] text-zinc-300 text-xs p-3.5 rounded-xl flex items-center gap-2.5">
                    <Loader2 className="w-4 h-4 text-[#FF1A2D] animate-spin shrink-0" />
                    <span>Carregando configurações persistidas do servidor...</span>
                  </div>
                )}

                {/* Erro de carregamento */}
                {loadError && (
                  <div className="bg-red-950/50 border border-red-500/50 text-red-200 text-xs p-3.5 rounded-xl flex items-center gap-2.5">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                    <span>{loadError}</span>
                  </div>
                )}

                {/* Aviso explícito quando a preferência é 'production' mas MP_ACCESS_TOKEN não está ativo no servidor */}
                {(serverStatus?.environment_warning ||
                  (config.environment === 'production' && serverStatus && !serverStatus.configured)) && (
                  <div className="bg-amber-950/40 border border-amber-500/40 text-amber-200 text-xs p-4 rounded-2xl flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold uppercase tracking-wider text-amber-300 text-[11px]">
                        Divergência entre Preferência Salva e Ambiente Efetivo do Servidor
                      </p>
                      <p className="text-[11px] text-zinc-300 leading-relaxed">
                        {serverStatus?.environment_warning ||
                          'A preferência administrativa está definida como Produção Real, porém a variável secreta MP_ACCESS_TOKEN ainda não está configurada no backend. O modo operacional efetivo permanece em Homologação até que a credencial seja definida no servidor.'}
                      </p>
                    </div>
                  </div>
                )}

                {/* Mensagem de erro ao salvar */}
                {saveError && (
                  <div className="bg-red-950/50 border border-red-500/50 text-red-200 text-xs p-3.5 rounded-xl flex items-center gap-2.5">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                    <span>{saveError}</span>
                  </div>
                )}

                {/* Confirmação real do servidor após salvar */}
                {savingNotice && (
                  <div className="bg-emerald-950/50 border border-emerald-500/50 text-emerald-200 text-xs p-3.5 rounded-xl flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>
                      Configurações persistidas com sucesso no servidor!
                      {serverStatus?.updated_at
                        ? ` (Atualizado em ${new Date(serverStatus.updated_at).toLocaleTimeString('pt-BR')})`
                        : ''}
                    </span>
                  </div>
                )}

                {testResult && (
                  <div
                    className={`text-xs p-3.5 rounded-xl border ${
                      testResult.startsWith('✓')
                        ? 'bg-emerald-950/50 border-emerald-500/50 text-emerald-200'
                        : testResult.startsWith('ℹ️')
                        ? 'bg-amber-950/50 border-amber-500/50 text-amber-200'
                        : 'bg-red-950/50 border-red-500/50 text-red-200'
                    }`}
                  >
                    {testResult}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Ambiente */}
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-300 uppercase tracking-wider block">
                      Ambiente Alvo Preferencial
                    </label>
                    <div className="grid grid-cols-2 gap-4 max-w-md">
                      <button
                        type="button"
                        disabled={isLoadingConfig || isSaving}
                        onClick={() => setConfig({ ...config, environment: 'sandbox' })}
                        className={`p-3 rounded-xl border text-xs font-bold uppercase transition flex items-center justify-center gap-2 disabled:opacity-50 ${
                          config.environment === 'sandbox'
                            ? 'bg-[#FF1A2D] border-[#FF1A2D] text-white shadow'
                            : 'bg-[#181818] border-[#2a2a2a] text-zinc-400 hover:text-white'
                        }`}
                      >
                        Sandbox (Testes)
                      </button>
                      <button
                        type="button"
                        disabled={isLoadingConfig || isSaving}
                        onClick={() => setConfig({ ...config, environment: 'production' })}
                        className={`p-3 rounded-xl border text-xs font-bold uppercase transition flex items-center justify-center gap-2 disabled:opacity-50 ${
                          config.environment === 'production'
                            ? 'bg-[#FF1A2D] border-[#FF1A2D] text-white shadow'
                            : 'bg-[#181818] border-[#2a2a2a] text-zinc-400 hover:text-white'
                        }`}
                      >
                        Produção Real
                      </button>
                    </div>
                    <p className="text-[11px] text-zinc-500">
                      A ativação efetiva da Produção Real exige <code>MP_ACCESS_TOKEN</code> válido configurado nas variáveis de ambiente do servidor.
                    </p>
                  </div>

                  {/* Public Key */}
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-300 uppercase tracking-wider block">
                      Chave Pública (Public Key)
                    </label>
                    <div className="relative">
                      <Key className="w-4 h-4 text-zinc-500 absolute left-3.5 top-3.5" />
                      <input
                        type="text"
                        placeholder="APP_USR-..."
                        disabled={isLoadingConfig || isSaving}
                        value={config.public_key}
                        onChange={(e) => setConfig({ ...config, public_key: e.target.value })}
                        className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl pl-10 pr-3.5 py-3 text-xs text-white font-mono disabled:opacity-50"
                      />
                    </div>
                    <p className="text-[11px] text-zinc-500">
                      Utilizada no frontend pelo SDK do Mercado Pago para tokenização de cartão (iniciada por <code>APP_USR-</code> ou <code>TEST-</code>). Nunca insira seu Access Token privado neste campo.
                    </p>
                  </div>

                  {/* Métodos de Pagamento */}
                  <div className="space-y-3 pt-4 border-t border-[#222]">
                    <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider">
                      Métodos de Pagamento Habilitados no Checkout
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                      <div className="bg-[#181818] border border-[#262626] p-3 rounded-xl flex items-center justify-between">
                        <div>
                          <span className="font-bold text-white block">Pix Imediato</span>
                          <span className="text-[10px] text-emerald-400">API Oficial /v1/payments ativa</span>
                        </div>
                        <input
                          type="checkbox"
                          disabled={isLoadingConfig || isSaving}
                          checked={config.pix_enabled}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              pix_enabled: e.target.checked,
                              pix_instant_enabled: e.target.checked,
                            })
                          }
                          className="w-4 h-4 accent-[#FF1A2D]"
                        />
                      </div>

                      <div className="bg-[#141414] border border-[#222] p-3 rounded-xl flex items-center justify-between opacity-65">
                        <div>
                          <span className="font-bold text-zinc-400 block">Cartão de Crédito</span>
                          <span className="text-[10px] text-amber-400">Bloqueado (Em Homologação)</span>
                        </div>
                        <input
                          type="checkbox"
                          disabled={true}
                          checked={false}
                          readOnly
                          className="w-4 h-4 accent-zinc-600 cursor-not-allowed"
                        />
                      </div>

                      <div className="bg-[#141414] border border-[#222] p-3 rounded-xl flex items-center justify-between opacity-65">
                        <div>
                          <span className="font-bold text-zinc-400 block">Boleto Bancário</span>
                          <span className="text-[10px] text-amber-400">Bloqueado (Em Homologação)</span>
                        </div>
                        <input
                          type="checkbox"
                          disabled={true}
                          checked={false}
                          readOnly
                          className="w-4 h-4 accent-zinc-600 cursor-not-allowed"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-3 pt-4">
                    <button
                      type="submit"
                      disabled={isSaving || isLoadingConfig}
                      className="bg-[#FF1A2D] hover:bg-[#e00f21] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold uppercase tracking-wider px-6 py-3 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition flex items-center gap-2"
                    >
                      {isSaving ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Salvando no Servidor...</span>
                        </>
                      ) : (
                        <>
                          <Save className="w-4 h-4" />
                          <span>Salvar Configurações</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={isSaving || isLoadingConfig}
                      onClick={handleTestConnection}
                      className="bg-[#181818] hover:bg-[#222] disabled:opacity-50 border border-[#2a2a2a] text-zinc-300 text-xs font-semibold px-5 py-3 rounded-xl transition flex items-center gap-2"
                    >
                      <RefreshCw className="w-4 h-4 text-[#FF1A2D]" />
                      <span>Testar Conexão</span>
                    </button>
                  </div>
                </form>
              </>
            )}

            {/* ABA 2: NOTIFICAÇÕES & WEBHOOKS */}
            {settingsTab === 'notifications' && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#222] pb-5">
                  <div>
                    <h2 className="text-xl font-black uppercase tracking-tight text-white font-heading flex items-center gap-2.5">
                      <Bell className="w-5 h-5 text-[#FF1A2D]" />
                      <span>Preferências de Notificação & Webhooks</span>
                    </h2>
                    <p className="text-xs text-zinc-400 mt-1">
                      Opções de interface armazenadas exclusivamente no navegador deste dispositivo.
                    </p>
                  </div>
                </div>

                {/* Banner de esclarecimento de arquitetura */}
                <div className="bg-[#181818] border border-[#262626] rounded-2xl p-4 flex items-start gap-3 text-xs text-zinc-300">
                  <ShieldCheck className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-white uppercase text-[11px] tracking-wider">
                      Armazenamento Local no Navegador (localStorage)
                    </p>
                    <p className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">
                      As marcações abaixo representam apenas preferências salvas no navegador local e <strong>não alteram nem ativam serviços no servidor Node.js ou na Hostinger</strong>. Webhooks oficiais, envio SMTP de e-mails e chaves Push dependem de infraestrutura de servidor e variáveis de ambiente no backend.
                    </p>
                  </div>
                </div>

                {notifSavingNotice && (
                  <div className="bg-emerald-950/50 border border-emerald-500/50 text-emerald-200 text-xs p-3.5 rounded-xl flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Preferências locais salvas no navegador com sucesso! (Nenhuma alteração foi enviada ao servidor)</span>
                  </div>
                )}

                <div className="space-y-4">
                  {/* Webhook Mercado Pago */}
                  <div className="bg-[#181818] border border-[#262626] p-5 rounded-2xl space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-[#222] border border-[#333] flex items-center justify-center text-[#FF1A2D]">
                          <CreditCard className="w-5 h-5" />
                        </div>
                        <div>
                          <h4 className="text-xs font-bold text-white uppercase">
                            Webhook Mercado Pago (/api/payments/webhook)
                          </h4>
                          <p className="text-[11px] text-zinc-400">
                            Preferência local de monitoramento. O recebimento real de notificações deve ser apontado no portal de desenvolvedores do Mercado Pago para a URL pública do seu servidor.
                          </p>
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={notifWebhooksEnabled}
                        onChange={(e) => setNotifWebhooksEnabled(e.target.checked)}
                        className="w-4 h-4 accent-[#FF1A2D]"
                      />
                    </div>
                    <div className="bg-[#121212] p-3 rounded-xl text-[11px] font-mono text-zinc-300 border border-[#222] flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
                      <span>Endpoint cadastrado no backend: /api/payments/webhook</span>
                      <span className="text-zinc-500 text-[10px]">Configuração externa no painel Mercado Pago</span>
                    </div>
                  </div>

                  {/* Confirmação por E-mail */}
                  <div className="bg-[#181818] border border-[#262626] p-5 rounded-2xl flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-[#222] border border-[#333] flex items-center justify-center text-[#FF1A2D]">
                        <Mail className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-white uppercase">
                          Notificações de Ingresso ao Cliente (E-mail)
                        </h4>
                        <p className="text-[11px] text-zinc-400">
                          Preferência local. O disparo automático por e-mail necessita de provedor SMTP configurado nas variáveis do servidor.
                        </p>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={notifEmailConfirmation}
                      onChange={(e) => setNotifEmailConfirmation(e.target.checked)}
                      className="w-4 h-4 accent-[#FF1A2D]"
                    />
                  </div>

                  {/* Push Notifications PWA */}
                  <div className="bg-[#181818] border border-[#262626] p-5 rounded-2xl flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-[#222] border border-[#333] flex items-center justify-center text-[#FF1A2D]">
                        <Smartphone className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-white uppercase">
                          Notificações Push no App / PWA
                        </h4>
                        <p className="text-[11px] text-zinc-400">
                          Preferência local do dispositivo. Notificações push em segundo plano requerem credenciais VAPID no servidor.
                        </p>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={notifPushCheckin}
                      onChange={(e) => setNotifPushCheckin(e.target.checked)}
                      className="w-4 h-4 accent-[#FF1A2D]"
                    />
                  </div>

                  {/* Alertas Administrativos */}
                  <div className="bg-[#181818] border border-[#262626] p-5 rounded-2xl flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-[#222] border border-[#333] flex items-center justify-center text-[#FF1A2D]">
                        <Shield className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-white uppercase">
                          Alertas de Segurança PX CONTROL
                        </h4>
                        <p className="text-[11px] text-zinc-400">
                          Preferência local da interface para sinalizar eventos administrativos na sessão do operador.
                        </p>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={notifAdminAlerts}
                      onChange={(e) => setNotifAdminAlerts(e.target.checked)}
                      className="w-4 h-4 accent-[#FF1A2D]"
                    />
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleSaveNotifPreferences}
                    className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-6 py-3 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition flex items-center gap-2"
                  >
                    <Save className="w-4 h-4" />
                    <span>Salvar Preferências no Navegador</span>
                  </button>
                </div>
              </div>
            )}

            {/* ABA 3: IDENTIDADE VISUAL E ÍCONE DO PWA */}
            {settingsTab === 'branding' && <AdminBrandingManager />}
          </div>
        </div>
      </div>
    </div>
  );
};
