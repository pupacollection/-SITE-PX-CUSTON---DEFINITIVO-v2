import React, { useState, useEffect, useCallback } from 'react';
import { EventItem } from '../../types';
import {
  getAdminEvents,
  createAdminEvent,
  updateAdminEvent,
  toggleEventStatus,
  generateEventSlug,
  formatDisplayDate,
  CreateEventInput,
} from '../../services/eventsService';
import { supabase } from '../../lib/supabase';
import {
  Calendar,
  Search,
  Plus,
  Edit3,
  Eye,
  EyeOff,
  CheckCircle2,
  Clock,
  AlertCircle,
  X,
  RefreshCw,
  MapPin,
  Tag,
  DollarSign,
  Image,
  ShieldCheck,
  FileText,
  AlertTriangle,
} from 'lucide-react';

interface AdminEventsManagerProps {
  onEventChange?: () => void;
}

export const AdminEventsManager: React.FC<AdminEventsManagerProps> = ({ onEventChange }) => {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Filtros e busca
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft' | 'finished'>('all');

  // Modal de Criação / Edição
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<EventItem | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Campos do formulário
  const [formTitle, setFormTitle] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formSubtitle, setFormSubtitle] = useState('');
  const [formDate, setFormDate] = useState('');
  const [formFormattedDate, setFormFormattedDate] = useState('');
  const [formLocation, setFormLocation] = useState('');
  const [formCity, setFormCity] = useState('Manhuaçu');
  const [formState, setFormState] = useState('MG');
  const [formMinPrice, setFormMinPrice] = useState('40.00');
  const [formCoverImage, setFormCoverImage] = useState(
    'https://images.unsplash.com/photo-1617788138017-80ad40651399?auto=format&fit=crop&w=1200&q=80'
  );
  const [formDescription, setFormDescription] = useState('');
  const [formClassification, setFormClassification] = useState('Classificação 16 anos');
  const [formTags, setFormTags] = useState('Carros Rebaixados, Som Automotivo, PX CUSTON');
  const [formRules, setFormRules] = useState('Classificação 16 anos\nProibida entrada de bebidas\nEstacionamento no local');
  const [formStatus, setFormStatus] = useState<'draft' | 'published'>('published');

  // Modal de Confirmação para Publicação/Despublicação
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    event: EventItem | null;
    targetStatus: 'published' | 'draft';
  }>({
    open: false,
    event: null,
    targetStatus: 'published',
  });
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);

  // Carregar eventos reais do Supabase
  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminEvents();
    if (result.error) {
      setError(result.error);
    } else {
      setEvents(result.data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Limpar aviso após 5 segundos
  useEffect(() => {
    if (actionNotice) {
      const timer = setTimeout(() => setActionNotice(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [actionNotice]);

  // Abertura do formulário para novo evento
  const handleOpenCreateModal = () => {
    setEditingEvent(null);
    setFormTitle('');
    setFormSlug('');
    setFormSubtitle('');
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 30);
    defaultDate.setHours(14, 0, 0, 0);
    const isoDateStr = defaultDate.toISOString().slice(0, 16);
    setFormDate(isoDateStr);
    setFormFormattedDate(formatDisplayDate(isoDateStr));
    setFormLocation('Parque de Exposições');
    setFormCity('Manhuaçu');
    setFormState('MG');
    setFormMinPrice('40.00');
    setFormCoverImage('https://images.unsplash.com/photo-1617788138017-80ad40651399?auto=format&fit=crop&w=1200&q=80');
    setFormDescription('Evento oficial promovido pela PX CUSTON reunindo os melhores projetos automotivos, estrutura de som e praça de alimentação.');
    setFormClassification('Classificação 16 anos');
    setFormTags('Carros Rebaixados, Som Automotivo, PX CUSTON');
    setFormRules('Classificação 16 anos\nProibida entrada de bebidas externas\nDocumento oficial com foto obrigatório na portaria');
    setFormStatus('published');
    setFormError(null);
    setModalOpen(true);
  };

  // Abertura do formulário para edição de evento existente
  const handleOpenEditModal = (evt: EventItem) => {
    setEditingEvent(evt);
    setFormTitle(evt.title);
    setFormSlug(evt.slug);
    setFormSubtitle(evt.subtitle || '');
    // Converter data para formato aceito pelo input datetime-local (YYYY-MM-DDTHH:mm)
    try {
      const d = new Date(evt.date);
      setFormDate(d.toISOString().slice(0, 16));
    } catch {
      setFormDate(evt.date);
    }
    setFormFormattedDate(evt.formatted_date || formatDisplayDate(evt.date));
    setFormLocation(evt.location);
    setFormCity(evt.city);
    setFormState(evt.state);
    setFormMinPrice(String(evt.min_price));
    setFormCoverImage(evt.cover_image);
    setFormDescription(evt.description);
    setFormClassification(evt.classification || 'Classificação 16 anos');
    setFormTags((evt.tags || []).join(', '));
    setFormRules((evt.rules || []).join('\n'));
    setFormStatus(evt.status === 'draft' ? 'draft' : 'published');
    setFormError(null);
    setModalOpen(true);
  };

  // Atualização dinâmica de slug conforme título é digitado
  const handleTitleChange = (val: string) => {
    setFormTitle(val);
    if (!editingEvent) {
      setFormSlug(generateEventSlug(val));
    }
  };

  // Atualização dinâmica de data formatada quando data é alterada
  const handleDateChange = (val: string) => {
    setFormDate(val);
    if (val) {
      setFormFormattedDate(formatDisplayDate(val));
    }
  };

  // Submissão do formulário (Criar ou Atualizar)
  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormSubmitting(true);
    setFormError(null);

    const tagsArray = formTags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const rulesArray = formRules
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);

    const minPriceNum = parseFloat(formMinPrice) || 0;

    if (editingEvent) {
      // Atualizar evento existente
      const result = await updateAdminEvent(editingEvent.id, {
        title: formTitle,
        slug: formSlug,
        subtitle: formSubtitle || undefined,
        date: formDate,
        formatted_date: formFormattedDate,
        location: formLocation,
        city: formCity,
        state: formState,
        min_price: minPriceNum,
        cover_image: formCoverImage,
        description: formDescription,
        classification: formClassification,
        tags: tagsArray,
        rules: rulesArray,
        status: formStatus,
      });

      if (result.error) {
        setFormError(result.error);
        setFormSubmitting(false);
        return;
      }

      setActionNotice({
        type: 'success',
        message: `Evento "${result.data?.title}" atualizado com sucesso no Supabase.`,
      });
    } else {
      // Criar novo evento
      const { data: authData } = await supabase.auth.getUser();
      const currentUserId = authData?.user?.id;

      const input: CreateEventInput = {
        title: formTitle,
        slug: formSlug,
        subtitle: formSubtitle || undefined,
        date: formDate,
        formatted_date: formFormattedDate,
        location: formLocation,
        city: formCity,
        state: formState,
        min_price: minPriceNum,
        cover_image: formCoverImage,
        description: formDescription,
        classification: formClassification,
        tags: tagsArray,
        rules: rulesArray,
        status: formStatus,
      };

      const result = await createAdminEvent(input, currentUserId);

      if (result.error) {
        setFormError(result.error);
        setFormSubmitting(false);
        return;
      }

      setActionNotice({
        type: 'success',
        message: `Novo evento "${result.data?.title}" cadastrado com sucesso no Supabase!`,
      });
    }

    setFormSubmitting(false);
    setModalOpen(false);
    await loadEvents();
    if (onEventChange) onEventChange();
  };

  // Abrir diálogo de confirmação para publicar ou despublicar
  const handlePromptToggleStatus = (evt: EventItem) => {
    const targetStatus = evt.status === 'published' ? 'draft' : 'published';
    setConfirmDialog({
      open: true,
      event: evt,
      targetStatus,
    });
  };

  // Executar alteração de status confirmada
  const handleExecuteToggleStatus = async () => {
    if (!confirmDialog.event) return;
    setConfirmSubmitting(true);

    const { event, targetStatus } = confirmDialog;
    const result = await toggleEventStatus(event.id, targetStatus);

    setConfirmSubmitting(false);
    setConfirmDialog({ open: false, event: null, targetStatus: 'published' });

    if (result.error) {
      setActionNotice({
        type: 'error',
        message: `Falha ao alterar status do evento: ${result.error}`,
      });
    } else {
      const statusLabel = targetStatus === 'published' ? 'publicado no site oficial' : 'movido para rascunho';
      setActionNotice({
        type: 'success',
        message: `Evento "${event.title}" foi ${statusLabel} com sucesso.`,
      });
      await loadEvents();
      if (onEventChange) onEventChange();
    }
  };

  // Filtro de pesquisa e status
  const filteredEvents = events.filter((evt) => {
    const matchesSearch =
      evt.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      evt.location.toLowerCase().includes(searchTerm.toLowerCase()) ||
      evt.city.toLowerCase().includes(searchTerm.toLowerCase()) ||
      evt.slug.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      statusFilter === 'all' || evt.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  // Métricas de contagem rápida
  const countPublished = events.filter((e) => e.status === 'published').length;
  const countDrafts = events.filter((e) => e.status === 'draft').length;
  const countFinished = events.filter((e) => e.status === 'finished').length;

  return (
    <div className="space-y-6">
      {/* Header com Título e Ação Principal */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1c1c1c] pb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black uppercase tracking-tight text-white font-heading">
              Gestão Real de Eventos
            </h1>
            <span className="text-[10px] bg-[#FF1A2D]/20 text-[#FF1A2D] font-mono font-bold px-2 py-0.5 rounded border border-[#FF1A2D]/30">
              SUPABASE DB
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Crie, publique, edite e gerencie o cronograma oficial de eventos automotivos PX CUSTON
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadEvents}
            disabled={loading}
            className="p-2.5 rounded-xl bg-[#141414] hover:bg-[#1f1f1f] border border-[#2a2a2a] text-zinc-400 hover:text-white transition"
            title="Recarregar do Supabase"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#FF1A2D]' : ''}`} />
          </button>
          <button
            type="button"
            onClick={handleOpenCreateModal}
            className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-4 py-2.5 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>Novo Evento</span>
          </button>
        </div>
      </div>

      {/* Banner de Feedback de Ações */}
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
            <span>{actionNotice.message}</span>
          </div>
          <button
            onClick={() => setActionNotice(null)}
            className="text-zinc-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Cards de Métricas de Eventos */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
          <span className="text-[11px] text-zinc-400 block mb-1">Total de Eventos</span>
          <span className="text-2xl font-black font-mono text-white">{events.length}</span>
        </div>
        <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
          <span className="text-[11px] text-emerald-400 block mb-1 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Publicados
          </span>
          <span className="text-2xl font-black font-mono text-emerald-400">{countPublished}</span>
        </div>
        <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
          <span className="text-[11px] text-amber-400 block mb-1 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Rascunhos
          </span>
          <span className="text-2xl font-black font-mono text-amber-400">{countDrafts}</span>
        </div>
        <div className="bg-[#121212] border border-[#222] p-4 rounded-2xl">
          <span className="text-[11px] text-zinc-400 block mb-1">Finalizados</span>
          <span className="text-2xl font-black font-mono text-zinc-300">{countFinished}</span>
        </div>
      </div>

      {/* Barra de Busca e Filtros */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#111] border border-[#222] p-3 rounded-2xl">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Buscar por título, local, cidade..."
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
            Todos ({events.length})
          </button>
          <button
            onClick={() => setStatusFilter('published')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'published'
                ? 'bg-emerald-600 text-white'
                : 'text-zinc-400 hover:text-white hover:bg-[#1a1a1a]'
            }`}
          >
            Publicados ({countPublished})
          </button>
          <button
            onClick={() => setStatusFilter('draft')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'draft'
                ? 'bg-amber-600 text-white'
                : 'text-zinc-400 hover:text-white hover:bg-[#1a1a1a]'
            }`}
          >
            Rascunhos ({countDrafts})
          </button>
          <button
            onClick={() => setStatusFilter('finished')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'finished'
                ? 'bg-zinc-700 text-white'
                : 'text-zinc-400 hover:text-white hover:bg-[#1a1a1a]'
            }`}
          >
            Finalizados ({countFinished})
          </button>
        </div>
      </div>

      {/* Estados de Carregamento, Erro e Listagem */}
      {loading ? (
        <div className="py-20 text-center text-zinc-400 text-xs bg-[#111] border border-[#222] rounded-3xl">
          <Clock className="w-8 h-8 animate-spin mx-auto mb-3 text-[#FF1A2D]" />
          <p className="font-semibold text-zinc-200">Sincronizando eventos com o banco Supabase...</p>
          <p className="text-zinc-500 text-[11px] mt-1">Consultando tabela oficial public.events</p>
        </div>
      ) : error ? (
        <div className="py-12 px-6 text-center bg-red-950/20 border border-red-500/30 rounded-3xl space-y-3">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto" />
          <h3 className="text-sm font-bold text-white">Falha ao consultar eventos oficiais</h3>
          <p className="text-xs text-red-300 max-w-md mx-auto">{error}</p>
          <button
            onClick={loadEvents}
            className="inline-flex items-center gap-2 bg-[#1c1c1c] hover:bg-[#252525] border border-[#333] text-white text-xs font-bold px-4 py-2 rounded-xl transition"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[#FF1A2D]" />
            <span>Tentar Novamente</span>
          </button>
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="py-16 text-center bg-[#111] border border-[#222] rounded-3xl p-8 space-y-3">
          <Calendar className="w-10 h-10 text-zinc-600 mx-auto" />
          <h3 className="text-sm font-bold text-white">Nenhum evento encontrado</h3>
          <p className="text-xs text-zinc-400 max-w-md mx-auto">
            {searchTerm || statusFilter !== 'all'
              ? 'Nenhum evento corresponde aos filtros aplicados.'
              : 'Nenhum evento cadastrado ainda no banco de dados Supabase.'}
          </p>
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
              className="mt-2 bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-4 py-2.5 rounded-xl transition"
            >
              Cadastrar Primeiro Evento
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredEvents.map((evt) => (
            <div
              key={evt.id}
              className="bg-[#121212] border border-[#222] hover:border-[#333] rounded-2xl overflow-hidden flex flex-col justify-between transition shadow-lg group"
            >
              {/* Imagem de Capa com Badges */}
              <div className="relative h-44 bg-[#1a1a1a] overflow-hidden">
                <img
                  src={evt.cover_image}
                  alt={evt.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition duration-500"
                  onError={(e) => {
                    // Fallback visual caso a imagem falhe
                    (e.target as HTMLElement).style.display = 'none';
                  }}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#121212] via-transparent to-black/60" />

                {/* Status Badge */}
                <div className="absolute top-3 left-3 flex items-center gap-1.5">
                  {evt.status === 'published' ? (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-500/40 backdrop-blur-sm">
                      <CheckCircle2 className="w-3 h-3" /> Publicado
                    </span>
                  ) : evt.status === 'draft' ? (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-500/40 backdrop-blur-sm">
                      <Clock className="w-3 h-3" /> Rascunho
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-zinc-900/80 text-zinc-400 border border-zinc-700 backdrop-blur-sm">
                      Finalizado
                    </span>
                  )}
                  {evt.is_demo && (
                    <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-blue-950/80 text-blue-300 border border-blue-500/30">
                      Demo
                    </span>
                  )}
                </div>

                {/* Preço Mínimo */}
                <div className="absolute bottom-3 right-3 bg-black/80 backdrop-blur-md px-2.5 py-1 rounded-lg border border-white/10">
                  <span className="text-[10px] text-zinc-400 block leading-tight">A partir de</span>
                  <span className="text-xs font-bold text-white font-mono leading-tight">
                    R$ {evt.min_price.toFixed(2).replace('.', ',')}
                  </span>
                </div>
              </div>

              {/* Informações do Evento */}
              <div className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <h3 className="font-bold text-white text-base leading-snug line-clamp-1">{evt.title}</h3>
                  {evt.subtitle && (
                    <p className="text-xs text-zinc-400 line-clamp-1 leading-snug">{evt.subtitle}</p>
                  )}
                  <div className="pt-1 space-y-1 text-xs text-zinc-400">
                    <p className="flex items-center gap-1.5 text-zinc-300">
                      <Calendar className="w-3.5 h-3.5 text-[#FF1A2D] shrink-0" />
                      <span>{evt.formatted_date || formatDisplayDate(evt.date)}</span>
                    </p>
                    <p className="flex items-center gap-1.5 text-zinc-400 truncate">
                      <MapPin className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                      <span className="truncate">{evt.location} — {evt.city}/{evt.state}</span>
                    </p>
                  </div>
                </div>

                {/* Tags & Lotes */}
                <div className="pt-2 border-t border-[#1e1e1e] space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-zinc-500">
                    <span className="font-mono text-zinc-400">/{evt.slug}</span>
                    <span className="text-zinc-400">{evt.ticket_batches?.length || 0} lotes</span>
                  </div>

                  {/* Botões de Ação */}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleOpenEditModal(evt)}
                      className="bg-[#1c1c1c] hover:bg-[#252525] border border-[#2e2e2e] text-white text-xs font-semibold py-2 px-3 rounded-xl transition flex items-center justify-center gap-1.5"
                    >
                      <Edit3 className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Editar</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handlePromptToggleStatus(evt)}
                      className={`text-xs font-semibold py-2 px-3 rounded-xl border transition flex items-center justify-center gap-1.5 ${
                        evt.status === 'published'
                          ? 'bg-[#181818] border-amber-500/30 text-amber-300 hover:bg-amber-950/30'
                          : 'bg-[#181818] border-emerald-500/30 text-emerald-300 hover:bg-emerald-950/30'
                      }`}
                    >
                      {evt.status === 'published' ? (
                        <>
                          <EyeOff className="w-3.5 h-3.5" />
                          <span>Despublicar</span>
                        </>
                      ) : (
                        <>
                          <Eye className="w-3.5 h-3.5" />
                          <span>Publicar</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MODAL: CRIAR OU EDITAR EVENTO */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-[#121212] border border-[#2a2a2a] w-full max-w-2xl rounded-3xl p-6 sm:p-8 space-y-6 my-8 animate-fade-in shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#222] pb-4">
              <div>
                <h2 className="text-xl font-black uppercase text-white font-heading">
                  {editingEvent ? 'Editar Evento' : 'Novo Evento Oficial'}
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {editingEvent
                    ? `Alterando parâmetros do evento ID ${editingEvent.id}`
                    : 'Preencha os campos obrigatórios para registrar o evento no Supabase'}
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
              <div className="p-3.5 rounded-xl bg-red-950/50 border border-red-500/50 text-red-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSubmitForm} className="space-y-5 text-xs">
              {/* Bloco 1: Título e Slug */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Título do Evento *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: MEGA ENCONTRO PX CUSTON 2026"
                    value={formTitle}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Slug da URL *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="ex: mega-encontro-px-custon"
                    value={formSlug}
                    onChange={(e) => setFormSlug(generateEventSlug(e.target.value))}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Subtítulo (Opcional)
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: O maior encontro automotivo da região"
                    value={formSubtitle}
                    onChange={(e) => setFormSubtitle(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  />
                </div>
              </div>

              {/* Bloco 2: Datas e Local */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Data e Hora do Evento *
                  </label>
                  <input
                    type="datetime-local"
                    required
                    value={formDate}
                    onChange={(e) => handleDateChange(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Data de Exibição Formatada *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: 15 NOV 2026"
                    value={formFormattedDate}
                    onChange={(e) => setFormFormattedDate(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Local / Endereço *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Parque de Exposições"
                    value={formLocation}
                    onChange={(e) => setFormLocation(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Cidade *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Manhuaçu"
                    value={formCity}
                    onChange={(e) => setFormCity(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Estado (UF) *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={2}
                    placeholder="Ex: MG"
                    value={formState}
                    onChange={(e) => setFormState(e.target.value.toUpperCase())}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs uppercase"
                  />
                </div>
              </div>

              {/* Bloco 3: Preço, Capa e Classificação */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Preço Mínimo (R$) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={formMinPrice}
                    onChange={(e) => setFormMinPrice(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white font-mono text-xs"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Classificação Indicativa *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: Classificação 16 anos"
                    value={formClassification}
                    onChange={(e) => setFormClassification(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  />
                </div>

                <div className="sm:col-span-3">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    URL da Imagem de Capa *
                  </label>
                  <input
                    type="url"
                    required
                    placeholder="https://..."
                    value={formCoverImage}
                    onChange={(e) => setFormCoverImage(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white font-mono text-xs"
                  />
                </div>
              </div>

              {/* Bloco 4: Descrição, Tags e Regras */}
              <div>
                <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                  Descrição Completa do Evento *
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="Descreva as atrações, estandes, categorias e diferenciais do evento..."
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl p-3 text-white text-xs"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Tags (Separadas por vírgula)
                  </label>
                  <input
                    type="text"
                    placeholder="Carros Rebaixados, Som, Competição"
                    value={formTags}
                    onChange={(e) => setFormTags(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Status de Publicação *
                  </label>
                  <select
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value as 'draft' | 'published')}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl px-3.5 py-2.5 text-white text-xs"
                  >
                    <option value="published">Publicado (Visível no Catálogo)</option>
                    <option value="draft">Rascunho (Oculto dos Clientes)</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Regras do Evento (Uma por linha)
                  </label>
                  <textarea
                    rows={2}
                    placeholder="Regra 1&#10;Regra 2"
                    value={formRules}
                    onChange={(e) => setFormRules(e.target.value)}
                    className="w-full bg-[#181818] border border-[#2a2a2a] focus:border-[#FF1A2D] focus:outline-none rounded-xl p-3 text-white text-xs"
                  />
                </div>
              </div>

              {/* Botões do Formulário */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-[#222]">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={formSubmitting}
                  className="px-4 py-2.5 rounded-xl border border-[#333] text-zinc-300 hover:text-white hover:bg-[#1a1a1a] transition font-semibold"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={formSubmitting}
                  className="bg-[#FF1A2D] hover:bg-[#e00f21] text-white text-xs font-bold uppercase tracking-wider px-6 py-2.5 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition flex items-center gap-2 disabled:opacity-50"
                >
                  {formSubmitting ? (
                    <>
                      <Clock className="w-4 h-4 animate-spin" />
                      <span>Gravando no Supabase...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>{editingEvent ? 'Salvar Alterações' : 'Criar Evento Oficial'}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL DE CONFIRMAÇÃO: PUBLICAR / DESPUBLICAR */}
      {confirmDialog.open && confirmDialog.event && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121212] border border-[#2a2a2a] w-full max-w-md rounded-3xl p-6 space-y-4 animate-fade-in shadow-2xl">
            <div className="flex items-center gap-3">
              <div
                className={`p-3 rounded-2xl ${
                  confirmDialog.targetStatus === 'published'
                    ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-500/40'
                    : 'bg-amber-950/60 text-amber-400 border border-amber-500/40'
                }`}
              >
                {confirmDialog.targetStatus === 'published' ? (
                  <Eye className="w-6 h-6" />
                ) : (
                  <EyeOff className="w-6 h-6" />
                )}
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  {confirmDialog.targetStatus === 'published'
                    ? 'Publicar Evento Oficial?'
                    : 'Mover para Rascunho?'}
                </h3>
                <p className="text-xs text-zinc-400">
                  Evento: <span className="text-white font-semibold">{confirmDialog.event.title}</span>
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed bg-[#181818] p-3 rounded-xl border border-[#262626]">
              {confirmDialog.targetStatus === 'published'
                ? 'Ao publicar, este evento ficará imediatamente visível no catálogo oficial da PX CUSTON para visualização e compra de ingressos por clientes.'
                : 'Ao despublicar (mover para rascunho), o evento deixará de aparecer para visitantes e clientes no catálogo público, ficando restrito ao painel PX CONTROL.'}
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDialog({ open: false, event: null, targetStatus: 'published' })}
                disabled={confirmSubmitting}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleExecuteToggleStatus}
                disabled={confirmSubmitting}
                className={`px-4 py-2 rounded-xl text-xs font-bold uppercase transition flex items-center gap-2 ${
                  confirmDialog.targetStatus === 'published'
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                    : 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                }`}
              >
                {confirmSubmitting ? (
                  <>
                    <Clock className="w-3.5 h-3.5 animate-spin" />
                    <span>Atualizando...</span>
                  </>
                ) : (
                  <span>Confirmar</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
