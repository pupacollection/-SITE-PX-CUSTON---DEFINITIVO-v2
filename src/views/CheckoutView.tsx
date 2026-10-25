import React, { useState, useEffect } from 'react';
import {
  EventItem,
  TicketBatch,
  PaymentMethod,
  Ticket,
  UserProfile,
  ActiveScreen,
  MercadoPagoConfig,
} from '../types';
import { ordersService } from '../services/ordersService';
import {
  fetchPaymentSettings,
  mapServerResponseToMercadoPagoConfig,
} from '../services/paymentSettingsService';
import {
  CreditCard,
  QrCode,
  FileText,
  ShieldCheck,
  CheckCircle2,
  Lock,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  AlertCircle,
  Clock,
  RefreshCw,
  Loader2,
} from 'lucide-react';

function generateClientUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isValidBrazilianCpfClient(rawCpf: string | null | undefined): boolean {
  const digits = String(rawCpf || '').replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  if (digits === '12345678900' || digits === '12345678909') return false;

  let sum1 = 0;
  for (let i = 0; i < 9; i++) {
    sum1 += Number(digits[i]) * (10 - i);
  }
  let check1 = (sum1 * 10) % 11;
  if (check1 === 10) check1 = 0;
  if (check1 !== Number(digits[9])) return false;

  let sum2 = 0;
  for (let i = 0; i < 10; i++) {
    sum2 += Number(digits[i]) * (11 - i);
  }
  let check2 = (sum2 * 10) % 11;
  if (check2 === 10) check2 = 0;
  if (check2 !== Number(digits[10])) return false;

  return true;
}

function formatCpfMask(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

interface CheckoutViewProps {
  event: EventItem;
  selectedBatches: { batch: TicketBatch; quantity: number }[];
  user: UserProfile | null;
  paymentConfig?: MercadoPagoConfig;
  onSuccess: (newTickets: Ticket[]) => void;
  onPaymentApproved?: (orderId: string) => void;
  onCancel: () => void;
  onNavigate: (screen: ActiveScreen) => void;
}

export const CheckoutView: React.FC<CheckoutViewProps> = ({
  event,
  selectedBatches,
  user,
  paymentConfig,
  onSuccess: _onSuccess,
  onPaymentApproved,
  onCancel,
  onNavigate,
}) => {
  const [verifiedPaymentConfig, setVerifiedPaymentConfig] = useState<MercadoPagoConfig | null>(null);
  const [isLoadingPaymentConfig, setIsLoadingPaymentConfig] = useState<boolean>(true);
  const [paymentConfigError, setPaymentConfigError] = useState<string | null>(null);

  const isPaymentConfigVerified =
    !isLoadingPaymentConfig && !paymentConfigError && verifiedPaymentConfig !== null;

  // Fail-closed: nunca apresentar Pix, Cartão ou Boleto como disponíveis se a configuração do servidor não pôde ser carregada.
  // Cartão de Crédito e Boleto permanecem bloqueados até que seus fluxos reais de tokenização/emissão sejam homologados.
  const pixEnabled = isPaymentConfigVerified ? Boolean(verifiedPaymentConfig.pix_enabled) : false;
  const creditCardEnabled = false;
  const boletoEnabled = false;

  const getFirstEnabledMethod = (): PaymentMethod => {
    return 'pix';
  };

  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod>(getFirstEnabledMethod);
  const [processing, setProcessing] = useState(false);
  const [buyerName, setBuyerName] = useState(user?.full_name || '');
  const [buyerEmail, setBuyerEmail] = useState(user?.email || '');
  const [buyerCpf, setBuyerCpf] = useState((user as any)?.cpf ? formatCpfMask((user as any).cpf) : '');
  const [checkoutAttemptId, setCheckoutAttemptId] = useState<string>(() => generateClientUuidV4());
  const [registeredOrder, setRegisteredOrder] = useState<any | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [copiedPix, setCopiedPix] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(900);
  const [isOrderExpired, setIsOrderExpired] = useState(false);
  const [orderPaymentStatus, setOrderPaymentStatus] = useState<'pending' | 'approved' | 'cancelled'>('pending');

  // Sincroniza dados reais do comprador autenticado caso o perfil carregue após a montagem
  useEffect(() => {
    if (user?.full_name && !buyerName) {
      setBuyerName(user.full_name);
    }
    if (user?.email && !buyerEmail) {
      setBuyerEmail(user.email);
    }
    if ((user as any)?.cpf && !buyerCpf) {
      setBuyerCpf(formatCpfMask((user as any).cpf));
    }
  }, [user]);

  // Regenera o identificador de tentativa apenas quando o escopo da compra (evento, lotes ou método) muda antes do registro
  const batchesSignature = selectedBatches
    .map((item) => `${item.batch.id}:${item.quantity}`)
    .sort()
    .join('|');

  useEffect(() => {
    if (!registeredOrder) {
      setCheckoutAttemptId(generateClientUuidV4());
    }
  }, [event.id, selectedMethod, batchesSignature]);

  const loadAuthoritativePaymentConfig = async (signal?: AbortSignal) => {
    setIsLoadingPaymentConfig(true);
    setPaymentConfigError(null);
    try {
      const serverData = await fetchPaymentSettings(signal);
      if (signal?.aborted) return;
      const mapped = mapServerResponseToMercadoPagoConfig(serverData, paymentConfig);
      setVerifiedPaymentConfig(mapped);
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) return;
      setVerifiedPaymentConfig(null);
      setPaymentConfigError(
        err?.message ||
          'Não foi possível verificar os métodos de pagamento disponíveis no servidor.'
      );
    } finally {
      if (!signal?.aborted) {
        setIsLoadingPaymentConfig(false);
      }
    }
  };

  useEffect(() => {
    const abortController = new AbortController();
    loadAuthoritativePaymentConfig(abortController.signal);
    return () => {
      abortController.abort();
    };
  }, []);

  // Garantir que o método selecionado esteja sempre habilitado na configuração verificada atual
  useEffect(() => {
    if (!isPaymentConfigVerified) return;
    const isCurrentAllowed =
      (selectedMethod === 'pix' && pixEnabled) ||
      (selectedMethod === 'credit_card' && creditCardEnabled) ||
      (selectedMethod === 'boleto' && boletoEnabled);

    if (!isCurrentAllowed) {
      setSelectedMethod(getFirstEnabledMethod());
    }
  }, [isPaymentConfigVerified, pixEnabled, creditCardEnabled, boletoEnabled, selectedMethod]);

  // Compute totals
  const subtotal = selectedBatches.reduce(
    (acc, item) => acc + item.batch.price * item.quantity,
    0
  );
  const convenienceFee = subtotal > 0 ? 4.0 : 0;
  const pixDiscount = selectedMethod === 'pix' ? subtotal * 0.05 : 0;
  const total = Math.max(0, subtotal + convenienceFee - pixDiscount);

  // Efeito de contagem regressiva e polling do status do pedido registrado
  useEffect(() => {
    if (!registeredOrder?.order?.id || orderPaymentStatus !== 'pending') return;

    // Calcular segundos restantes com base na data de expiração oficial retornada pelo backend
    const expiresAt = registeredOrder.payment?.expires_at
      ? new Date(registeredOrder.payment.expires_at).getTime()
      : Date.now() + 15 * 60 * 1000;

    const timerInterval = setInterval(() => {
      const now = Date.now();
      const diffSecs = Math.max(0, Math.floor((expiresAt - now) / 1000));
      setSecondsRemaining(diffSecs);
      // Nunca cancela unilateralmente no cliente sem antes reconciliar via polling no servidor
    }, 1000);

    // Polling a cada 5 segundos para verificar confirmação ou cancelamento reconciliado pelo gateway
    const pollingInterval = setInterval(async () => {
      try {
        const statusRes = await ordersService.getOrderStatus(registeredOrder.order.id);
        if (statusRes.status === 'approved') {
          setOrderPaymentStatus('approved');
          clearInterval(pollingInterval);
          clearInterval(timerInterval);
          if (onPaymentApproved) {
            onPaymentApproved(registeredOrder.order.id);
          }
        } else if (statusRes.status === 'cancelled' || (statusRes.expired && !statusRes.reconciliation_pending)) {
          setIsOrderExpired(true);
          setOrderPaymentStatus('cancelled');
          clearInterval(pollingInterval);
          clearInterval(timerInterval);
        }
      } catch (pollErr) {
        // Tolerante a falhas pontuais de conexão
      }
    }, 5000);

    return () => {
      clearInterval(timerInterval);
      clearInterval(pollingInterval);
    };
  }, [registeredOrder, orderPaymentStatus, onPaymentApproved]);

  const handleCheckout = async () => {
    if (processing) return;
    setOrderError(null);

    // 1. Bloqueio Estrito no Frontend: Eventos de demonstração não podem aceitar pedidos comerciais
    if (event.is_demo) {
      setOrderError(
        'Operação bloqueada: Eventos marcados como demonstrativos (DEMO) destinam-se exclusivamente à homologação técnica e não aceitam pagamentos ou vendas reais.'
      );
      return;
    }

    if (!isPaymentConfigVerified || (!pixEnabled && !creditCardEnabled && !boletoEnabled)) {
      setOrderError(
        paymentConfigError ||
          'Operação bloqueada: não foi possível validar os métodos de pagamento disponíveis no servidor.'
      );
      return;
    }

    const trimmedName = buyerName.trim();
    const trimmedEmail = buyerEmail.trim();
    const normalizedCpf = buyerCpf.replace(/\D/g, '');

    if (trimmedName.length < 3) {
      setOrderError('Informe o nome completo do titular do ingresso.');
      return;
    }

    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setOrderError('Informe um endereço de e-mail válido para o envio da confirmação do pedido.');
      return;
    }

    if (!isValidBrazilianCpfClient(normalizedCpf)) {
      setOrderError('Informe um CPF brasileiro válido (11 dígitos com dígitos verificadores reais).');
      return;
    }

    setProcessing(true);

    try {
      // 2. Registro oficial do pedido no backend com order_id idempotente, cálculo autoritativo e reserva atômica de estoque
      const data = await ordersService.createOrder({
        order_id: checkoutAttemptId,
        event_id: event.id,
        event_title: event.title,
        items: selectedBatches.map((item) => ({
          batch_id: item.batch.id,
          batch_name: item.batch.name,
          unit_price: item.batch.price,
          quantity: item.quantity,
        })),
        buyer: {
          id: user?.id,
          name: trimmedName,
          email: trimmedEmail,
          cpf: normalizedCpf,
        },
        payment_method: selectedMethod,
      });

      // O pedido é registrado como PENDENTE (ou aprovado caso já reconciliado).
      setRegisteredOrder(data);
      const returnedStatus = data.payment?.status === 'approved' || data.order?.payment_status === 'approved'
        ? 'approved'
        : 'pending';
      setOrderPaymentStatus(returnedStatus);
      setIsOrderExpired(false);
      setSecondsRemaining(data.payment?.expires_in_seconds || 900);
      if (returnedStatus === 'approved' && onPaymentApproved && data.order?.id) {
        onPaymentApproved(data.order.id);
      }
    } catch (err: any) {
      console.error('Erro ao processar pedido:', err);
      setOrderError(err.message || 'Erro de conexão ao processar pedido.');
    } finally {
      setProcessing(false);
    }
  };

  const formatCountdown = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-[#000000] text-white py-8 sm:py-10 pb-24 md:pb-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Top bar with Back Button & Breadcrumb */}
        <div className="flex items-center justify-between pb-1">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-2 text-xs font-semibold text-zinc-400 hover:text-white bg-[#141414] hover:bg-[#1f1f1f] border border-[#2a2a2a] px-3.5 py-2 rounded-xl transition"
            aria-label="Voltar para a página do evento"
          >
            <ArrowLeft className="w-4 h-4 text-[#FF1A2D]" />
            <span>Voltar ao Evento</span>
          </button>
          <span className="text-xs font-mono text-zinc-500 uppercase tracking-wider hidden sm:block">
            Checkout Seguro
          </span>
        </div>

        {/* Stepper (1 Ingressos -> 2 Pagamento -> 3 Confirmação) */}
        <div className="flex flex-wrap sm:flex-nowrap items-center justify-center gap-2 sm:gap-6 border-b border-[#222] pb-5">
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-xs font-bold flex items-center justify-center shrink-0">
              ✓
            </div>
            <span className="text-[11px] sm:text-xs text-zinc-400 whitespace-nowrap">1. Ingressos</span>
          </div>

          <div className="w-4 sm:w-12 h-px bg-[#FF1A2D] shrink-0"></div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
              registeredOrder
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                : 'bg-[#FF1A2D] text-white shadow-[0_0_10px_rgba(255,26,45,0.6)]'
            }`}>
              {registeredOrder ? '✓' : '2'}
            </div>
            <span className={`text-[11px] sm:text-xs uppercase tracking-wider whitespace-nowrap ${registeredOrder ? 'text-zinc-400' : 'font-bold text-white'}`}>
              2. Pagamento
            </span>
          </div>

          <div className={`w-4 sm:w-12 h-px shrink-0 ${registeredOrder ? 'bg-[#FF1A2D]' : 'bg-[#262626]'}`}></div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
              registeredOrder
                ? 'bg-[#FF1A2D] text-white shadow-[0_0_10px_rgba(255,26,45,0.6)]'
                : 'bg-[#181818] border border-[#333] text-zinc-500'
            }`}>
              3
            </div>
            <span className={`text-[11px] sm:text-xs whitespace-nowrap ${registeredOrder ? 'font-bold text-white uppercase tracking-wider' : 'text-zinc-500'}`}>
              3. Confirmação
            </span>
          </div>
        </div>

        {/* Notificação de Evento Demonstrativo */}
        {event.is_demo && (
          <div className="bg-amber-950/40 border border-amber-500/40 p-4 rounded-2xl flex items-center gap-3 text-amber-200 text-xs">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
            <div>
              <span className="font-bold uppercase tracking-wider block">Evento de Demonstração (Homologação Técnica)</span>
              <span className="text-zinc-300">
                Este evento possui caráter puramente demonstrativo (is_demo = true). Compras comerciais e emissão de ingressos oficiais estão desabilitadas para demonstrações.
              </span>
            </div>
          </div>
        )}

        {/* Mensagem de Erro */}
        {orderError && (
          <div className="bg-red-950/40 border border-[#FF1A2D]/40 p-4 rounded-2xl flex items-center gap-3 text-red-200 text-xs">
            <AlertCircle className="w-5 h-5 text-[#FF1A2D] shrink-0" />
            <span>{orderError}</span>
          </div>
        )}

        {/* TELA DE PEDIDO REGISTRADO (STATUS PENDENTE OU CONCLUÍDO) */}
        {registeredOrder ? (
          <div className="bg-[#121212] border border-[#222] rounded-3xl p-5 sm:p-8 space-y-6 max-w-2xl mx-auto">
            <div className="text-center space-y-2">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto border ${
                orderPaymentStatus === 'approved'
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                  : isOrderExpired || orderPaymentStatus === 'cancelled'
                  ? 'bg-red-500/20 text-[#FF1A2D] border-[#FF1A2D]/40'
                  : 'bg-amber-500/20 text-amber-400 border-amber-500/40'
              }`}>
                {orderPaymentStatus === 'approved' ? (
                  <CheckCircle2 className="w-6 h-6" />
                ) : isOrderExpired || orderPaymentStatus === 'cancelled' ? (
                  <AlertCircle className="w-6 h-6" />
                ) : (
                  <Clock className="w-6 h-6 animate-pulse" />
                )}
              </div>

              <h2 className="text-xl font-black uppercase text-white font-heading">
                {orderPaymentStatus === 'approved'
                  ? 'Pagamento Confirmado!'
                  : isOrderExpired || orderPaymentStatus === 'cancelled'
                  ? 'Tempo Limite Expirado'
                  : 'Pedido Registrado com Sucesso!'}
              </h2>
              <p className="text-xs text-zinc-400 break-all">
                Código do Pedido: <span className="font-mono text-white font-bold">{registeredOrder.order?.id}</span>
              </p>

              {orderPaymentStatus === 'approved' ? (
                <div className="inline-flex items-center gap-1.5 px-3.5 py-1 bg-emerald-500/20 border border-emerald-500/30 rounded-full text-emerald-300 text-xs font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Ingressos emitidos oficialmente com validação QR Code</span>
                </div>
              ) : isOrderExpired || orderPaymentStatus === 'cancelled' ? (
                <div className="inline-flex items-center gap-1.5 px-3.5 py-1 bg-red-500/20 border border-[#FF1A2D]/40 rounded-full text-red-300 text-xs font-semibold">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>Pedido Cancelado — Estoque liberado automaticamente</span>
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded-full text-amber-300 text-xs font-semibold">
                  <Clock className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                  <span>Aguardando Pagamento — Expira em: <strong className="font-mono text-white">{formatCountdown(secondsRemaining)}</strong></span>
                </div>
              )}
            </div>

            {/* Banner de Aviso de Expiração caso cancelado */}
            {(isOrderExpired || orderPaymentStatus === 'cancelled') && (
              <div className="bg-red-950/30 border border-[#FF1A2D]/30 p-4 rounded-2xl flex items-start gap-3 text-xs text-zinc-300">
                <AlertCircle className="w-5 h-5 text-[#FF1A2D] shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold text-white uppercase tracking-wider">Prazo de Pagamento Encerrado</p>
                  <p className="text-zinc-400">
                    O tempo de reserva temporária de 15 minutos foi atingido. Para evitar indisponibilidade injusta, os ingressos deste pedido retornaram automaticamente ao estoque do evento.
                  </p>
                </div>
              </div>
            )}

            {/* Detalhes do Pagamento */}
            <div className="bg-[#181818] border border-[#262626] rounded-2xl p-4 sm:p-5 space-y-4">
              <div className="flex justify-between items-center gap-2 text-xs pb-3 border-b border-[#222]">
                <span className="text-zinc-400 shrink-0">Evento:</span>
                <span className="font-bold text-white text-right truncate">{event.title}</span>
              </div>
              <div className="flex justify-between items-center gap-2 text-xs pb-3 border-b border-[#222]">
                <span className="text-zinc-400">Valor Total:</span>
                <span className="font-bold text-[#FF1A2D] text-sm">
                  R$ {registeredOrder.order?.total?.toFixed(2)?.replace('.', ',')}
                </span>
              </div>
              <div className="flex justify-between items-center gap-2 text-xs pb-3 border-b border-[#222]">
                <span className="text-zinc-400">Forma de Pagamento:</span>
                <span className="font-bold uppercase text-white">{registeredOrder.order?.payment_method}</span>
              </div>

              {/* Seção QR Code Oficial e Pix Copia e Cola (Apenas se pendente e não expirado) */}
              {orderPaymentStatus === 'pending' && !isOrderExpired && registeredOrder.payment?.pix_copy_paste && (
                <div className="pt-2 space-y-3">
                  {registeredOrder.payment?.pix_qr_code_base64 && (
                    <div className="flex flex-col items-center justify-center bg-[#111] border border-[#2a2a2a] rounded-2xl p-4 space-y-2">
                      <img
                        src={`data:image/png;base64,${registeredOrder.payment.pix_qr_code_base64}`}
                        alt="QR Code Pix Oficial Mercado Pago"
                        className="w-44 h-44 rounded-xl bg-white p-2 object-contain"
                      />
                      <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
                        Escaneie o QR Code no aplicativo do seu banco
                      </span>
                    </div>
                  )}
                  <div className="flex flex-wrap justify-between items-center gap-1">
                    <label className="text-[10px] text-zinc-400 uppercase font-semibold">
                      Código Pix Copia e Cola (Mercado Pago)
                    </label>
                    <span className="text-[10px] font-mono text-amber-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Expira em {formatCountdown(secondsRemaining)}
                    </span>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      readOnly
                      value={registeredOrder.payment.pix_copy_paste}
                      className="w-full bg-[#111] border border-[#333] rounded-xl px-3 py-2 text-xs font-mono text-zinc-300 select-all"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(registeredOrder.payment.pix_copy_paste);
                        setCopiedPix(true);
                        setTimeout(() => setCopiedPix(false), 3000);
                      }}
                      className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold px-4 py-2.5 sm:py-2 rounded-xl whitespace-nowrap transition shrink-0"
                    >
                      {copiedPix ? 'Copiado!' : 'Copiar Pix'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Aviso de Segurança de Emissão Real */}
            <div className="bg-[#181818] border border-[#262626] p-4 rounded-xl flex items-start gap-3 text-xs text-zinc-400">
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-zinc-200 block mb-0.5">Garantia Transacional & Anti-Duplicação</span>
                <span>
                  {orderPaymentStatus === 'approved'
                    ? 'Seus ingressos digitais foram gerados com código seguro único e QR payload oficial para o terminal PX CONTROL Check-in.'
                    : 'O estoque permanece garantido durante a contagem de 15 minutos. Após a compensação confirmada pelo Mercado Pago via webhook, os ingressos serão emitidos automaticamente.'}
                </span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              {isOrderExpired || orderPaymentStatus === 'cancelled' ? (
                <>
                  <button
                    onClick={() => {
                      setCheckoutAttemptId(generateClientUuidV4());
                      setRegisteredOrder(null);
                      setIsOrderExpired(false);
                      setOrderPaymentStatus('pending');
                    }}
                    className="flex-1 bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider py-3 rounded-xl transition text-center flex items-center justify-center gap-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Tentar Novamente</span>
                  </button>
                  <button
                    onClick={() => onNavigate('events')}
                    className="flex-1 bg-[#181818] border border-[#2a2a2a] hover:bg-[#222] text-zinc-300 text-xs font-semibold py-3 rounded-xl transition text-center"
                  >
                    Voltar aos Eventos
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => onNavigate('profile')}
                    className="flex-1 bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider py-3 rounded-xl transition text-center"
                  >
                    {orderPaymentStatus === 'approved' ? 'Visualizar Meus Ingressos' : 'Acompanhar no Meu Perfil'}
                  </button>
                  <button
                    onClick={() => onNavigate('events')}
                    className="flex-1 bg-[#181818] border border-[#2a2a2a] hover:bg-[#222] text-zinc-300 text-xs font-semibold py-3 rounded-xl transition text-center"
                  >
                    Voltar aos Eventos
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          /* Content Grid */
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
          {/* Left Column: Resumo do Pedido */}
          <div className="md:col-span-5 bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-7 space-y-5">
            <h3 className="text-sm font-black uppercase tracking-wider text-white font-heading">
              Resumo do Pedido
            </h3>

            {/* Event Header in Summary */}
            <div className="bg-[#181818] border border-[#262626] p-3.5 rounded-2xl flex items-center gap-3">
              <img
                src={event.cover_image}
                alt={event.title}
                className="w-14 h-14 rounded-xl object-cover shrink-0"
              />
              <div className="min-w-0">
                <h4 className="text-xs font-black uppercase text-white truncate">{event.title}</h4>
                <p className="text-[11px] text-zinc-400 mt-0.5">{event.formatted_date}</p>
                <p className="text-[10px] text-zinc-500 truncate">{event.city}/{event.state}</p>
              </div>
            </div>

            {/* Selected Items */}
            <div className="space-y-2.5 pt-2 border-t border-[#1e1e1e]">
              {selectedBatches.map((item) => (
                <div key={item.batch.id} className="flex items-center justify-between text-xs">
                  <div>
                    <span className="font-semibold text-zinc-200">{item.batch.name}</span>
                    <span className="text-zinc-500 block text-[11px]">{item.quantity} unidade(s)</span>
                  </div>
                  <span className="font-bold text-white">
                    R$ {(item.batch.price * item.quantity).toFixed(2).replace('.', ',')}
                  </span>
                </div>
              ))}
            </div>

            {/* Calculations Breakdown */}
            <div className="pt-4 border-t border-[#1e1e1e] space-y-2 text-xs">
              <div className="flex justify-between text-zinc-400">
                <span>Subtotal</span>
                <span>R$ {subtotal.toFixed(2).replace('.', ',')}</span>
              </div>
              <div className="flex justify-between text-zinc-400">
                <span>Taxa de conveniência</span>
                <span>R$ {convenienceFee.toFixed(2).replace('.', ',')}</span>
              </div>
              {pixDiscount > 0 && (
                <div className="flex justify-between text-emerald-400 font-semibold">
                  <span>Desconto Pix (5%)</span>
                  <span>- R$ {pixDiscount.toFixed(2).replace('.', ',')}</span>
                </div>
              )}
              <div className="pt-3 border-t border-[#262626] flex justify-between items-center text-sm font-black">
                <span className="uppercase text-white">Total</span>
                <span className="text-[#FF1A2D] text-lg">
                  R$ {total.toFixed(2).replace('.', ',')}
                </span>
              </div>
            </div>

            {/* Security Notice */}
            <div className="bg-[#181818] border border-[#262626] p-3 rounded-xl flex items-center gap-2 text-[11px] text-zinc-400">
              <Lock className="w-3.5 h-3.5 text-[#FF1A2D] shrink-0" />
              <span>Ambiente criptografado. Seus dados nunca são compartilhados.</span>
            </div>
          </div>

          {/* Right Column: Métodos de Pagamento Mercado Pago */}
          <div className="md:col-span-7 bg-[#121212] border border-[#222] rounded-3xl p-6 sm:p-7 space-y-6">
            <div className="flex items-center justify-between border-b border-[#222] pb-4">
              <div>
                <h3 className="text-base font-black uppercase tracking-tight text-white font-heading">
                  Pagamento Oficial
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5">Escolha uma forma de pagamento</p>
              </div>

              {/* Mercado Pago Badge */}
              <div className="flex items-center gap-2 bg-[#009ee3]/10 border border-[#009ee3]/30 px-3 py-1.5 rounded-xl">
                <div className="w-2 h-2 rounded-full bg-[#009ee3] animate-pulse"></div>
                <span className="text-xs font-bold text-[#009ee3] tracking-wide">
                  mercado pago
                </span>
              </div>
            </div>

            {/* Buyer Details */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1">
                  Nome do Titular
                </label>
                <input
                  type="text"
                  placeholder="Nome completo do comprador"
                  value={buyerName}
                  onChange={(e) => setBuyerName(e.target.value)}
                  className="w-full bg-[#181818] border border-[#2a2a2a] rounded-xl px-3 py-2 text-xs text-white placeholder:text-zinc-600"
                />
              </div>
              <div>
                <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1">
                  CPF do Titular
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="000.000.000-00"
                  value={buyerCpf}
                  onChange={(e) => setBuyerCpf(formatCpfMask(e.target.value))}
                  className="w-full bg-[#181818] border border-[#2a2a2a] rounded-xl px-3 py-2 text-xs text-white placeholder:text-zinc-600 font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[10px] text-zinc-400 uppercase font-semibold block mb-1">
                  E-mail do Comprador
                </label>
                <input
                  type="email"
                  placeholder="seuemail@dominio.com.br"
                  value={buyerEmail}
                  onChange={(e) => setBuyerEmail(e.target.value)}
                  className="w-full bg-[#181818] border border-[#2a2a2a] rounded-xl px-3 py-2 text-xs text-white placeholder:text-zinc-600"
                />
              </div>
            </div>

            {/* Payment Method Selector (Pix, Cartão, Boleto) */}
            <div className="space-y-3">
              {isLoadingPaymentConfig && (
                <div className="bg-[#181818] border border-[#262626] p-4 rounded-2xl flex items-center gap-3 text-xs text-zinc-300">
                  <Loader2 className="w-4 h-4 text-[#FF1A2D] animate-spin shrink-0" />
                  <span>Verificando métodos de pagamento disponíveis no servidor...</span>
                </div>
              )}

              {!isLoadingPaymentConfig && (paymentConfigError || !isPaymentConfigVerified) && (
                <div className="bg-red-950/40 border border-red-500/40 p-4 rounded-2xl space-y-3 text-xs text-red-200">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold uppercase tracking-wider text-red-300 text-[11px]">
                        Métodos de Pagamento Indisponíveis no Momento
                      </p>
                      <p className="text-[11px] text-zinc-300 leading-relaxed">
                        {paymentConfigError ||
                          'Não foi possível carregar as configurações de pagamento do servidor. Nenhum método de pagamento pode ser exibido ou utilizado até que a validação seja concluída.'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => loadAuthoritativePaymentConfig()}
                    className="bg-[#181818] hover:bg-[#222] border border-[#2a2a2a] text-white font-semibold text-[11px] px-3.5 py-2 rounded-xl transition flex items-center gap-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-[#FF1A2D]" />
                    <span>Tentar Novamente</span>
                  </button>
                </div>
              )}

              {/* Option 1: Pix */}
              {pixEnabled && (
                <div
                  onClick={() => setSelectedMethod('pix')}
                  className={`cursor-pointer p-4 rounded-2xl border transition flex items-center justify-between ${
                    selectedMethod === 'pix'
                      ? 'bg-[#181818] border-[#FF1A2D] shadow-[0_0_15px_rgba(255,26,45,0.2)]'
                      : 'bg-[#151515] border-[#262626] hover:border-[#383838]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                        selectedMethod === 'pix'
                          ? 'border-[#FF1A2D] bg-[#FF1A2D]'
                          : 'border-[#444]'
                      }`}
                    >
                      {selectedMethod === 'pix' && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white uppercase">Pix</span>
                        <span className="text-[10px] bg-emerald-500/20 text-emerald-400 font-bold px-2 py-0.5 rounded-full border border-emerald-500/30">
                          5% de desconto
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        Aprovação imediata e emissão automática do QR Code
                      </p>
                    </div>
                  </div>
                  <QrCode className="w-5 h-5 text-emerald-400" />
                </div>
              )}

              {/* Option 2: Cartão de Crédito (Bloqueado até implementação do fluxo real) */}
              {isPaymentConfigVerified && (
                <div
                  aria-disabled="true"
                  className="opacity-60 cursor-not-allowed p-4 rounded-2xl border bg-[#141414] border-[#222] flex items-center justify-between select-none"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 rounded-full border border-[#333] flex items-center justify-center bg-[#1a1a1a]">
                      <Lock className="w-2.5 h-2.5 text-zinc-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-zinc-400 uppercase">Cartão de Crédito</span>
                        <span className="text-[10px] bg-zinc-800 text-zinc-400 font-semibold px-2 py-0.5 rounded-full border border-zinc-700">
                          Indisponível (Em Homologação)
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-0.5">
                        Temporariamente bloqueado. Utilize o pagamento imediato via Pix.
                      </p>
                    </div>
                  </div>
                  <CreditCard className="w-5 h-5 text-zinc-600" />
                </div>
              )}

              {/* Option 3: Boleto Bancário (Bloqueado até implementação do fluxo real) */}
              {isPaymentConfigVerified && (
                <div
                  aria-disabled="true"
                  className="opacity-60 cursor-not-allowed p-4 rounded-2xl border bg-[#141414] border-[#222] flex items-center justify-between select-none"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 rounded-full border border-[#333] flex items-center justify-center bg-[#1a1a1a]">
                      <Lock className="w-2.5 h-2.5 text-zinc-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-zinc-400 uppercase">Boleto Bancário</span>
                        <span className="text-[10px] bg-zinc-800 text-zinc-400 font-semibold px-2 py-0.5 rounded-full border border-zinc-700">
                          Indisponível (Em Homologação)
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-0.5">
                        Temporariamente bloqueado. Utilize o pagamento imediato via Pix.
                      </p>
                    </div>
                  </div>
                  <FileText className="w-5 h-5 text-zinc-600" />
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="pt-4 space-y-3">
              <button
                onClick={handleCheckout}
                disabled={processing || subtotal === 0 || event.is_demo || !isPaymentConfigVerified}
                className="w-full bg-[#FF1A2D] hover:bg-[#e00f21] disabled:opacity-50 text-white font-bold text-xs uppercase tracking-wider py-3.5 rounded-xl shadow-[0_0_20px_rgba(255,26,45,0.45)] transition transform hover:-translate-y-0.5 flex items-center justify-center gap-2"
              >
                {event.is_demo ? (
                  <span>Compra Bloqueada (Evento de Homologação)</span>
                ) : processing ? (
                  <span>Processando com Mercado Pago...</span>
                ) : (
                  <>
                    <span>Finalizar Compra — R$ {total.toFixed(2).replace('.', ',')}</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              <div className="flex items-center justify-center gap-2 text-[11px] text-zinc-400">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>🔒 Pagamento seguro com Mercado Pago</span>
              </div>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};
