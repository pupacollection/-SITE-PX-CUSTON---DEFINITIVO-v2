import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { EventItem, TicketBatch } from '../../types';
import { getAdminEvents } from '../../services/eventsService';
import {
  getEventBatches,
  createTicketBatch,
  updateTicketBatch,
  toggleBatchStatus,
  closeTicketBatch,
  deleteTicketBatch,
  validateBatchInput,
} from '../../services/batchesService';
import {
  Ticket,
  Plus,
  Edit3,
  Trash2,
  CheckCircle2,
  Clock,
  AlertCircle,
  X,
  RefreshCw,
  Calendar,
  DollarSign,
  Layers,
  Eye,
  EyeOff,
  AlertTriangle,
  Search,
  ChevronDown,
  BarChart3,
  Lock,
  Archive,
} from 'lucide-react';

interface AdminBatchesManagerProps {
  initialEventId?: string;
  onBatchesUpdated?: () => void;
}

export const AdminBatchesManager: React.FC<AdminBatchesManagerProps> = ({
  initialEventId,
  onBatchesUpdated,
}) => {
  // Lista de eventos disponíveis
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>(initialEventId || '');
  const [eventsLoading, setEventsLoading] = useState(true);

  // Lotes do evento selecionado
  const [batches, setBatches] = useState<TicketBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Filtros
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive' | 'soldout'>('all');

  // Modal de Criação / Edição
  const [modalOpen, setModalOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<TicketBatch | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Campos do formulário
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formPrice, setFormPrice] = useState('50.00');
  const [formTotalQuantity, setFormTotalQuantity] = useState('500');
  const [formAvailableQuantity, setFormAvailableQuantity] = useState('500');
  const [formIsActive, setFormIsActive] = useState(true);
  const [formStartDate, setFormStartDate] = useState('');
  const [formEndDate, setFormEndDate] = useState('');

  // Modais de Confirmação de Ações Críticas
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    batch: TicketBatch | null;
    action: 'toggle' | 'close' | 'delete';
    title: string;
    description: string;
    confirmLabel: string;
    isDangerous?: boolean;
  }>({
    open: false,
    batch: null,
    action: 'toggle',
    title: '',
    description: '',
    confirmLabel: '',
  });
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);

  // 1. Carregar lista de eventos oficiais do Supabase
  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    const result = await getAdminEvents();
    if (result.data && result.data.length > 0) {
      setEvents(result.data);
      // Selecionar o evento inicial ou o primeiro da lista
      if (!selectedEventId || !result.data.some((e) => e.id === selectedEventId)) {
        const defaultEvt = initialEventId && result.data.some((e) => e.id === initialEventId)
          ? initialEventId
          : result.data[0].id;
        setSelectedEventId(defaultEvt);
      }
    } else {
      setEvents([]);
    }
    setEventsLoading(false);
  }, [initialEventId, selectedEventId]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // 2. Carregar lotes sempre que o evento selecionado mudar
  const loadBatches = useCallback(async () => {
    if (!selectedEventId) {
      setBatches([]);
      return;
    }
    setBatchesLoading(true);
    setError(null);
    const result = await getEventBatches(selectedEventId);
    if (result.error) {
      setError(result.error);
      setBatches([]);
    } else {
      setBatches(result.data || []);
    }
    setBatchesLoading(false);
  }, [selectedEventId]);

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  // Auto-dismiss de avisos após 6 segundos
  useEffect(() => {
    if (actionNotice) {
      const timer = setTimeout(() => setActionNotice(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [actionNotice]);

  // Evento atualmente selecionado
  const selectedEvent = useMemo(() => {
    return events.find((e) => e.id === selectedEventId) || null;
  }, [events, selectedEventId]);

  // Métricas calculadas dos lotes do evento
  const metrics = useMemo(() => {
    const totalBatches = batches.length;
    const activeBatches = batches.filter((b) => b.is_active).length;
    const totalCapacity = batches.reduce((acc, b) => acc + (b.total_quantity || 0), 0);
    const availableCapacity = batches.reduce((acc, b) => acc + (b.available_quantity || 0), 0);
    const soldCount = Math.max(0, totalCapacity - availableCapacity);
    const soldPercent = totalCapacity > 0 ? ((soldCount / totalCapacity) * 100).toFixed(1) : '0';

    const prices = batches.map((b) => Number(b.price)).filter((p) => !isNaN(p));
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

    return {
      totalBatches,
      activeBatches,
      totalCapacity,
      availableCapacity,
      soldCount,
      soldPercent,
      minPrice,
      maxPrice,
    };
  }, [batches]);

  // Filtragem de lotes para visualização
  const filteredBatches = useMemo(() => {
    return batches.filter((batch) => {
      const matchesSearch =
        batch.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        batch.description.toLowerCase().includes(searchTerm.toLowerCase());

      let matchesStatus = true;
      if (statusFilter === 'active') {
        matchesStatus = batch.is_active && batch.available_quantity > 0;
      } else if (statusFilter === 'inactive') {
        matchesStatus = !batch.is_active;
      } else if (statusFilter === 'soldout') {
        matchesStatus = batch.available_quantity <= 0;
      }

      return matchesSearch && matchesStatus;
    });
  }, [batches, searchTerm, statusFilter]);

  // Abertura do modal para novo lote
  const handleOpenCreateModal = () => {
    if (!selectedEventId) return;
    setEditingBatch(null);
    setFormName('');
    setFormDescription('');
    setFormPrice('50.00');
    setFormTotalQuantity('300');
    setFormAvailableQuantity('300');
    setFormIsActive(true);
    setFormStartDate('');
    setFormEndDate('');
    setFormError(null);
    setModalOpen(true);
  };

  // Abertura do modal para edição de lote existente
  const handleOpenEditModal = (batch: TicketBatch) => {
    setEditingBatch(batch);
    setFormName(batch.name);
    setFormDescription(batch.description || '');
    setFormPrice(Number(batch.price).toFixed(2));
    setFormTotalQuantity(String(batch.total_quantity));
    setFormAvailableQuantity(String(batch.available_quantity));
    setFormIsActive(batch.is_active);

    // Formatar datas para datetime-local (YYYY-MM-DDTHH:mm)
    if (batch.start_date) {
      try {
        setFormStartDate(new Date(batch.start_date).toISOString().slice(0, 16));
      } catch {
        setFormStartDate('');
      }
    } else {
      setFormStartDate('');
    }

    if (batch.end_date) {
      try {
        setFormEndDate(new Date(batch.end_date).toISOString().slice(0, 16));
      } catch {
        setFormEndDate('');
      }
    } else {
      setFormEndDate('');
    }

    setFormError(null);
    setModalOpen(true);
  };

  // Submissão do formulário (Criação / Atualização)
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEventId) return;

    setFormError(null);
    const priceNum = parseFloat(formPrice.replace(',', '.'));
    const totalQty = parseInt(formTotalQuantity, 10);
    const availQty = parseInt(formAvailableQuantity, 10);

    const inputData = {
      event_id: selectedEventId,
      name: formName.trim(),
      description: formDescription.trim(),
      price: priceNum,
      total_quantity: totalQty,
      available_quantity: availQty,
      is_active: formIsActive,
      start_date: formStartDate ? new Date(formStartDate).toISOString() : null,
      end_date: formEndDate ? new Date(formEndDate).toISOString() : null,
    };

    const validation = validateBatchInput(inputData, Boolean(editingBatch));
    if (!validation.valid) {
      setFormError(validation.error);
      return;
    }

    setFormSubmitting(true);
    if (editingBatch) {
      const res = await updateTicketBatch(editingBatch.id, inputData);
      setFormSubmitting(false);
      if (res.error) {
        setFormError(res.error);
        return;
      }
      setActionNotice({
        type: 'success',
        message: `Lote "${formName}" atualizado com sucesso no Supabase.`,
      });
    } else {
      const res = await createTicketBatch(inputData);
      setFormSubmitting(false);
      if (res.error) {
        setFormError(res.error);
        return;
      }
      setActionNotice({
        type: 'success',
        message: `Lote "${formName}" criado com sucesso e associado ao evento.`,
      });
    }

    setModalOpen(false);
    await loadBatches();
    if (onBatchesUpdated) onBatchesUpdated();
  };

  // Abrir confirmação de ação
  const promptAction = (batch: TicketBatch, action: 'toggle' | 'close' | 'delete') => {
    if (action === 'toggle') {
      const willActivate = !batch.is_active;
      setConfirmDialog({
        open: true,
        batch,
        action,
        title: willActivate ? 'Ativar Lote de Ingressos' : 'Desativar Lote de Ingressos',
        description: willActivate
          ? `Deseja ativar as vendas do lote "${batch.name}"? Usuários autenticados poderão comprar ingressos deste lote.`
          : `Deseja suspender temporariamente as vendas do lote "${batch.name}"? Nenhuma nova compra será autorizada enquanto o lote estiver desativado.`,
        confirmLabel: willActivate ? 'Sim, Ativar Vendas' : 'Sim, Desativar Lote',
        isDangerous: !willActivate,
      });
    } else if (action === 'close') {
      setConfirmDialog({
        open: true,
        batch,
        action,
        title: 'Encerrar Vendas Definitivamente',
        description: `Deseja encerrar o lote "${batch.name}"? Esta ação desativará o lote e definirá a disponibilidade restante como 0. Ingressos já emitidos continuam válidos para o check-in na portaria.`,
        confirmLabel: 'Encerrar Lote',
        isDangerous: true,
      });
    } else if (action === 'delete') {
      setConfirmDialog({
        open: true,
        batch,
        action,
        title: 'Excluir Lote de Ingressos',
        description: `Tem certeza que deseja remover o lote "${batch.name}"? Caso existam ingressos vendidos ou pedidos vinculados, o banco de dados recusará a exclusão para preservar a auditoria contábil.`,
        confirmLabel: 'Excluir Lote',
        isDangerous: true,
      });
    }
  };

  // Executar a ação confirmada
  const executeConfirmedAction = async () => {
    const { batch, action } = confirmDialog;
    if (!batch) return;

    setConfirmSubmitting(true);
    let resultError: string | null = null;

    if (action === 'toggle') {
      const res = await toggleBatchStatus(batch.id, !batch.is_active);
      resultError = res.error;
      if (!resultError) {
        setActionNotice({
          type: 'success',
          message: `Lote "${batch.name}" ${!batch.is_active ? 'ativado' : 'desativado'} com sucesso.`,
        });
      }
    } else if (action === 'close') {
      const res = await closeTicketBatch(batch.id);
      resultError = res.error;
      if (!resultError) {
        setActionNotice({
          type: 'success',
          message: `Lote "${batch.name}" foi encerrado com sucesso.`,
        });
      }
    } else if (action === 'delete') {
      const res = await deleteTicketBatch(batch.id);
      resultError = res.error;
      if (!resultError) {
        setActionNotice({
          type: 'success',
          message: `Lote "${batch.name}" excluído com sucesso do Supabase.`,
        });
      }
    }

    setConfirmSubmitting(false);
    setConfirmDialog((prev) => ({ ...prev, open: false, batch: null }));

    if (resultError) {
      setActionNotice({
        type: 'error',
        message: resultError,
      });
    } else {
      await loadBatches();
      if (onBatchesUpdated) onBatchesUpdated();
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. HEADER COM CONTROLES PRINCIPAIS */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1c1c1c] pb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black uppercase tracking-tight text-white font-heading flex items-center gap-2.5">
              <Ticket className="w-6 h-6 text-[#FF1A2D]" />
              <span>Gestão de Lotes & Ingressos</span>
            </h1>
            <span className="text-[10px] bg-[#FF1A2D]/20 text-[#FF1A2D] font-mono font-bold px-2 py-0.5 rounded border border-[#FF1A2D]/30">
              SUPABASE DB
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Controle de precificação oficial, inventário de ingressos, disponibilidade e períodos de venda
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadBatches}
            disabled={batchesLoading || !selectedEventId}
            className="p-2.5 rounded-xl bg-[#141414] hover:bg-[#1f1f1f] border border-[#2a2a2a] text-zinc-400 hover:text-white transition"
            title="Recarregar do Supabase"
          >
            <RefreshCw className={`w-4 h-4 ${batchesLoading ? 'animate-spin text-[#FF1A2D]' : ''}`} />
          </button>

          <button
            type="button"
            onClick={handleOpenCreateModal}
            disabled={!selectedEventId}
            className="bg-[#FF1A2D] hover:bg-[#e00f21] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold uppercase tracking-wider px-4 py-2.5 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>Novo Lote</span>
          </button>
        </div>
      </div>

      {/* BANNER DE FEEDBACK */}
      {actionNotice && (
        <div
          className={`p-4 rounded-2xl border text-xs flex items-center justify-between gap-3 animate-fade-in ${
            actionNotice.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
              : 'bg-red-950/40 border-red-500/40 text-red-200'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {actionNotice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            )}
            <span className="leading-relaxed">{actionNotice.message}</span>
          </div>
          <button
            onClick={() => setActionNotice(null)}
            className="text-zinc-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 2. SELETOR DE EVENTO OFICIAL */}
      <div className="bg-[#121212] border border-[#222] p-4 sm:p-5 rounded-2xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[#FF1A2D]" />
              <span>Selecione o Evento para Gerenciar Lotes:</span>
            </label>
            <span className="text-[11px] text-zinc-500">
              Cada lote pertence exclusivamente a um evento e segue as regras de integridade do pedido
            </span>
          </div>

          <div className="relative w-full sm:w-96">
            <select
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.target.value)}
              disabled={eventsLoading || events.length === 0}
              aria-label="Selecionar Evento para Lotes"
              className="w-full bg-[#181818] border border-[#2e2e2e] focus:border-[#FF1A2D] text-white text-xs font-semibold py-2.5 px-3.5 rounded-xl appearance-none pr-10 transition focus:outline-none cursor-pointer"
            >
              {eventsLoading ? (
                <option value="">Carregando eventos...</option>
              ) : events.length === 0 ? (
                <option value="">Nenhum evento cadastrado no sistema</option>
              ) : (
                events.map((evt) => (
                  <option key={evt.id} value={evt.id}>
                    {evt.title} ({evt.status === 'published' ? 'Publicado' : evt.status === 'draft' ? 'Rascunho' : 'Finalizado'})
                  </option>
                ))
              )}
            </select>
            <ChevronDown className="w-4 h-4 text-zinc-400 absolute right-3 top-3 pointer-events-none" />
          </div>
        </div>

        {/* Resumo do Evento Ativo */}
        {selectedEvent && (
          <div className="pt-3 border-t border-[#1c1c1c] flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
            <div className="flex items-center gap-3">
              <span className="font-semibold text-white">{selectedEvent.title}</span>
              <span className="font-mono text-zinc-500">/{selectedEvent.slug}</span>
              {selectedEvent.is_demo && (
                <span className="text-[10px] bg-blue-950/80 text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded font-bold uppercase">
                  Modo Demonstração
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-[11px]">
              <span>📍 {selectedEvent.location} — {selectedEvent.city}/{selectedEvent.state}</span>
              <span>📅 {selectedEvent.formatted_date}</span>
            </div>
          </div>
        )}
      </div>

      {/* 3. CARDS DE MÉTRICAS DO EVENTO SELECIONADO */}
      {selectedEvent && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
            <span className="text-[11px] text-zinc-400 block mb-1">Lotes Cadastrados</span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black font-mono text-white">{metrics.totalBatches}</span>
              <span className="text-xs text-emerald-400 font-medium">({metrics.activeBatches} ativos)</span>
            </div>
          </div>

          <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
            <span className="text-[11px] text-zinc-400 block mb-1">Capacidade Total</span>
            <span className="text-2xl font-black font-mono text-white">
              {metrics.totalCapacity.toLocaleString('pt-BR')}
            </span>
          </div>

          <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
            <span className="text-[11px] text-emerald-400 block mb-1 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Ingressos Disponíveis
            </span>
            <span className="text-2xl font-black font-mono text-emerald-400">
              {metrics.availableCapacity.toLocaleString('pt-BR')}
            </span>
          </div>

          <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
            <span className="text-[11px] text-zinc-400 block mb-1">Faixa de Preço</span>
            <span className="text-lg font-black font-mono text-zinc-200">
              {metrics.totalBatches > 0
                ? `R$ ${metrics.minPrice.toFixed(2).replace('.', ',')} a ${metrics.maxPrice.toFixed(2).replace('.', ',')}`
                : 'R$ 0,00'}
            </span>
          </div>
        </div>
      )}

      {/* 4. BARRA DE BUSCA E FILTROS DE STATUS */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#111] border border-[#222] p-3 rounded-2xl">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Buscar por nome do lote..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-500 transition"
          />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'all'
                ? 'bg-[#FF1A2D] text-white'
                : 'text-zinc-400 hover:text-white hover:bg-[#1a1a1a]'
            }`}
          >
            Todos ({batches.length})
          </button>
          <button
            onClick={() => setStatusFilter('active')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'active'
                ? 'bg-emerald-600 text-white'
                : 'text-zinc-400 hover:text-white hover:bg-[#1a1a1a]'
            }`}
          >
            Ativos ({batches.filter((b) => b.is_active && b.available_quantity > 0).length})
          </button>
          <button
            onClick={() => setStatusFilter('inactive')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'inactive'
                ? 'bg-amber-600 text-white'
                : 'text-zinc-400 hover:text-white hover:bg-[#1a1a1a]'
            }`}
          >
            Inativos ({batches.filter((b) => !b.is_active).length})
          </button>
          <button
            onClick={() => setStatusFilter('soldout')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'soldout'
                ? 'bg-red-600 text-white'
                : 'text-zinc-400 hover:text-white hover:bg-[#1a1a1a]'
            }`}
          >
            Esgotados ({batches.filter((b) => b.available_quantity <= 0).length})
          </button>
        </div>
      </div>

      {/* 5. LISTAGEM REAL DE LOTES */}
      {batchesLoading ? (
        <div className="p-12 text-center bg-[#121212] border border-[#222] rounded-3xl space-y-3">
          <RefreshCw className="w-8 h-8 text-[#FF1A2D] animate-spin mx-auto" />
          <p className="text-xs text-zinc-400">Consultando lotes oficiais no Supabase...</p>
        </div>
      ) : error ? (
        <div className="p-8 text-center bg-red-950/20 border border-red-500/30 rounded-3xl space-y-3">
          <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
          <h3 className="text-sm font-bold text-white">Falha ao Carregar Lotes</h3>
          <p className="text-xs text-red-300 max-w-md mx-auto">{error}</p>
          <button
            onClick={loadBatches}
            className="mt-2 bg-[#181818] hover:bg-[#222] border border-[#333] text-white text-xs font-semibold px-4 py-2 rounded-xl transition"
          >
            Tentar Novamente
          </button>
        </div>
      ) : filteredBatches.length === 0 ? (
        <div className="p-12 text-center bg-[#121212] border border-[#222] rounded-3xl space-y-4">
          <div className="w-14 h-14 bg-[#181818] rounded-2xl flex items-center justify-center mx-auto text-zinc-500">
            <Ticket className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Nenhum lote encontrado</h3>
            <p className="text-xs text-zinc-400 mt-1 max-w-md mx-auto">
              {searchTerm || statusFilter !== 'all'
                ? 'Nenhum lote corresponde aos filtros informados.'
                : 'Este evento ainda não possui lotes de ingressos cadastrados no banco de dados.'}
            </p>
          </div>
          {searchTerm || statusFilter !== 'all' ? (
            <button
              onClick={() => {
                setSearchTerm('');
                setStatusFilter('all');
              }}
              className="text-xs text-[#FF1A2D] font-bold hover:underline"
            >
              Limpar filtros
            </button>
          ) : (
            <button
              onClick={handleOpenCreateModal}
              className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-5 py-2.5 rounded-xl transition shadow-[0_0_15px_rgba(255,26,45,0.4)]"
            >
              Criar 1º Lote de Ingressos
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredBatches.map((batch) => {
            const soldCount = Math.max(0, batch.total_quantity - batch.available_quantity);
            const soldRatio = batch.total_quantity > 0 ? (soldCount / batch.total_quantity) * 100 : 0;
            const isSoldOut = batch.available_quantity <= 0;

            // Verificação de período se configurado
            const now = new Date();
            const hasStart = Boolean(batch.start_date);
            const hasEnd = Boolean(batch.end_date);
            const isUpcoming = hasStart && new Date(batch.start_date!) > now;
            const isExpired = hasEnd && new Date(batch.end_date!) < now;

            return (
              <div
                key={batch.id}
                className={`bg-[#121212] border rounded-2xl overflow-hidden flex flex-col justify-between transition shadow-lg ${
                  !batch.is_active
                    ? 'border-[#222] opacity-75'
                    : isSoldOut
                    ? 'border-red-900/50'
                    : 'border-[#282828] hover:border-[#383838]'
                }`}
              >
                {/* Header do Card */}
                <div className="p-5 space-y-3 flex-1 flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                          Lote de Ingressos
                        </span>
                        <h3 className="font-black text-white text-lg tracking-tight uppercase font-heading leading-tight">
                          {batch.name}
                        </h3>
                      </div>

                      {/* Status Badges */}
                      <div className="flex flex-col items-end gap-1">
                        {isSoldOut ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-950/80 text-red-400 border border-red-500/40">
                            Esgotado
                          </span>
                        ) : !batch.is_active ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-700">
                            Inativo
                          </span>
                        ) : isUpcoming ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-500/40">
                            Início em Breve
                          </span>
                        ) : isExpired ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-700">
                            Período Encerrado
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-500/40 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Vendas Ativas
                          </span>
                        )}
                      </div>
                    </div>

                    {batch.description && (
                      <p className="text-xs text-zinc-400 mt-2 line-clamp-2 leading-relaxed">
                        {batch.description}
                      </p>
                    )}
                  </div>

                  {/* Preço Unitário Oficial */}
                  <div className="pt-3 border-t border-[#1a1a1a] flex items-baseline justify-between">
                    <div>
                      <span className="text-[10px] text-zinc-500 block uppercase font-mono">Valor Unitário</span>
                      <span className="text-2xl font-black text-[#FF1A2D] font-mono">
                        R$ {Number(batch.price).toFixed(2).replace('.', ',')}
                      </span>
                    </div>

                    <div className="text-right">
                      <span className="text-[10px] text-zinc-500 block uppercase font-mono">Disponíveis</span>
                      <span className="text-sm font-bold font-mono text-white">
                        {batch.available_quantity} / {batch.total_quantity}
                      </span>
                    </div>
                  </div>

                  {/* Barra de Progresso de Vendas */}
                  <div className="space-y-1">
                    <div className="w-full bg-[#1e1e1e] h-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${
                          isSoldOut
                            ? 'bg-red-500'
                            : soldRatio > 80
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, soldRatio))}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                      <span>{soldCount} vendidos ({soldRatio.toFixed(0)}%)</span>
                      <span>{batch.available_quantity} restantes</span>
                    </div>
                  </div>

                  {/* Datas do Período de Vendas */}
                  {(batch.start_date || batch.end_date) && (
                    <div className="bg-[#161616] border border-[#222] p-2.5 rounded-xl space-y-1 text-[11px] text-zinc-400">
                      {batch.start_date && (
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-500 flex items-center gap-1">
                            <Clock className="w-3 h-3" /> Início:
                          </span>
                          <span className="font-mono text-zinc-300">
                            {new Date(batch.start_date).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        </div>
                      )}
                      {batch.end_date && (
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-500 flex items-center gap-1">
                            <Clock className="w-3 h-3" /> Término:
                          </span>
                          <span className="font-mono text-zinc-300">
                            {new Date(batch.end_date).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* AÇÕES ADMINISTRATIVAS */}
                <div className="bg-[#161616] border-t border-[#1e1e1e] p-3 grid grid-cols-3 gap-2">
                  {/* Ativar / Desativar */}
                  <button
                    type="button"
                    onClick={() => promptAction(batch, 'toggle')}
                    className={`text-[11px] font-semibold py-2 px-2.5 rounded-xl border transition flex items-center justify-center gap-1 ${
                      batch.is_active
                        ? 'bg-[#181818] border-amber-500/30 text-amber-300 hover:bg-amber-950/30'
                        : 'bg-[#181818] border-emerald-500/30 text-emerald-300 hover:bg-emerald-950/30'
                    }`}
                    title={batch.is_active ? 'Pausar vendas' : 'Ativar vendas'}
                  >
                    {batch.is_active ? (
                      <>
                        <EyeOff className="w-3 h-3" />
                        <span>Pausar</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3 h-3" />
                        <span>Ativar</span>
                      </>
                    )}
                  </button>

                  {/* Editar */}
                  <button
                    type="button"
                    onClick={() => handleOpenEditModal(batch)}
                    className="bg-[#1c1c1c] hover:bg-[#252525] border border-[#2e2e2e] text-white text-[11px] font-semibold py-2 px-2.5 rounded-xl transition flex items-center justify-center gap-1"
                  >
                    <Edit3 className="w-3 h-3 text-zinc-400" />
                    <span>Editar</span>
                  </button>

                  {/* Encerrar ou Excluir */}
                  {batch.available_quantity > 0 && batch.is_active ? (
                    <button
                      type="button"
                      onClick={() => promptAction(batch, 'close')}
                      className="bg-[#1c1c1c] hover:bg-red-950/40 border border-[#2e2e2e] hover:border-red-500/30 text-zinc-300 hover:text-red-300 text-[11px] font-semibold py-2 px-2 rounded-xl transition flex items-center justify-center gap-1"
                      title="Encerrar lote imediatamente"
                    >
                      <Archive className="w-3 h-3" />
                      <span>Encerrar</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => promptAction(batch, 'delete')}
                      className="bg-[#1c1c1c] hover:bg-red-950/40 border border-[#2e2e2e] hover:border-red-500/30 text-zinc-400 hover:text-red-400 text-[11px] font-semibold py-2 px-2 rounded-xl transition flex items-center justify-center gap-1"
                      title="Excluir lote se não houver vendas"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Excluir</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 6. MODAL: CRIAR OU EDITAR LOTE DE INGRESSOS */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-[#121212] border border-[#2a2a2a] w-full max-w-xl rounded-3xl p-6 sm:p-8 space-y-6 my-8 animate-fade-in shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#222] pb-4">
              <div>
                <h2 className="text-xl font-black uppercase text-white font-heading flex items-center gap-2">
                  <Ticket className="w-5 h-5 text-[#FF1A2D]" />
                  <span>{editingBatch ? 'Editar Lote de Ingressos' : 'Criar Novo Lote'}</span>
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Evento: <span className="text-white font-bold">{selectedEvent?.title}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-zinc-400 hover:text-white p-2 rounded-xl hover:bg-[#1a1a1a]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {formError && (
              <div className="p-3 bg-red-950/40 border border-red-500/40 rounded-xl text-xs text-red-200 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleFormSubmit} className="space-y-4">
              {/* Nome do Lote */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                  Nome do Lote *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: 1º Lote — Pista, Camarote VIP, Lote Promocional"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full bg-[#181818] border border-[#2e2e2e] focus:border-[#FF1A2D] text-white text-xs py-2.5 px-3.5 rounded-xl focus:outline-none transition"
                />
              </div>

              {/* Descrição */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                  Descrição dos Benefícios
                </label>
                <textarea
                  rows={2}
                  placeholder="Ex: Acesso livre à área de exposição, som automotivo e praça de alimentação..."
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  className="w-full bg-[#181818] border border-[#2e2e2e] focus:border-[#FF1A2D] text-white text-xs py-2.5 px-3.5 rounded-xl focus:outline-none transition resize-none"
                />
              </div>

              {/* Preço Unitário & Quantidades */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                    Preço Unitário (R$) *
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-xs text-zinc-500 font-mono">R$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      placeholder="50.00"
                      value={formPrice}
                      onChange={(e) => setFormPrice(e.target.value)}
                      className="w-full bg-[#181818] border border-[#2e2e2e] focus:border-[#FF1A2D] text-white text-xs py-2.5 pl-9 pr-3 rounded-xl focus:outline-none transition font-mono"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                    Qtd. Total *
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    placeholder="500"
                    value={formTotalQuantity}
                    onChange={(e) => setFormTotalQuantity(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2e2e2e] focus:border-[#FF1A2D] text-white text-xs py-2.5 px-3.5 rounded-xl focus:outline-none transition font-mono"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                    Qtd. Disponível *
                  </label>
                  <input
                    type="number"
                    min="0"
                    required
                    placeholder="500"
                    value={formAvailableQuantity}
                    onChange={(e) => setFormAvailableQuantity(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2e2e2e] focus:border-[#FF1A2D] text-white text-xs py-2.5 px-3.5 rounded-xl focus:outline-none transition font-mono"
                  />
                </div>
              </div>

              {/* Período de Vendas (Início e Fim) */}
              <div className="bg-[#161616] border border-[#222] p-4 rounded-2xl space-y-3">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[#FF1A2D]" />
                  <span className="text-xs font-bold uppercase text-zinc-200">
                    Período de Venda do Lote (Opcional)
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400">
                  Configure o horário oficial de início e término das vendas para este lote.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400 block font-medium">Início das Vendas</label>
                    <input
                      type="datetime-local"
                      value={formStartDate}
                      onChange={(e) => setFormStartDate(e.target.value)}
                      className="w-full bg-[#1f1f1f] border border-[#2f2f2f] focus:border-[#FF1A2D] text-white text-xs py-2 px-3 rounded-xl focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-400 block font-medium">Encerramento das Vendas</label>
                    <input
                      type="datetime-local"
                      value={formEndDate}
                      onChange={(e) => setFormEndDate(e.target.value)}
                      className="w-full bg-[#1f1f1f] border border-[#2f2f2f] focus:border-[#FF1A2D] text-white text-xs py-2 px-3 rounded-xl focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Status Ativo */}
              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="formIsActive"
                  checked={formIsActive}
                  onChange={(e) => setFormIsActive(e.target.checked)}
                  className="w-4 h-4 rounded accent-[#FF1A2D] cursor-pointer"
                />
                <label htmlFor="formIsActive" className="text-xs text-zinc-300 font-medium cursor-pointer">
                  Lote ativo para compras imediatas no site
                </label>
              </div>

              {/* Botões do Rodapé */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-[#222]">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={formSubmitting}
                  className="px-4 py-2.5 rounded-xl text-xs font-bold text-zinc-400 hover:text-white transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={formSubmitting}
                  className="bg-[#FF1A2D] hover:bg-[#e00f21] disabled:opacity-50 text-white text-xs font-bold uppercase tracking-wider px-6 py-2.5 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition flex items-center gap-2"
                >
                  {formSubmitting && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{editingBatch ? 'Salvar Alterações' : 'Criar Lote'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 7. MODAL DE CONFIRMAÇÃO DE AÇÃO */}
      {confirmDialog.open && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121212] border border-[#2a2a2a] w-full max-w-md rounded-3xl p-6 space-y-5 animate-fade-in shadow-2xl">
            <div className="flex items-center gap-3">
              <div
                className={`p-3 rounded-2xl ${
                  confirmDialog.isDangerous
                    ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                }`}
              >
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-black uppercase text-white font-heading">
                  {confirmDialog.title}
                </h3>
                <span className="text-xs text-zinc-400 font-mono">
                  Lote: {confirmDialog.batch?.name}
                </span>
              </div>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              {confirmDialog.description}
            </p>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#222]">
              <button
                type="button"
                onClick={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
                disabled={confirmSubmitting}
                className="px-4 py-2.5 rounded-xl text-xs font-bold text-zinc-400 hover:text-white transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={executeConfirmedAction}
                disabled={confirmSubmitting}
                className={`text-xs font-bold uppercase tracking-wider px-5 py-2.5 rounded-xl transition flex items-center gap-2 ${
                  confirmDialog.isDangerous
                    ? 'bg-red-600 hover:bg-red-700 text-white shadow-[0_0_15px_rgba(220,38,38,0.4)]'
                    : 'bg-[#FF1A2D] hover:bg-[#e00f21] text-white shadow-[0_0_15px_rgba(255,26,45,0.4)]'
                }`}
              >
                {confirmSubmitting && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>{confirmDialog.confirmLabel}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
